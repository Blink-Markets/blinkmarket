-- Resolution, juror and fee projections (Task 7). Same shape and grants as the 0029 projections: the
-- indexer rewrites them from the canonical journal, the API and worker only read them.
CREATE TABLE protocol.proposals (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.proposals TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.proposals TO blink_indexer;
CREATE TABLE protocol.disputes (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.disputes TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.disputes TO blink_indexer;
CREATE TABLE protocol.rounds (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.rounds TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.rounds TO blink_indexer;
CREATE TABLE protocol.votes (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.votes TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.votes TO blink_indexer;
CREATE TABLE protocol.jurors (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.jurors TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.jurors TO blink_indexer;
CREATE TABLE protocol.reward_pool (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.reward_pool TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.reward_pool TO blink_indexer;
CREATE TABLE protocol.fees (
 deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
 key TEXT NOT NULL, data JSONB NOT NULL, as_of_block_hash blink.hash NOT NULL,
 PRIMARY KEY(deployment_id,key)
);
GRANT SELECT ON protocol.fees TO blink_api,blink_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON protocol.fees TO blink_indexer;
-- Keyset pages: a market's disputes, a dispute's rounds and votes, an account's positions.
CREATE INDEX protocol_dispute_market ON protocol.disputes(deployment_id,((data->>'marketId')::numeric),((data->>'disputeId')::numeric));
CREATE INDEX protocol_round_dispute ON protocol.rounds(deployment_id,((data->>'disputeId')::numeric),((data->>'round')::numeric));
CREATE INDEX protocol_vote_page ON protocol.votes(deployment_id,((data->>'disputeId')::numeric),((data->>'round')::numeric),(data->>'juror'));
CREATE INDEX protocol_position_account ON protocol.positions(deployment_id,(data->>'account'),((data->>'marketId')::numeric));
