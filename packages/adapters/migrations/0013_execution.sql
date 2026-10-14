CREATE SCHEMA faucet;
CREATE TABLE faucet.claims (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  agent_id UUID NOT NULL REFERENCES identity.agents(id),
  address blink.address NOT NULL,
  amount_micros blink.uint256 NOT NULL CHECK (amount_micros = 1000000000),
  intent_id UUID NOT NULL UNIQUE REFERENCES signing.economic_intents(id),
  state TEXT NOT NULL CHECK (state IN ('QUEUED','SUBMITTED','SUCCEEDED','FAILED','UNKNOWN')),
  succeeded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  CHECK ((state = 'SUCCEEDED') = (succeeded_at IS NOT NULL))
);
CREATE INDEX claims_address_window ON faucet.claims(deployment_id, address, state, succeeded_at);
CREATE TABLE faucet.address_guards (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  address blink.address NOT NULL,
  PRIMARY KEY (deployment_id, address)
);
REVOKE ALL ON SCHEMA faucet FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA faucet FROM PUBLIC;
GRANT USAGE ON SCHEMA faucet TO blink_api, blink_worker;
GRANT INSERT, SELECT ON faucet.claims, faucet.address_guards TO blink_api;
-- PostgreSQL requires UPDATE on at least one column for SELECT ... FOR UPDATE.
GRANT UPDATE (address) ON faucet.address_guards TO blink_api;
GRANT SELECT ON faucet.claims TO blink_worker;
GRANT UPDATE (state, succeeded_at, updated_at) ON faucet.claims TO blink_worker;

-- Expand Task 8's API scope only for first-version faucet mints.
CREATE OR REPLACE FUNCTION signing.restrict_api_intents() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind NOT IN ('MAKER_QUOTE','MINT')
     AND pg_has_role(current_user, 'blink_api', 'member')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'blink_api may create MAKER_QUOTE and MINT intents only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION signing.restrict_sign_requests() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_kind TEXT; intent_role TEXT;
BEGIN
  SELECT kind, role INTO intent_kind, intent_role FROM signing.economic_intents WHERE id = NEW.intent_id;
  IF intent_role IS DISTINCT FROM NEW.role THEN
    RAISE EXCEPTION 'sign request role must match the intent role' USING ERRCODE = '42501';
  END IF;
  IF pg_has_role(current_user, 'blink_api', 'member')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND (intent_kind NOT IN ('MAKER_QUOTE','MINT') OR NEW.artifact_version <> 1) THEN
    RAISE EXCEPTION 'blink_api may request first-version quotes and mints only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

GRANT USAGE ON SCHEMA markets TO blink_worker;
GRANT SELECT (id, manifest, market_address, enabled) ON markets.deployments TO blink_worker;
-- Allows the worker to serialize cancellation against the signer without editing request payloads.
GRANT UPDATE (updated_at) ON signing.sign_requests TO blink_worker;
