CREATE SCHEMA markets;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='blink_deployment_admin') THEN
    CREATE ROLE blink_deployment_admin NOLOGIN;
  END IF;
END $$;
CREATE TABLE markets.deployments (
  id TEXT PRIMARY KEY,
  manifest JSONB NOT NULL,
  market_address blink.address NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  lock_version BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE markets.deployment_checks (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  block_hash blink.hash NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX deployment_checks_latest ON markets.deployment_checks(deployment_id,verified_at DESC);
CREATE TABLE markets.specs (
  hash blink.hash PRIMARY KEY,
  object_uri TEXT NOT NULL,
  public_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE markets.approvals (
  id UUID PRIMARY KEY,
  candidate_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  spec_hash blink.hash NOT NULL REFERENCES markets.specs(hash),
  actor_key_id UUID NOT NULL REFERENCES identity.api_keys(id),
  budget_micros blink.uint256 NOT NULL CHECK (budget_micros BETWEEN 1 AND 2000000),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(candidate_id,revision),
  FOREIGN KEY(candidate_id,revision) REFERENCES discovery.candidate_revisions(candidate_id,revision)
);
CREATE TABLE markets.creation_intents (
  id UUID PRIMARY KEY,
  approval_id UUID NOT NULL UNIQUE REFERENCES markets.approvals(id),
  state TEXT NOT NULL CHECK(state='AWAITING_ADMIN_SIGNATURE'),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE markets.active_slots (
  slot_key TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  intent_id UUID NOT NULL UNIQUE REFERENCES markets.creation_intents(id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['deployment_checks','specs','approvals','creation_intents','active_slots'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON markets.%I FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation()',t);
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA markets FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA markets FROM PUBLIC;
GRANT USAGE ON SCHEMA markets TO blink_api;
GRANT SELECT ON ALL TABLES IN SCHEMA markets TO blink_api;
GRANT INSERT ON markets.specs,markets.approvals,markets.creation_intents,markets.active_slots TO blink_api;
GRANT UPDATE(lock_version) ON markets.deployments TO blink_api;
GRANT USAGE ON SCHEMA markets,blink,operations TO blink_deployment_admin;
GRANT SELECT,INSERT ON markets.deployments,markets.deployment_checks TO blink_deployment_admin;
GRANT UPDATE(enabled) ON markets.deployments TO blink_deployment_admin;
GRANT INSERT ON operations.audit_log TO blink_deployment_admin;
