CREATE SCHEMA resolution;
CREATE TABLE resolution.reports (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  market_id blink.uint256 NOT NULL,
  agent_id UUID NOT NULL REFERENCES identity.agents(id),
  operator_id UUID NOT NULL REFERENCES identity.operators(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('YES','NO','INVALID')),
  evidence_ids UUID[] NOT NULL CHECK (cardinality(evidence_ids) BETWEEN 1 AND 50),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now()
);
CREATE TABLE resolution.report_events (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES resolution.reports(id),
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('RECEIVED','TRIAGED','DISMISSED','ACTIONED')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now()
);
CREATE INDEX report_events_latest ON resolution.report_events(report_id,sequence DESC);
CREATE TABLE resolution.suggestions (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  market_id blink.uint256 NOT NULL,
  evidence_id UUID NOT NULL REFERENCES evidence.records(id),
  value_bps INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('YES','NO')),
  locator JSONB NOT NULL,
  parser_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  UNIQUE(deployment_id,market_id,evidence_id,parser_version)
);
CREATE TABLE resolution.alerts_sent (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  market_id blink.uint256 NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CHALLENGE_END','HARD_DEADLINE')),
  threshold_seconds INTEGER NOT NULL CHECK (threshold_seconds > 0),
  PRIMARY KEY(deployment_id,market_id,kind,threshold_seconds)
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['reports','report_events','suggestions','alerts_sent'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON resolution.%I FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation()',t);
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA resolution FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA resolution FROM PUBLIC;
GRANT USAGE ON SCHEMA resolution TO blink_api,blink_worker;
GRANT SELECT,INSERT ON resolution.reports,resolution.report_events TO blink_api;
GRANT USAGE ON SEQUENCE resolution.report_events_sequence_seq TO blink_api;
GRANT SELECT ON resolution.suggestions TO blink_api;
GRANT SELECT,INSERT ON resolution.suggestions,resolution.alerts_sent TO blink_worker;
GRANT USAGE ON SCHEMA evidence,markets,discovery TO blink_worker;
GRANT SELECT ON evidence.records,evidence.sources,markets.approvals,discovery.candidate_revisions TO blink_worker;
