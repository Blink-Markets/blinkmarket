CREATE SCHEMA identity;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blink_identity_admin') THEN
    CREATE ROLE blink_identity_admin NOLOGIN;
  END IF;
END $$;

CREATE TABLE identity.operators (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE identity.agents (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES identity.operators(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  lock_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id, operator_id)
);
CREATE TABLE identity.api_keys (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  secret_hash blink.hash NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL CHECK (
    cardinality(scopes) > 0 AND array_position(scopes, NULL) IS NULL AND
    scopes <@ ARRAY['candidate:write','forecast:write','trade:quote','report:write','faucet:claim','admin']::TEXT[]
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_authenticated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (agent_id, operator_id) REFERENCES identity.agents(id, operator_id),
  UNIQUE(id, agent_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
);
CREATE TABLE identity.wallet_challenges (
  id UUID PRIMARY KEY,
  key_id UUID NOT NULL REFERENCES identity.api_keys(id),
  agent_id UUID NOT NULL REFERENCES identity.agents(id),
  address blink.address NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
  origin TEXT NOT NULL,
  nonce_hash blink.hash NOT NULL UNIQUE,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at = issued_at + interval '5 minutes'),
  FOREIGN KEY (key_id, agent_id) REFERENCES identity.api_keys(id, agent_id),
  UNIQUE(id, agent_id, address, chain_id)
);
CREATE INDEX wallet_challenges_by_key ON identity.wallet_challenges(key_id, expires_at);
CREATE TABLE identity.wallet_bindings (
  agent_id UUID PRIMARY KEY REFERENCES identity.agents(id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
  address blink.address NOT NULL,
  challenge_id UUID NOT NULL UNIQUE REFERENCES identity.wallet_challenges(id),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chain_id, address),
  FOREIGN KEY (challenge_id, agent_id, address, chain_id)
    REFERENCES identity.wallet_challenges(id, agent_id, address, chain_id)
);
CREATE TRIGGER wallet_binding_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON identity.wallet_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();

REVOKE ALL ON SCHEMA identity FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA identity FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO blink_api, blink_identity_admin;
GRANT SELECT ON identity.operators, identity.agents, identity.api_keys TO blink_api;
-- Column-only UPDATE grants allow row locks without granting credential/scope changes.
GRANT UPDATE(lock_version) ON identity.agents TO blink_api;
GRANT UPDATE(last_authenticated_at) ON identity.api_keys TO blink_api;
GRANT SELECT, INSERT ON identity.wallet_challenges, identity.wallet_bindings TO blink_api;
GRANT UPDATE(consumed_at) ON identity.wallet_challenges TO blink_api;
GRANT SELECT, INSERT ON identity.operators, identity.agents, identity.api_keys TO blink_identity_admin;
GRANT UPDATE(revoked_at) ON identity.api_keys TO blink_identity_admin;
GRANT USAGE ON SCHEMA blink, operations TO blink_identity_admin;
GRANT SELECT, INSERT ON operations.audit_log TO blink_identity_admin;
