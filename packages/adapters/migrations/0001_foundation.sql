CREATE SCHEMA blink;
CREATE SCHEMA operations;

-- Roles are group roles: a deployment administrator assigns separate login users.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blink_api') THEN CREATE ROLE blink_api NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blink_worker') THEN CREATE ROLE blink_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blink_indexer') THEN CREATE ROLE blink_indexer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blink_signer') THEN CREATE ROLE blink_signer NOLOGIN; END IF;
END $$;

CREATE DOMAIN blink.uint256 AS NUMERIC CHECK (
  VALUE >= 0 AND VALUE < 115792089237316195423570985008687907853269984665640564039457584007913129639936
  AND VALUE = trunc(VALUE)
);
CREATE DOMAIN blink.address AS BYTEA CHECK (octet_length(VALUE) = 20);
CREATE DOMAIN blink.hash AS BYTEA CHECK (octet_length(VALUE) = 32);

CREATE TABLE operations.audit_log (
  id UUID PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  reason TEXT NOT NULL,
  request_id TEXT NOT NULL,
  before_hash blink.hash,
  after_hash blink.hash,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE operations.idempotency_records (
  operator_id UUID NOT NULL,
  endpoint_scope TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  payload_hash blink.hash NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED')),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  response JSONB,
  intent_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operator_id, endpoint_scope, key),
  CHECK (state <> 'COMPLETED' OR response_status IS NOT NULL)
);
CREATE TABLE operations.outbox (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_version BIGINT NOT NULL CHECK (event_version >= 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  dispatched_at TIMESTAMPTZ,
  UNIQUE (aggregate_id,event_version,event_type)
);
CREATE TABLE operations.jobs (
  id UUID PRIMARY KEY,
  outbox_id UUID REFERENCES operations.outbox(id),
  type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUEUED','LEASED','SUCCEEDED','DEAD')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  lease_token BIGINT NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  last_error_code TEXT,
  CHECK ((state = 'LEASED') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX jobs_due ON operations.jobs (next_run_at,id) WHERE state = 'QUEUED';
CREATE INDEX jobs_lease ON operations.jobs (lease_until) WHERE state = 'LEASED';
CREATE INDEX outbox_pending ON operations.outbox (created_at,id) WHERE dispatched_at IS NULL;

CREATE FUNCTION operations.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only table' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON operations.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();

REVOKE ALL ON SCHEMA blink, operations FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA operations FROM PUBLIC;
GRANT USAGE ON SCHEMA blink, operations TO blink_api,blink_worker,blink_indexer,blink_signer;
GRANT SELECT,INSERT ON operations.audit_log TO blink_api,blink_worker,blink_indexer,blink_signer;
GRANT SELECT,INSERT,UPDATE ON operations.idempotency_records TO blink_api;
GRANT SELECT,INSERT ON operations.outbox TO blink_api,blink_worker,blink_indexer;
GRANT UPDATE ON operations.outbox TO blink_worker;
GRANT SELECT,INSERT,UPDATE ON operations.jobs TO blink_worker;
