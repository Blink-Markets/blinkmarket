-- P2: retire platform-owned signing, execution and pricing. Historical migrations stay intact.
REVOKE ALL ON SCHEMA signing, faucet, trading FROM blink_api, blink_worker, blink_signer, blink_trading_admin;
REVOKE ALL ON ALL TABLES IN SCHEMA signing, faucet, trading FROM blink_api, blink_worker, blink_signer, blink_trading_admin;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA signing, trading FROM blink_api, blink_worker, blink_signer, blink_trading_admin;
REVOKE ALL ON SCHEMA blink, operations, markets, chain FROM blink_signer, blink_trading_admin;
REVOKE ALL ON ALL TABLES IN SCHEMA operations, markets, chain FROM blink_signer, blink_trading_admin;
REVOKE ALL ON FUNCTION blink.now() FROM blink_signer, blink_trading_admin;

DROP TRIGGER economic_intents_api_scope ON signing.economic_intents;
DROP TRIGGER sign_requests_scope ON signing.sign_requests;
DROP TRIGGER tx_attempt_inclusion ON signing.tx_attempts;
DROP TRIGGER risk_reservations_transition ON trading.risk_reservations;
DROP TRIGGER artifacts_append_only ON signing.artifacts;
DROP TRIGGER signing_plans_append_only ON signing.signing_plans;
DROP TRIGGER nonce_allocations_append_only ON signing.nonce_allocations;
DROP TRIGGER reservation_events_append_only ON trading.reservation_events;
DROP FUNCTION signing.restrict_api_intents();
DROP FUNCTION signing.restrict_sign_requests();
DROP FUNCTION signing.observe_inclusion();
DROP FUNCTION trading.guard_risk_reservation();

DROP INDEX signing.sign_requests_rejected_recent;
DROP INDEX operations.jobs_active_intent;
DROP INDEX operations.jobs_active_claim;
DROP VIEW trading.trader_snapshot_windows;
DROP VIEW trading.trader_snapshots;
DROP TABLE trading.risk_reservations;
DROP TABLE trading.mandates;
DROP TABLE trading.reservation_events;
DROP TABLE trading.collateral_reservations;
DROP TABLE trading.quotes;
DROP TABLE trading.quote_gates;
DROP TABLE trading.maker_pools;
DROP TABLE faucet.claims;
DROP TABLE faucet.address_guards;
DROP TABLE signing.tx_attempts;
DROP TABLE signing.signing_plans;
DROP TABLE signing.nonce_allocations;
DROP TABLE signing.sender_guards;
DROP TABLE signing.artifacts;
DROP TABLE signing.sign_requests;
DROP TABLE signing.economic_intents;
DROP TABLE signing.gas_spend;
DROP SCHEMA signing;
DROP SCHEMA faucet;
-- Preserve trading if a later installation added objects outside this retirement scope.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='trading'::regnamespace)
     AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='trading'::regnamespace)
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace='trading'::regnamespace) THEN
    DROP SCHEMA trading;
  END IF;
END $$;
DROP ROLE blink_signer;
DROP ROLE blink_trading_admin;

-- Fence any old lease as well as retiring queued work. The column is last_error_code here.
UPDATE operations.jobs
SET state='DEAD', last_error_code='RETIRED_P2', finished_at=blink.now(),
    lease_owner=NULL, lease_until=NULL, lease_token=lease_token+1
WHERE state IN ('QUEUED','LEASED') AND
  (type IN ('tx.dispatch','quote.reconcile') OR type LIKE 'keeper.%' OR type LIKE 'faucet.%' OR type LIKE 'trader.%');
-- Retired conditions must not leave stale incidents in the infrastructure alert stream.
DELETE FROM operations.alert_episodes
WHERE family='keeper_overdue' OR (family='pause' AND subject='pool') OR (family='budget' AND subject LIKE 'role:%');
