CREATE SCHEMA forecasts;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='blink_forecast_admin') THEN
    CREATE ROLE blink_forecast_admin NOLOGIN;
  END IF;
END $$;
CREATE TABLE forecasts.platform_agents (
  agent_id UUID PRIMARY KEY REFERENCES identity.agents,
  role TEXT NOT NULL UNIQUE CHECK(role IN ('FORECASTER_A','FORECASTER_B','BASELINE')),
  model TEXT NOT NULL,
  prompt_hash blink.hash NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE forecasts.windows (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  market_id blink.uint256 NOT NULL,
  horizon_type TEXT NOT NULL CHECK(horizon_type IN ('DAILY','PRE_CLOSE')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  open_at TIMESTAMPTZ NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(deployment_id,market_id,horizon_type,scheduled_at),
  CHECK(open_at=scheduled_at-interval '30 minutes' AND deadline=scheduled_at)
);
CREATE TABLE forecasts.submissions (
  id UUID PRIMARY KEY,
  window_id UUID NOT NULL REFERENCES forecasts.windows,
  agent_id UUID NOT NULL REFERENCES identity.agents,
  operator_id UUID NOT NULL REFERENCES identity.operators,
  key_id UUID NOT NULL REFERENCES identity.api_keys,
  probability NUMERIC(7,6) NOT NULL CHECK(probability BETWEEN 0 AND 1),
  evidence_ids UUID[] NOT NULL CHECK(cardinality(evidence_ids) BETWEEN 1 AND 50),
  rationale TEXT NOT NULL CHECK(length(rationale) BETWEEN 1 AND 4000),
  agent_version TEXT NOT NULL CHECK(length(agent_version) BETWEEN 1 AND 4000),
  received_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  UNIQUE(window_id,agent_id)
);
CREATE TABLE forecasts.annotations (
  id UUID PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES forecasts.submissions,
  kind TEXT NOT NULL CHECK(kind IN ('WITHDRAWN','OUTCOME_ALREADY_PUBLIC','WINDOW_CONTAMINATED')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 4000),
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX annotations_submission ON forecasts.annotations(submission_id);
CREATE TABLE forecasts.snapshots (
  id UUID PRIMARY KEY,
  window_id UUID NOT NULL UNIQUE REFERENCES forecasts.windows,
  forecaster_a_submission UUID NOT NULL REFERENCES forecasts.submissions,
  forecaster_b_submission UUID NOT NULL REFERENCES forecasts.submissions,
  probability_sum_millionths INTEGER NOT NULL CHECK(probability_sum_millionths BETWEEN 0 AND 2000000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE forecasts.model_runs (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES identity.agents,
  window_id UUID REFERENCES forecasts.windows,
  purpose TEXT NOT NULL CHECK(purpose IN ('DISCOVERY','FORECAST','BASELINE')),
  model TEXT NOT NULL,
  prompt_hash blink.hash NOT NULL,
  sampling JSONB NOT NULL,
  tool_policy TEXT NOT NULL,
  input_hash blink.hash NOT NULL,
  data_cutoff TIMESTAMPTZ NOT NULL,
  reservation_id UUID,
  provider_request_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('STARTED','SUBMITTED','LATE','SCHEMA_INVALID','FAILED')),
  submission_id UUID REFERENCES forecasts.submissions,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['platform_agents','windows','submissions','annotations','snapshots'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON forecasts.%I FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation()',t);
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA forecasts FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA forecasts FROM PUBLIC;
GRANT USAGE ON SCHEMA forecasts TO blink_api,blink_worker,blink_forecast_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA forecasts TO blink_api;
GRANT INSERT ON forecasts.submissions,forecasts.snapshots TO blink_api;
-- Row locks require a column UPDATE privilege; the immutable trigger still rejects mutations.
GRANT UPDATE(id) ON forecasts.windows TO blink_api;
GRANT SELECT ON forecasts.windows,forecasts.platform_agents TO blink_worker;
GRANT INSERT ON forecasts.windows,forecasts.model_runs TO blink_worker;
-- Permit targeted run updates without exposing submission answers.
GRANT SELECT(id) ON forecasts.model_runs TO blink_worker;
GRANT UPDATE(state,provider_request_id,reservation_id,submission_id,updated_at) ON forecasts.model_runs TO blink_worker;
GRANT USAGE ON SCHEMA blink,operations TO blink_forecast_admin;
GRANT INSERT ON forecasts.platform_agents,forecasts.annotations,operations.audit_log TO blink_forecast_admin;
