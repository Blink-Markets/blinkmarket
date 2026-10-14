-- Discovery scan bookkeeping (spec 12.1, design 05): one run per source, UTC day and slot, and a
-- per-day cap on new candidates. Platform agents create candidates and forecasts through the public
-- API; the worker only records what it did and reads what it needs to build prompts.
CREATE TABLE discovery.scan_runs (
  id UUID PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES evidence.sources(id),
  day DATE NOT NULL,
  slot SMALLINT NOT NULL CHECK (slot IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('STARTED','CANDIDATE_CREATED','NO_CANDIDATE','MANUAL_REVIEW','FAILED','SKIPPED_DAILY_CAP')),
  evidence_id UUID REFERENCES evidence.records(id),
  candidate_id UUID,
  -- Model calls started for this run, at most two: the first and its one retry.
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  error_code TEXT,
  -- True while this run holds one of the day's candidate slots, so redelivery never counts it twice.
  slot_taken BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  UNIQUE (source_id, day, slot)
);
CREATE TABLE discovery.daily_counters (
  day DATE PRIMARY KEY,
  candidates INTEGER NOT NULL DEFAULT 0 CHECK (candidates BETWEEN 0 AND 10)
);

REVOKE ALL ON discovery.scan_runs, discovery.daily_counters FROM PUBLIC;
GRANT USAGE ON SCHEMA discovery TO blink_worker;
GRANT SELECT, INSERT ON discovery.scan_runs TO blink_worker;
GRANT UPDATE (state, evidence_id, candidate_id, attempts, error_code, slot_taken, updated_at) ON discovery.scan_runs TO blink_worker;
GRANT SELECT, INSERT, UPDATE ON discovery.daily_counters TO blink_worker;

-- Forecast runs need the approved candidate and research budget of the market they forecast
-- (column grants: nothing else about an approval), and their own earlier runs' state. Neither
-- exposes a forecast answer; forecasts.submissions stays unreadable to the worker.
GRANT USAGE ON SCHEMA markets TO blink_worker;
GRANT SELECT (candidate_id, deployment_id, spec_hash, budget_micros, created_at) ON markets.approvals TO blink_worker;
GRANT SELECT (agent_id, window_id, state) ON forecasts.model_runs TO blink_worker;
