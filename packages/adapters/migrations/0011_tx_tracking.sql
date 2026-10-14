CREATE TABLE chain.transactions (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  tx_hash blink.hash NOT NULL,
  agent_id UUID NOT NULL REFERENCES identity.agents(id),
  wallet blink.address NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('APPROVE','FILL','REDEEM')),
  quote_id blink.hash,
  market_id blink.uint256,
  status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN','INCLUDED','FINALIZED','REVERTED','REORGED')),
  reject_reason TEXT,
  receipt_block_hash blink.hash,
  receipt_block_number blink.uint256,
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  UNIQUE (deployment_id,tx_hash),
  CHECK (action <> 'FILL' OR quote_id IS NOT NULL)
);
CREATE INDEX transactions_tracking ON chain.transactions(updated_at,id)
  WHERE reject_reason IS NULL AND status IN ('UNKNOWN','INCLUDED','REORGED');
CREATE INDEX transactions_wallet_market ON chain.transactions(deployment_id,wallet,market_id) WHERE status='UNKNOWN';
REVOKE ALL ON chain.transactions FROM PUBLIC;
GRANT SELECT,INSERT ON chain.transactions TO blink_api;
GRANT SELECT,UPDATE(status,reject_reason,receipt_block_hash,receipt_block_number,market_id,version,updated_at) ON chain.transactions TO blink_indexer;
GRANT SELECT ON chain.transactions TO blink_worker;
