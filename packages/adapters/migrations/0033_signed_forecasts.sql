-- P2: signed forecasts, window Merkle roots, automatic contamination and credit-weighted consensus.
-- An agent signs its own forecast (EIP-712, checked through the SignatureVerifier); the platform
-- admits, seals and scores it and stores the window root, but never signs or anchors. Historical
-- migrations stay intact. No production database exists, so retired objects are dropped, not archived.

-- ---- Submissions: signed, in basis points, identified by the forecaster's wallet --------------
-- The v0.1 columns stay (the rows are immutable), but a new row carries no evidence ids, rationale or
-- agent version, so they may be empty. The signed columns are required of every row written from now
-- on; NOT VALID leaves the unsigned historical rows alone.
ALTER TABLE forecasts.submissions
  ADD COLUMN forecaster_address blink.address,
  ADD COLUMN digest blink.hash,
  ADD COLUMN signature TEXT
    CHECK (signature ~ '^0x[0-9a-fA-F]+$' AND char_length(signature) % 2 = 0 AND char_length(signature) BETWEEN 4 AND 16386),
  ADD COLUMN content_hash blink.hash,
  -- The block the signature check ran at: a contract wallet's answer can change later.
  ADD COLUMN verified_block BIGINT CHECK (verified_block >= 0),
  ADD COLUMN probability_bps INTEGER CHECK (probability_bps BETWEEN 1 AND 9999);
ALTER TABLE forecasts.submissions
  ALTER COLUMN probability DROP NOT NULL,
  ALTER COLUMN evidence_ids DROP NOT NULL,
  ALTER COLUMN rationale DROP NOT NULL,
  ALTER COLUMN agent_version DROP NOT NULL;
ALTER TABLE forecasts.submissions ADD CONSTRAINT submissions_signed CHECK (
  forecaster_address IS NOT NULL AND digest IS NOT NULL AND signature IS NOT NULL
  AND content_hash IS NOT NULL AND verified_block IS NOT NULL AND probability_bps IS NOT NULL) NOT VALID;
-- One answer per forecaster per window, and one row per signed digest.
CREATE UNIQUE INDEX submissions_window_forecaster ON forecasts.submissions (window_id, forecaster_address);
CREATE UNIQUE INDEX submissions_digest ON forecasts.submissions (digest);

-- ---- Windows: the root of the window's leaves ---------------------------------------------------
-- root_at marks the window as closed; a window with no answers is closed with no root.
ALTER TABLE forecasts.windows
  ADD COLUMN merkle_root blink.hash,
  ADD COLUMN root_at TIMESTAMPTZ,
  ADD CONSTRAINT windows_root_closed CHECK (merkle_root IS NULL OR root_at IS NOT NULL);
-- A short alpha market needs a PRE_CLOSE window shorter than 30 minutes: the open time is a platform
-- scheduling setting now, not a protocol parameter.
ALTER TABLE forecasts.windows DROP CONSTRAINT windows_check;
ALTER TABLE forecasts.windows ADD CONSTRAINT windows_open_before_deadline
  CHECK (open_at < scheduled_at AND deadline = scheduled_at);
-- Windows stay immutable except for the one-time root, which only the worker may write.
DROP TRIGGER immutable ON forecasts.windows;
CREATE TRIGGER immutable BEFORE DELETE OR TRUNCATE ON forecasts.windows
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();
CREATE FUNCTION forecasts.guard_window_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.root_at IS NULL AND NEW.root_at IS NOT NULL
     AND (to_jsonb(NEW) - 'merkle_root' - 'root_at') = (to_jsonb(OLD) - 'merkle_root' - 'root_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'forecasts.windows is an append-only table: only its root may be set, once' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER guard_update BEFORE UPDATE ON forecasts.windows
  FOR EACH ROW EXECUTE FUNCTION forecasts.guard_window_update();
-- A trigger function runs without its caller holding EXECUTE, so nobody needs the PUBLIC default (see 0020).
REVOKE ALL ON FUNCTION forecasts.guard_window_update() FROM PUBLIC;

-- ---- Annotations: only the forecaster's own withdrawal remains --------------------------------
-- Contamination is computed from the indexed proposal, never annotated by hand.
ALTER TABLE forecasts.annotations ADD CONSTRAINT annotations_withdrawn_only CHECK (kind = 'WITHDRAWN') NOT VALID;

-- ---- Scores: AGENT and CONSENSUS, a new evaluation version, old rows untouched ---------------
ALTER TABLE analytics.score_entries ADD COLUMN forecaster blink.address;
ALTER TABLE analytics.score_entries
  DROP CONSTRAINT score_entries_scorer_check,
  DROP CONSTRAINT score_entries_window_id_scorer_agent_id_evaluation_version_key,
  DROP CONSTRAINT score_entries_check;
-- v1 rows keep their rule (one AGENT row per agent); every later version is keyed by wallet.
ALTER TABLE analytics.score_entries ADD CONSTRAINT score_entries_scorer_v2 CHECK (scorer IN ('AGENT','CONSENSUS')) NOT VALID;
ALTER TABLE analytics.score_entries ADD CONSTRAINT score_entries_forecaster_rule CHECK (
  CASE WHEN evaluation_version = 'v1' THEN (scorer = 'AGENT') = (agent_id IS NOT NULL) AND forecaster IS NULL
       ELSE (scorer = 'AGENT') = (forecaster IS NOT NULL) AND agent_id IS NULL END);
CREATE UNIQUE INDEX score_entries_v1_unique ON analytics.score_entries (window_id, scorer, agent_id) NULLS NOT DISTINCT
  WHERE evaluation_version = 'v1';
CREATE UNIQUE INDEX score_entries_v2_unique ON analytics.score_entries (window_id, scorer, forecaster, evaluation_version) NULLS NOT DISTINCT
  WHERE evaluation_version <> 'v1';
CREATE INDEX score_entries_forecaster ON analytics.score_entries (forecaster, mode) WHERE forecaster IS NOT NULL;

-- ---- What the worker may see ---------------------------------------------------------------------
-- The scoring view replaces analytics.final_forecasts: it lists answers only once their window closed
-- (they are public from then on) and no longer joins the market projection, because scoring takes the
-- market state and outcome from the ProtocolReader.
DROP VIEW analytics.final_forecasts;
CREATE VIEW analytics.closed_forecasts WITH (security_barrier = true) AS
SELECT w.id AS window_id, w.deployment_id, w.market_id::text AS market_id, w.deadline,
  s.id AS submission_id, '0x' || encode(s.forecaster_address, 'hex') AS forecaster, s.probability_bps,
  EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id = s.id AND a.kind = 'WITHDRAWN') AS withdrawn
FROM forecasts.windows w
JOIN forecasts.submissions s ON s.window_id = w.id AND s.forecaster_address IS NOT NULL
WHERE w.deadline <= blink.now();
REVOKE ALL ON analytics.closed_forecasts FROM PUBLIC;
GRANT SELECT ON analytics.closed_forecasts TO blink_worker;

-- The API admits answers and records withdrawals; the worker closes windows. The worker never reads a
-- digest or probability of an open window: with the zero content hash a digest reveals the probability
-- (there are only 9,999 candidates). It sees digests only through a view that lists a window's answers
-- once its deadline passed, like closed_forecasts. It also reads who answered (addresses only), which
-- the credit statistics it freezes at a deadline need.
CREATE VIEW forecasts.closed_digests WITH (security_barrier = true) AS
SELECT w.id AS window_id, s.id AS submission_id, '0x' || encode(s.digest, 'hex') AS digest,
  EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id = s.id AND a.kind = 'WITHDRAWN') AS withdrawn
FROM forecasts.windows w
JOIN forecasts.submissions s ON s.window_id = w.id AND s.digest IS NOT NULL
WHERE w.deadline <= blink.now();
REVOKE ALL ON forecasts.closed_digests FROM PUBLIC;
GRANT SELECT ON forecasts.closed_digests TO blink_worker;
GRANT INSERT ON forecasts.annotations TO blink_api;
GRANT UPDATE (merkle_root, root_at) ON forecasts.windows TO blink_worker;
GRANT SELECT (forecaster_address) ON forecasts.submissions TO blink_worker;

-- ---- Retire the manual annotation role and the evidence records that only it and the v0.1 flow used ----
REVOKE ALL ON forecasts.annotations FROM blink_forecast_admin;
REVOKE ALL ON operations.audit_log FROM blink_forecast_admin;
REVOKE ALL ON SCHEMA forecasts, blink, operations FROM blink_forecast_admin;
DROP ROLE blink_forecast_admin;

DROP TABLE evidence.records;
DROP TABLE evidence.sources;
DROP SCHEMA evidence;
