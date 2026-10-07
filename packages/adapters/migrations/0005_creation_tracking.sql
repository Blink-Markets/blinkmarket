CREATE SCHEMA chain;
CREATE TABLE chain.creation_projections (
  intent_id UUID PRIMARY KEY REFERENCES markets.creation_intents(id),
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  version BIGINT NOT NULL DEFAULT 0 CHECK(version>=0),
  state TEXT NOT NULL DEFAULT 'NOT_TRACKED' CHECK(state IN ('NOT_TRACKED','UNKNOWN','INCLUDED','CONFIRMED','REVERTED','REORGED')),
  market_id blink.uint256 CHECK(market_id>0),
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state IN ('INCLUDED','CONFIRMED')) = (market_id IS NOT NULL))
);
CREATE UNIQUE INDEX creation_market_unique ON chain.creation_projections(deployment_id,market_id) WHERE market_id IS NOT NULL;
CREATE TABLE chain.creation_observations (
  id UUID PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES markets.creation_intents(id),
  version BIGINT NOT NULL,
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(intent_id,version)
);
CREATE TRIGGER creation_observations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON chain.creation_observations
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();
REVOKE ALL ON SCHEMA chain FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA chain FROM PUBLIC;
GRANT USAGE ON SCHEMA chain TO blink_api,blink_indexer;
GRANT SELECT ON chain.creation_projections TO blink_api;
GRANT SELECT,INSERT,UPDATE ON chain.creation_projections TO blink_indexer;
GRANT SELECT,INSERT ON chain.creation_observations TO blink_indexer;
GRANT USAGE ON SCHEMA markets TO blink_indexer;
GRANT SELECT ON markets.creation_intents,markets.deployments TO blink_indexer;
-- Row locking without allowing changes to the deployment policy.
GRANT UPDATE(lock_version) ON markets.deployments TO blink_indexer;
