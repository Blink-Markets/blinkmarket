-- Registered protocol generations (manifest v2). The manifest is the whole record: the
-- v0.1 markets.deployments table keeps serving the retired single-contract stack until its tasks remove it.
CREATE TABLE markets.protocol_deployments (
  deployment_id TEXT PRIMARY KEY,
  manifest JSONB NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  CHECK (manifest->>'schema' = 'blink.deployment/2' AND manifest->>'deploymentId' = deployment_id)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON markets.protocol_deployments
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();
REVOKE ALL ON markets.protocol_deployments FROM PUBLIC;
GRANT SELECT ON markets.protocol_deployments TO blink_api, blink_worker, blink_indexer;
GRANT SELECT, INSERT ON markets.protocol_deployments TO blink_deployment_admin;
