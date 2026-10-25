-- Replace only the retired projections. Canonical blocks, cursors and lease fencing survive.
DROP VIEW analytics.final_forecasts;
DROP TABLE chain.events;
DROP TABLE chain.markets;
DROP TABLE chain.positions;
DROP TABLE chain.quote_digests;
DROP TABLE chain.maker_state;
DROP TABLE chain.takers;
-- Cursors now identify protocol generations, rather than historical v0.1 deployments.
ALTER TABLE chain.cursors DROP CONSTRAINT cursors_deployment_id_fkey;
ALTER TABLE chain.blocks DROP CONSTRAINT blocks_deployment_id_fkey;
ALTER TABLE chain.cursors ADD COLUMN head_timestamp blink.uint256;
CREATE SCHEMA protocol;
REVOKE ALL ON SCHEMA protocol FROM PUBLIC;
GRANT USAGE ON SCHEMA protocol TO blink_api,blink_worker,blink_indexer;
CREATE TABLE protocol.events (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 block_hash blink.hash NOT NULL, block_number blink.uint256 NOT NULL,
 tx_hash blink.hash NOT NULL, tx_index INTEGER NOT NULL CHECK(tx_index>=0),
 log_index INTEGER NOT NULL CHECK(log_index>=0), emitter blink.address NOT NULL,
 contract TEXT NOT NULL CHECK(contract IN ('REGISTRY','JURORS','MARKETS','RESOLUTION','FAUCET','ANCHOR','GOVERNOR')),
 name TEXT NOT NULL, args JSONB NOT NULL CHECK(jsonb_typeof(args)='object'),canonical BOOLEAN NOT NULL,
 PRIMARY KEY(deployment_id,block_hash,log_index),
 FOREIGN KEY(deployment_id,block_hash) REFERENCES chain.blocks(deployment_id,hash)
);
CREATE INDEX protocol_events_order ON protocol.events(deployment_id,block_number,log_index) WHERE canonical;
GRANT SELECT ON protocol.events TO blink_api,blink_worker;
GRANT SELECT,INSERT ON protocol.events TO blink_indexer;
GRANT UPDATE(canonical) ON protocol.events TO blink_indexer;
CREATE TABLE protocol.accounts (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.accounts TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.accounts TO blink_indexer;
CREATE TABLE protocol.templates (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.templates TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.templates TO blink_indexer;
CREATE TABLE protocol.markets (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.markets TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.markets TO blink_indexer;
CREATE TABLE protocol.positions (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.positions TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.positions TO blink_indexer;
CREATE TABLE protocol.makers (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.makers TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.makers TO blink_indexer;
CREATE TABLE protocol.quote_digests (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.quote_digests TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.quote_digests TO blink_indexer;
CREATE TABLE protocol.fills (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.fills TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.fills TO blink_indexer;
CREATE TABLE protocol.anchors (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.anchors TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.anchors TO blink_indexer;
CREATE TABLE protocol.successors (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.successors TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.successors TO blink_indexer;
CREATE TABLE protocol.account_roles (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 account blink.address NOT NULL, role TEXT NOT NULL CHECK(role IN ('CREATOR','MAKER','TAKER','FORECASTER','PROPOSER','CHALLENGER','JUROR')),
 data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),PRIMARY KEY(deployment_id,account,role)
);
GRANT SELECT ON protocol.account_roles TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.account_roles TO blink_indexer;
CREATE TABLE protocol.credit (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 account blink.address NOT NULL, role TEXT NOT NULL CHECK(role IN ('CREATOR','MAKER','TAKER','FORECASTER','PROPOSER','CHALLENGER','JUROR')),
 data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),PRIMARY KEY(deployment_id,account,role)
);
GRANT SELECT ON protocol.credit TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.credit TO blink_indexer;
CREATE INDEX protocol_market_spec ON protocol.markets(deployment_id,(data->>'specHash'));
CREATE INDEX protocol_market_page ON protocol.markets(deployment_id,((data->>'marketId')::numeric));
CREATE VIEW analytics.final_forecasts WITH (security_barrier=true) AS
SELECT w.id AS window_id,w.deployment_id,w.market_id::text AS market_id,
 CASE WHEN (m.data->>'replay')::boolean THEN 'REPLAY' ELSE 'LIVE' END AS mode,m.data->>'finalOutcome' AS outcome,
 s.agent_id,(s.probability*1000000)::integer AS probability_millionths,
 EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id AND a.kind='WITHDRAWN') AS withdrawn,
 EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id) AS contaminated
FROM forecasts.windows w JOIN protocol.markets m ON m.deployment_id=w.deployment_id AND m.key=w.market_id::text
LEFT JOIN forecasts.submissions s ON s.window_id=w.id
WHERE m.data->>'state'='FINAL' AND m.data->>'finalOutcome' IS NOT NULL;
REVOKE ALL ON analytics.final_forecasts FROM PUBLIC;
GRANT SELECT ON analytics.final_forecasts TO blink_worker;

-- Transitional read shapes for the public read/forecast services replaced in Tasks 7 and 10.
-- These views read protocol projections; the indexer never writes legacy chain tables.
CREATE VIEW protocol.market_reads WITH(security_invoker=true) AS SELECT deployment_id,key::numeric AS market_id,
 decode(substring(data->>'specHash' from 3),'hex') AS spec_hash,data->>'specUri' AS spec_uri,
 CASE WHEN (data->>'replay')::boolean THEN 'REPLAY' ELSE 'LIVE' END AS mode,
 (data->>'closeAt')::numeric AS close_at,(data->>'proposalDeadline')::numeric AS proposal_deadline,
 (data->>'hardDeadline')::numeric AS hard_deadline,
 COALESCE((data->>'challengeSeconds')::integer,0) AS challenge_seconds,
 (data->>'maxPairs')::numeric AS max_pairs,COALESCE((data->>'maxTakerShares')::numeric,0) AS max_taker_shares,
 data->>'state' AS state,COALESCE((data->>'paused')::boolean,false) AS paused,
 data->>'proposedOutcome' AS proposed_outcome,(data->>'proposedAt')::numeric AS proposed_at,
 decode(substring(data->>'proposalEvidenceHash' from 3),'hex') AS proposal_evidence_hash,
 decode(substring(data->>'challengeEvidenceHash' from 3),'hex') AS challenge_evidence_hash,
 data->>'finalOutcome' AS final_outcome,data->>'finalReason' AS final_reason,
 decode(substring(data->>'finalEvidenceHash' from 3),'hex') AS final_evidence_hash,
 (data->>'mintedPairs')::numeric AS total_pairs,(data->>'escrowMicros')::numeric AS escrow_micros,
 COALESCE((data->>'createdBlockNumber')::numeric,(SELECT e.block_number FROM protocol.events e WHERE e.deployment_id=m.deployment_id AND e.canonical AND e.name='MarketCreated' AND e.args->>'marketId'=m.key LIMIT 1)) AS created_block_number,
 decode(substring(data->>'createdTxHash' from 3),'hex') AS created_tx_hash,as_of_block_hash
 FROM protocol.markets m;
CREATE VIEW protocol.position_reads WITH(security_invoker=true) AS SELECT deployment_id,(data->>'marketId')::numeric AS market_id,
 decode(substring(data->>'account' from 3),'hex') AS account,(data->>'yesShares')::numeric AS yes_shares,
 (data->>'noShares')::numeric AS no_shares,(data->>'takerBoughtShares')::numeric AS taker_bought_shares,
 (data->>'redeemedPayoutMicros')::numeric AS redeemed_payout_micros,as_of_block_hash FROM protocol.positions;
CREATE VIEW protocol.maker_reads WITH(security_invoker=true) AS SELECT deployment_id,
 sum((data->>'freeMicros')::numeric) AS free_balance_micros,max((data->>'epoch')::numeric) AS epoch,
 bool_or(COALESCE((data->>'globalPaused')::boolean,false)) AS global_paused FROM protocol.makers GROUP BY deployment_id;
GRANT SELECT ON protocol.market_reads,protocol.position_reads,protocol.maker_reads TO blink_api,blink_worker,blink_indexer;
