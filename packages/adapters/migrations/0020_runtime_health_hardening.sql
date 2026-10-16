-- QUEUED and LEASED already have jobs_due/jobs_lease. Health never scans succeeded history.
CREATE INDEX jobs_dead ON operations.jobs (id) WHERE state = 'DEAD';

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA
  blink, operations, identity, evidence, discovery, markets, chain, budgets,
  forecasts, signing, trading, faucet, resolution, analytics FROM PUBLIC;

-- Trigger functions are invoked by existing triggers, not called directly by runtime roles.
GRANT EXECUTE ON FUNCTION blink.now() TO
  blink_api, blink_worker, blink_indexer, blink_signer, blink_trading_admin;
