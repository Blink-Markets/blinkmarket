-- Retention for finished jobs and dispatched outbox rows, and indexes for the worker's
-- recovery lookups (execution sweep) so they do not scan the whole jobs table.
CREATE INDEX jobs_finished ON operations.jobs (finished_at) WHERE state IN ('SUCCEEDED','DEAD');
CREATE INDEX jobs_outbox ON operations.jobs (outbox_id) WHERE outbox_id IS NOT NULL;
CREATE INDEX outbox_dispatched ON operations.outbox (dispatched_at) WHERE dispatched_at IS NOT NULL;
CREATE INDEX jobs_active_intent ON operations.jobs ((payload->>'intentId')) WHERE type='tx.dispatch' AND state IN ('QUEUED','LEASED');
CREATE INDEX jobs_active_claim ON operations.jobs ((payload->>'claimId')) WHERE type='faucet.mint' AND state IN ('QUEUED','LEASED');
GRANT DELETE ON operations.jobs, operations.outbox TO blink_worker;
