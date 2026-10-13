-- Business clock. The offset setting exists only for local harnesses; services refuse to
-- start with it set unless explicitly in a local test mode (assertProductionClock).
CREATE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
  SELECT clock_timestamp() + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds', true), ''), '0')::double precision)
$$;
GRANT EXECUTE ON FUNCTION blink.now() TO blink_api, blink_worker, blink_indexer, blink_signer;

-- Per-deployment canonical cursor with a fenced lease. Projections below are rebuildable folds of canonical events.
CREATE TABLE chain.cursors (
  deployment_id TEXT PRIMARY KEY REFERENCES markets.deployments(id),
  block_number blink.uint256 NOT NULL,
  block_hash blink.hash NOT NULL,
  block_timestamp blink.uint256 NOT NULL,
  head_number blink.uint256 NOT NULL,
  finalized_number blink.uint256,
  synced_at TIMESTAMPTZ NOT NULL,
  gate_reason TEXT CHECK (gate_reason IN ('REORG_IN_PROGRESS','PROJECTION_MISMATCH','FINALIZED_CONFLICT')),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  lease_token BIGINT NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (head_number >= block_number)
);
CREATE TABLE chain.blocks (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  number blink.uint256 NOT NULL,
  hash blink.hash NOT NULL,
  parent_hash blink.hash NOT NULL,
  timestamp blink.uint256 NOT NULL,
  canonical BOOLEAN NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (deployment_id, hash)
);
CREATE UNIQUE INDEX blocks_canonical_height ON chain.blocks (deployment_id, number) WHERE canonical;
CREATE TABLE chain.events (
  deployment_id TEXT NOT NULL,
  block_hash blink.hash NOT NULL,
  block_number blink.uint256 NOT NULL,
  tx_hash blink.hash NOT NULL,
  tx_index INTEGER NOT NULL CHECK (tx_index >= 0),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  name TEXT NOT NULL CHECK (name IN ('MarketCreated','TradingPauseChanged','TakerAllowedChanged','MakerDeposited','MakerWithdrawn','QuoteFilled','QuoteCancelled','MakerEpochIncremented','OutcomeProposed','OutcomeChallenged','OutcomeFinalized','PositionRedeemed')),
  args JSONB NOT NULL CHECK (jsonb_typeof(args) = 'object'),
  canonical BOOLEAN NOT NULL,
  PRIMARY KEY (deployment_id, block_hash, tx_hash, log_index),
  FOREIGN KEY (deployment_id, block_hash) REFERENCES chain.blocks (deployment_id, hash)
);
CREATE INDEX events_canonical_order ON chain.events (deployment_id, block_number, tx_index, log_index) WHERE canonical;
CREATE TABLE chain.markets (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  market_id blink.uint256 NOT NULL CHECK (market_id > 0),
  spec_hash blink.hash NOT NULL,
  spec_uri TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('LIVE','REPLAY')),
  close_at blink.uint256 NOT NULL,
  proposal_deadline blink.uint256 NOT NULL,
  hard_deadline blink.uint256 NOT NULL,
  challenge_seconds INTEGER NOT NULL CHECK (challenge_seconds > 0),
  max_pairs blink.uint256 NOT NULL,
  max_taker_shares blink.uint256 NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','PROPOSED','DISPUTED','FINAL')),
  paused BOOLEAN NOT NULL DEFAULT false,
  proposed_outcome TEXT CHECK (proposed_outcome IN ('YES','NO','INVALID')),
  proposed_at blink.uint256,
  proposal_evidence_hash blink.hash,
  challenge_evidence_hash blink.hash,
  final_outcome TEXT CHECK (final_outcome IN ('YES','NO','INVALID')),
  final_reason TEXT CHECK (final_reason IN ('UNCHALLENGED','ARBITRATED','TIMEOUT')),
  final_evidence_hash blink.hash,
  total_pairs blink.uint256 NOT NULL DEFAULT 0,
  escrow_micros blink.uint256 NOT NULL DEFAULT 0,
  created_block_number blink.uint256 NOT NULL,
  created_tx_hash blink.hash NOT NULL,
  as_of_block_hash blink.hash NOT NULL,
  PRIMARY KEY (deployment_id, market_id),
  UNIQUE (deployment_id, spec_hash)
);
CREATE TABLE chain.positions (
  deployment_id TEXT NOT NULL,
  market_id blink.uint256 NOT NULL,
  account blink.address NOT NULL,
  yes_shares blink.uint256 NOT NULL DEFAULT 0,
  no_shares blink.uint256 NOT NULL DEFAULT 0,
  taker_bought_shares blink.uint256 NOT NULL DEFAULT 0,
  redeemed_payout_micros blink.uint256 NOT NULL DEFAULT 0,
  as_of_block_hash blink.hash NOT NULL,
  PRIMARY KEY (deployment_id, market_id, account)
);
CREATE TABLE chain.maker_state (
  deployment_id TEXT PRIMARY KEY REFERENCES markets.deployments(id),
  free_balance_micros blink.uint256 NOT NULL DEFAULT 0,
  epoch blink.uint256 NOT NULL DEFAULT 0,
  global_paused BOOLEAN NOT NULL DEFAULT false,
  as_of_block_hash blink.hash NOT NULL
);
CREATE TABLE chain.quote_digests (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  digest blink.hash NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('FILLED','CANCELLED')),
  market_id blink.uint256,
  taker blink.address,
  side TEXT CHECK (side IN ('YES','NO')),
  quantity blink.uint256,
  price_bps INTEGER CHECK (price_bps BETWEEN 1 AND 9999),
  taker_cost_micros blink.uint256,
  maker_cost_micros blink.uint256,
  block_number blink.uint256 NOT NULL,
  block_hash blink.hash NOT NULL,
  tx_hash blink.hash NOT NULL,
  PRIMARY KEY (deployment_id, digest),
  CHECK ((state = 'FILLED') = (market_id IS NOT NULL AND taker IS NOT NULL))
);
CREATE TABLE chain.takers (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  account blink.address NOT NULL,
  allowed BOOLEAN NOT NULL,
  as_of_block_hash blink.hash NOT NULL,
  PRIMARY KEY (deployment_id, account)
);
GRANT USAGE ON SCHEMA chain TO blink_worker, blink_signer;
GRANT SELECT ON chain.cursors, chain.blocks, chain.events, chain.markets, chain.positions, chain.maker_state, chain.quote_digests, chain.takers TO blink_api, blink_worker;
GRANT SELECT ON chain.cursors, chain.markets, chain.maker_state, chain.quote_digests, chain.takers TO blink_signer;
GRANT SELECT, INSERT, UPDATE ON chain.cursors TO blink_indexer;
GRANT SELECT, INSERT ON chain.blocks, chain.events TO blink_indexer;
GRANT UPDATE (canonical) ON chain.blocks, chain.events TO blink_indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON chain.markets, chain.positions, chain.maker_state, chain.quote_digests, chain.takers TO blink_indexer;
