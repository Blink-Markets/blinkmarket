-- Durable job runtime: retry ceiling, creation and finish times. Business transactions
-- (API, indexer) enqueue jobs atomically with their own writes; only workers lease them.
ALTER TABLE operations.jobs
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN finished_at TIMESTAMPTZ;
GRANT SELECT, INSERT ON operations.jobs TO blink_api, blink_indexer;

-- USD research budget (spec 12.5): amounts are USD micros (1 USD = 1000000).
CREATE SCHEMA budgets;
CREATE TABLE budgets.daily (
  day DATE PRIMARY KEY,
  cap_usd_micros blink.uint256 NOT NULL DEFAULT 20000000 CHECK (cap_usd_micros <= 20000000),
  gate_closed_reason TEXT,
  version BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE budgets.questions (
  question_key TEXT PRIMARY KEY CHECK (length(question_key) BETWEEN 1 AND 200),
  cap_usd_micros blink.uint256 NOT NULL CHECK (cap_usd_micros BETWEEN 1 AND 2000000),
  gate_closed_reason TEXT,
  version BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE budgets.reservations (
  id UUID PRIMARY KEY,
  day DATE NOT NULL REFERENCES budgets.daily(day),
  question_key TEXT NOT NULL REFERENCES budgets.questions(question_key),
  run_id UUID NOT NULL UNIQUE,
  job_id UUID,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  max_usd_micros blink.uint256 NOT NULL CHECK (max_usd_micros > 0),
  state TEXT NOT NULL CHECK (state IN ('RESERVED','UNKNOWN','RECONCILED','RELEASED')),
  actual_usd_micros blink.uint256,
  provider_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  CHECK ((state = 'RECONCILED') = (actual_usd_micros IS NOT NULL))
);
CREATE INDEX reservations_day ON budgets.reservations (day, state);
CREATE INDEX reservations_question ON budgets.reservations (question_key, state);
CREATE TABLE budgets.cost_entries (
  id UUID PRIMARY KEY,
  reservation_id UUID NOT NULL REFERENCES budgets.reservations(id),
  kind TEXT NOT NULL CHECK (kind IN ('RESERVE','UNKNOWN','RECONCILE','RELEASE','OVERRUN')),
  amount_usd_micros blink.uint256 NOT NULL,
  provider_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now()
);
CREATE INDEX cost_entries_reservation ON budgets.cost_entries (reservation_id);
CREATE TRIGGER cost_entries_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON budgets.cost_entries
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();

REVOKE ALL ON SCHEMA budgets FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA budgets FROM PUBLIC;
GRANT USAGE ON SCHEMA budgets TO blink_api, blink_worker;
GRANT SELECT, INSERT, UPDATE ON budgets.daily, budgets.questions, budgets.reservations TO blink_worker;
GRANT SELECT, INSERT ON budgets.cost_entries TO blink_worker;
GRANT SELECT ON budgets.daily, budgets.questions, budgets.reservations, budgets.cost_entries TO blink_api;
