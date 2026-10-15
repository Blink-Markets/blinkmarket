-- RFQ trading: the maker collateral pool, signed quotes, their collateral reservations and the
-- operator quote gates (spec 8, design 04). Reservations are the off-chain guard that keeps signed
-- quotes within the maker's free balance; the contract still checks the balance at fill time.
CREATE SCHEMA trading;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='blink_trading_admin') THEN
    CREATE ROLE blink_trading_admin NOLOGIN;
  END IF;
END $$;

-- One row per deployment: the lock that serializes quoting and reconciliation. LIVE and REPLAY
-- markets of a deployment share the maker's one on-chain free balance, hence one pool.
CREATE TABLE trading.maker_pools (
  deployment_id TEXT PRIMARY KEY REFERENCES markets.deployments(id),
  gate_reason TEXT CHECK (gate_reason IN ('OVERCOMMITTED')),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0)
);

-- Operator-closed markets. A row is closed until reopened; nothing is deleted.
CREATE TABLE trading.quote_gates (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  market_id blink.uint256 NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('OUTCOME_KNOWN','ANNOUNCEMENT_EARLY','OPERATOR_PAUSE','SPEC_INTEGRITY')),
  actor TEXT NOT NULL,
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 4000),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  reopened_at TIMESTAMPTZ,
  reopened_by TEXT,
  CHECK ((reopened_at IS NULL) = (reopened_by IS NULL))
);
CREATE UNIQUE INDEX quote_gates_open ON trading.quote_gates (deployment_id, market_id, reason)
  WHERE reopened_at IS NULL;

-- operator_id and idempotency_key tie a quote to the request that created it, so a retry after an
-- unknown signing outcome finds its own quote instead of creating a second one.
CREATE TABLE trading.quotes (
  id UUID PRIMARY KEY,
  digest blink.hash NOT NULL UNIQUE,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  market_id blink.uint256 NOT NULL,
  operator_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  agent_id UUID NOT NULL,
  key_id UUID NOT NULL,
  taker blink.address NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES','NO')),
  quantity blink.uint256 NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  price_bps INTEGER NOT NULL CHECK (price_bps BETWEEN 1 AND 9999),
  taker_cost_micros blink.uint256 NOT NULL,
  maker_cost_micros blink.uint256 NOT NULL,
  max_cost_micros blink.uint256 NOT NULL,
  valid_after blink.uint256 NOT NULL,
  expires_at blink.uint256 NOT NULL,
  nonce blink.uint256 NOT NULL,
  epoch blink.uint256 NOT NULL,
  spec_hash blink.hash NOT NULL,
  forecast_snapshot_id UUID NOT NULL REFERENCES forecasts.snapshots(id),
  intent_id UUID NOT NULL UNIQUE REFERENCES signing.economic_intents(id),
  sign_request_id UUID NOT NULL UNIQUE REFERENCES signing.sign_requests(id),
  snapshot_block_number blink.uint256 NOT NULL,
  snapshot_block_hash blink.hash NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SIGN_REQUESTED','SIGNED','SIGN_UNKNOWN','SIGN_REJECTED','EXPIRED','CANCELLED','CONSUMED')),
  status_block_hash blink.hash,
  envelope JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  signed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (operator_id, idempotency_key),
  CHECK (taker_cost_micros + maker_cost_micros = quantity * 1000000),
  CHECK (expires_at > valid_after),
  CHECK ((envelope IS NULL) = (signed_at IS NULL)),
  CHECK (envelope IS NULL OR jsonb_typeof(envelope) = 'object')
);
CREATE INDEX quotes_outstanding ON trading.quotes (deployment_id, taker, expires_at)
  WHERE status IN ('SIGN_REQUESTED','SIGNED','SIGN_UNKNOWN');

CREATE TABLE trading.collateral_reservations (
  id UUID PRIMARY KEY,
  quote_id UUID NOT NULL UNIQUE REFERENCES trading.quotes(id),
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  amount_micros blink.uint256 NOT NULL CHECK (amount_micros > 0),
  state TEXT NOT NULL CHECK (state IN ('HELD','RECONCILE_REQUIRED','ACCOUNTED','RELEASED')),
  -- The canonical block the state was decided at, so a reorg can find what it must reopen.
  state_block_number blink.uint256,
  state_block_hash blink.hash,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK ((state_block_number IS NULL) = (state_block_hash IS NULL))
);
CREATE INDEX reservations_open ON trading.collateral_reservations (deployment_id)
  WHERE state IN ('HELD','RECONCILE_REQUIRED');
CREATE INDEX reservations_settled ON trading.collateral_reservations (deployment_id)
  WHERE state IN ('ACCOUNTED','RELEASED') AND state_block_hash IS NOT NULL;

CREATE TABLE trading.reservation_events (
  id UUID PRIMARY KEY,
  reservation_id UUID NOT NULL REFERENCES trading.collateral_reservations(id),
  from_state TEXT CHECK (from_state IN ('HELD','RECONCILE_REQUIRED','ACCOUNTED','RELEASED')),
  to_state TEXT NOT NULL CHECK (to_state IN ('HELD','RECONCILE_REQUIRED','ACCOUNTED','RELEASED')),
  block_hash blink.hash,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reservation_events_reservation ON trading.reservation_events (reservation_id, created_at);
CREATE TRIGGER reservation_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON trading.reservation_events
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();

REVOKE ALL ON SCHEMA trading FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA trading FROM PUBLIC;
GRANT USAGE ON SCHEMA trading TO blink_api, blink_worker, blink_signer, blink_trading_admin;

-- The API quotes; the worker reconciles. Updates are limited to the columns that change after
-- creation (and UPDATE on any column is what lets SELECT ... FOR UPDATE take the pool lock).
GRANT SELECT, INSERT ON trading.maker_pools, trading.quotes, trading.collateral_reservations
  TO blink_api, blink_worker;
GRANT UPDATE (gate_reason, version) ON trading.maker_pools TO blink_api, blink_worker;
GRANT UPDATE (status, status_block_hash, envelope, signed_at, updated_at, version) ON trading.quotes
  TO blink_api, blink_worker;
GRANT UPDATE (state, state_block_number, state_block_hash, updated_at, version) ON trading.collateral_reservations
  TO blink_api, blink_worker;
GRANT INSERT ON trading.reservation_events TO blink_api, blink_worker;
GRANT SELECT ON trading.quote_gates TO blink_api;
-- The signer checks that a reservation backs every quote it is asked to sign; it never writes here.
GRANT SELECT ON trading.quotes, trading.collateral_reservations TO blink_signer;

-- Operators close and reopen markets through the trading:admin tool, with an audit row.
GRANT SELECT, INSERT ON trading.quote_gates TO blink_trading_admin;
GRANT UPDATE (reopened_at, reopened_by) ON trading.quote_gates TO blink_trading_admin;
GRANT USAGE ON SCHEMA blink, operations TO blink_trading_admin;
GRANT EXECUTE ON FUNCTION blink.now() TO blink_trading_admin;
GRANT INSERT ON operations.audit_log TO blink_trading_admin;
