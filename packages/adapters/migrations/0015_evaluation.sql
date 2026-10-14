CREATE SCHEMA analytics;
CREATE TABLE analytics.score_entries (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  market_id blink.uint256 NOT NULL,
  window_id UUID NOT NULL REFERENCES forecasts.windows,
  mode TEXT NOT NULL CHECK (mode IN ('LIVE','REPLAY')),
  scorer TEXT NOT NULL CHECK (scorer IN ('ENSEMBLE','BASELINE','AGENT')),
  agent_id UUID REFERENCES identity.agents,
  probability_millionths INTEGER CHECK (probability_millionths BETWEEN 0 AND 1000000),
  -- Odd ensemble sums have no exact integer-millionths representation.
  probability_millionths_times2 INTEGER CHECK (probability_millionths_times2 BETWEEN 0 AND 2000000),
  outcome TEXT NOT NULL CHECK (outcome IN ('YES','NO','INVALID')),
  brier NUMERIC CHECK (brier BETWEEN 0 AND 1),
  missing BOOLEAN NOT NULL,
  contaminated BOOLEAN NOT NULL,
  evaluation_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  UNIQUE NULLS NOT DISTINCT (window_id,scorer,agent_id,evaluation_version),
  CHECK ((scorer='AGENT') = (agent_id IS NOT NULL)),
  CHECK ((brier IS NULL) = (missing OR outcome='INVALID')),
  CHECK (missing OR probability_millionths_times2 IS NOT NULL),
  CHECK (probability_millionths IS NOT DISTINCT FROM
    CASE WHEN probability_millionths_times2 % 2 = 0 THEN probability_millionths_times2 / 2 END)
);
CREATE INDEX scores_mode_event ON analytics.score_entries(mode,deployment_id,market_id);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON analytics.score_entries
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();

-- Owner-rights, security-barrier view: workers can score resolved markets without
-- gaining access to active forecast answers, rationales, evidence or API keys.
CREATE VIEW analytics.final_forecasts WITH (security_barrier=true) AS
SELECT w.id AS window_id,w.deployment_id,w.market_id::text AS market_id,m.mode,m.final_outcome AS outcome,
  s.agent_id,p.role,(s.probability*1000000)::integer AS probability_millionths,
  EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id AND a.kind='WITHDRAWN') AS withdrawn,
  EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id) AS contaminated
FROM forecasts.windows w
JOIN chain.markets m USING(deployment_id,market_id)
LEFT JOIN forecasts.submissions s ON s.window_id=w.id
LEFT JOIN forecasts.platform_agents p ON p.agent_id=s.agent_id
WHERE m.state='FINAL' AND m.final_outcome IS NOT NULL;
REVOKE ALL ON SCHEMA analytics FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA analytics FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics TO blink_api,blink_worker;
GRANT SELECT ON analytics.score_entries TO blink_api,blink_worker;
GRANT INSERT ON analytics.score_entries TO blink_worker;
GRANT SELECT ON analytics.final_forecasts TO blink_worker;
