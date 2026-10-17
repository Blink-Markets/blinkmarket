-- Alert episodes for alert.evaluate: one row per condition ("family" + "subject") that has been, or
-- is being, watched. A row going inactive -> active emits OPEN; staying active emits STILL_OPEN on
-- the hourly heartbeat, at once when the reason changes, and (monotonic families) when the count
-- grows; active -> inactive emits CLEARED. The row and its operations.outbox alert are written in
-- one transaction, so a crash can neither lose nor repeat a transition.
-- deployment_id is a deployment id, or '*' for conditions without a deployment (budget gates,
-- jobs, the RPC), so it is deliberately not a foreign key.
-- family, subject and reason are closed vocabularies: no free text can reach a notification.
-- alert_seq counts emissions and is the outbox event_version, which keeps each alert's
-- (aggregate_id, event_version, event_type) unique. consecutive_failures is the RPC probe streak
-- (it can be > 0 while the episode is still inactive). last_count is the count last announced for
-- a monotonic episode (DEAD jobs, closed question gates).
-- The worker already reads everything alert.evaluate observes (signing.sign_requests for gas-cap
-- refusals, budgets, chain, trading, operations.jobs), so no other grant is added. DELETE on this
-- table only prunes inactive episodes older than 30 days.
CREATE TABLE operations.alert_episodes (
  deployment_id TEXT NOT NULL CHECK (deployment_id ~ '^([a-zA-Z0-9][a-zA-Z0-9_-]{0,127}|\*)$'),
  family TEXT NOT NULL CHECK (family IN ('budget','pause','rpc','indexer_lag','keeper_overdue','jobs_dead')),
  subject TEXT NOT NULL CHECK (subject ~ '^[a-z_]{1,32}(:[a-z0-9_]{1,78})?$'),
  active BOOLEAN NOT NULL,
  reason TEXT CHECK (reason ~ '^[A-Z0-9_]{1,64}$'),
  opened_at TIMESTAMPTZ,
  last_alert_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_count BIGINT NOT NULL DEFAULT 0 CHECK (last_count >= 0),
  alert_seq BIGINT NOT NULL DEFAULT 0 CHECK (alert_seq >= 0),
  PRIMARY KEY (deployment_id, family, subject),
  CHECK (NOT active OR (reason IS NOT NULL AND opened_at IS NOT NULL AND last_alert_at IS NOT NULL))
);
-- Active episodes are read every tick.
CREATE INDEX alert_episodes_active ON operations.alert_episodes (deployment_id) WHERE active;

-- Gas-cap refusals in the last 24 hours (alert.budget) without scanning every request.
CREATE INDEX sign_requests_rejected_recent ON signing.sign_requests (updated_at) WHERE state = 'REJECTED';

REVOKE ALL ON operations.alert_episodes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON operations.alert_episodes TO blink_worker;
