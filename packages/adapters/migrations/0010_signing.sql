-- Restricted signer: persisted sign requests, signed artifacts, nonce allocations, dispatcher
-- attempts and per-role gas budgets. Keys never live here; raw signed transactions do, and only
-- the signer writes them and only the signer and the dispatcher (blink_worker) can read them.
CREATE SCHEMA signing;

CREATE TABLE signing.economic_intents (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  kind TEXT NOT NULL CHECK (kind IN ('MAKER_QUOTE','APPROVE','FILL','REDEEM','MINT','FINALIZE_UNCHALLENGED','FINALIZE_TIMEOUT')),
  role TEXT NOT NULL CHECK (role IN ('maker','trader','keeper','faucet')),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  payload_hash blink.hash NOT NULL,
  state TEXT NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED','SIGNED','SUBMITTED','UNKNOWN','INCLUDED','FINALIZED','FAILED','CANCELLED')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  -- Each kind belongs to exactly one signing role.
  CHECK ((kind, role) IN (
    ('MAKER_QUOTE','maker'), ('APPROVE','trader'), ('FILL','trader'), ('REDEEM','trader'),
    ('MINT','faucet'), ('FINALIZE_UNCHALLENGED','keeper'), ('FINALIZE_TIMEOUT','keeper'))),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE signing.sign_requests (
  id UUID PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES signing.economic_intents(id),
  artifact_version INTEGER NOT NULL DEFAULT 1 CHECK (artifact_version > 0),
  role TEXT NOT NULL CHECK (role IN ('maker','trader','keeper','faucet')),
  request_hash blink.hash NOT NULL,
  unsigned_payload JSONB NOT NULL CHECK (jsonb_typeof(unsigned_payload) = 'object'),
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','SIGNED','REJECTED')),
  reject_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (role, intent_id, artifact_version),
  CHECK ((state = 'REJECTED') = (reject_code IS NOT NULL))
);
CREATE INDEX sign_requests_intent ON signing.sign_requests (intent_id);

-- One artifact per sign request (UNIQUE), never changed afterwards. A quote artifact carries a
-- signature; a transaction artifact carries the raw signed bytes and the gas it reserved.
CREATE TABLE signing.artifacts (
  id UUID PRIMARY KEY,
  sign_request_id UUID NOT NULL UNIQUE REFERENCES signing.sign_requests(id),
  artifact_hash blink.hash NOT NULL,
  signature TEXT,
  raw_transaction TEXT,
  max_cost_wei blink.uint256,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((signature IS NULL) <> (raw_transaction IS NULL)),
  CHECK ((raw_transaction IS NULL) = (max_cost_wei IS NULL))
);

CREATE TABLE signing.nonce_allocations (
  chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
  sender blink.address NOT NULL,
  nonce blink.uint256 NOT NULL,
  intent_id UUID NOT NULL UNIQUE REFERENCES signing.economic_intents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, sender, nonce)
);

-- Row lock that serializes nonce allocation per sender. updated_at exists so the signer can hold
-- UPDATE (required by SELECT ... FOR UPDATE) on a column that cannot change the key.
CREATE TABLE signing.sender_guards (
  chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
  sender blink.address NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, sender)
);

CREATE TABLE signing.tx_attempts (
  id UUID PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES signing.economic_intents(id),
  artifact_id UUID NOT NULL UNIQUE REFERENCES signing.artifacts(id),
  tx_hash blink.hash NOT NULL UNIQUE,
  nonce blink.uint256 NOT NULL,
  replacement_of UUID REFERENCES signing.tx_attempts(id),
  gas_limit blink.uint256 NOT NULL,
  max_fee_per_gas blink.uint256 NOT NULL,
  max_priority_fee_per_gas blink.uint256 NOT NULL,
  max_cost_wei blink.uint256 NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SIGNED','SUBMITTED','INCLUDED','FINALIZED','REVERTED','REPLACED','UNKNOWN','REORGED')),
  receipt_block_hash blink.hash,
  receipt_block_number blink.uint256,
  gas_spent_wei blink.uint256,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE INDEX tx_attempts_intent ON signing.tx_attempts (intent_id);

CREATE TABLE signing.gas_spend (
  role TEXT NOT NULL CHECK (role IN ('maker','trader','keeper','faucet')),
  day DATE NOT NULL,
  reserved_wei blink.uint256 NOT NULL DEFAULT 0,
  spent_wei blink.uint256 NOT NULL DEFAULT 0,
  PRIMARY KEY (role, day)
);

-- Append-only: signed bytes and allocations are never edited or removed.
CREATE TRIGGER artifacts_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON signing.artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();
CREATE TRIGGER nonce_allocations_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON signing.nonce_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();

-- blink_api may only ask for maker quotes. superusers are exempt only because pg_has_role treats
-- them as members of every role; runtime logins are never superusers (startup role assertions).
CREATE FUNCTION signing.restrict_api_intents() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'MAKER_QUOTE'
     AND pg_has_role(current_user, 'blink_api', 'member')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'blink_api may create MAKER_QUOTE intents only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_intents_api_scope BEFORE INSERT ON signing.economic_intents
  FOR EACH ROW EXECUTE FUNCTION signing.restrict_api_intents();

-- A request's role must be its intent's role, and blink_api may only request first-version quotes.
CREATE FUNCTION signing.restrict_sign_requests() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_kind TEXT; intent_role TEXT;
BEGIN
  SELECT kind, role INTO intent_kind, intent_role FROM signing.economic_intents WHERE id = NEW.intent_id;
  IF intent_role IS DISTINCT FROM NEW.role THEN
    RAISE EXCEPTION 'sign request role must match the intent role' USING ERRCODE = '42501';
  END IF;
  IF pg_has_role(current_user, 'blink_api', 'member')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND (intent_kind <> 'MAKER_QUOTE' OR NEW.artifact_version <> 1) THEN
    RAISE EXCEPTION 'blink_api may request first-version maker quotes only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sign_requests_scope BEFORE INSERT ON signing.sign_requests
  FOR EACH ROW EXECUTE FUNCTION signing.restrict_sign_requests();

REVOKE ALL ON SCHEMA signing FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA signing FROM PUBLIC;
GRANT USAGE ON SCHEMA signing TO blink_api, blink_worker, blink_signer;

-- The signer reloads the deployment it serves; it never writes markets.
GRANT USAGE ON SCHEMA markets TO blink_signer;
GRANT SELECT ON markets.deployments TO blink_signer;
GRANT SELECT ON signing.economic_intents, signing.sign_requests, signing.sender_guards,
  signing.nonce_allocations, signing.gas_spend, signing.artifacts TO blink_signer;
GRANT UPDATE (state, reject_code, updated_at) ON signing.sign_requests TO blink_signer;
GRANT UPDATE (state, updated_at, version) ON signing.economic_intents TO blink_signer;
GRANT UPDATE (updated_at) ON signing.sender_guards TO blink_signer;
GRANT INSERT ON signing.artifacts, signing.nonce_allocations, signing.sender_guards TO blink_signer;
GRANT INSERT, UPDATE ON signing.gas_spend TO blink_signer;

-- The API requests maker quotes and reads the signature; it can never read raw_transaction.
GRANT SELECT, INSERT ON signing.economic_intents, signing.sign_requests TO blink_api;
GRANT SELECT (id, sign_request_id, artifact_hash, signature, created_at) ON signing.artifacts TO blink_api;

-- The worker creates intents and requests, reads artifacts to broadcast them, and tracks attempts.
-- It settles gas by moving a reservation into spent, so it needs reserved_wei as well as spent_wei.
GRANT SELECT, INSERT ON signing.economic_intents, signing.sign_requests TO blink_worker;
GRANT UPDATE (state, updated_at, version) ON signing.economic_intents TO blink_worker;
GRANT SELECT ON signing.artifacts TO blink_worker;
GRANT SELECT, INSERT, UPDATE ON signing.tx_attempts TO blink_worker;
GRANT SELECT ON signing.gas_spend TO blink_worker;
GRANT UPDATE (reserved_wei, spent_wei) ON signing.gas_spend TO blink_worker;
