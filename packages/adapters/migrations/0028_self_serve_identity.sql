-- P2: self-serve identity. An identity is a wallet address; it proves control with a signature and
-- receives an API key. No person manages identity.operators, which stays a one-to-one container of
-- the agent so existing foreign keys keep working.

-- The three new scopes join the legacy ones. Legacy scopes stay allowed only so already-issued
-- (now revoked) rows and the remaining operator-status checks stay valid; the issuing function
-- below hardcodes the four self-serve scopes.
ALTER TABLE identity.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE identity.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) > 0 AND array_position(scopes, NULL) IS NULL AND
  scopes <@ ARRAY['candidate:write','forecast:write','trade:quote','report:write','faucet:claim','admin',
                  'rfq:write','content:write','suggestion:claim']::TEXT[]
);

-- Challenges now exist before any agent or key does. 'bind' is the retired invite-only flow.
ALTER TABLE identity.wallet_challenges ALTER COLUMN key_id DROP NOT NULL;
ALTER TABLE identity.wallet_challenges ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE identity.wallet_challenges
  ADD COLUMN action TEXT NOT NULL DEFAULT 'bind' CHECK (action IN ('bind','issue','revoke'));
ALTER TABLE identity.wallet_challenges ALTER COLUMN action DROP DEFAULT;
ALTER TABLE identity.wallet_challenges ADD COLUMN target_key_id UUID;
-- Verification attempts spent so far; the application stops accepting attempts at its budget.
ALTER TABLE identity.wallet_challenges ADD COLUMN attempts SMALLINT NOT NULL DEFAULT 0;
-- The trusted client IP that asked. The pending-challenge cap is per (address, client IP), so
-- nobody can use up an address's slots without being the same client.
ALTER TABLE identity.wallet_challenges ADD COLUMN client_ip TEXT;
ALTER TABLE identity.wallet_challenges
  ADD CONSTRAINT wallet_challenges_target_matches_action CHECK ((action = 'revoke') = (target_key_id IS NOT NULL));
CREATE INDEX wallet_challenges_pending_by_address ON identity.wallet_challenges(address, client_ip, expires_at)
  WHERE consumed_at IS NULL;

-- Retire every invite key. Self-serve keys do not exist yet, so all active keys are invite keys.
UPDATE identity.api_keys SET revoked_at = now() WHERE revoked_at IS NULL;

-- Bindings and consumption now happen only inside the functions below.
REVOKE INSERT ON identity.wallet_bindings FROM blink_api;
REVOKE UPDATE (consumed_at) ON identity.wallet_challenges FROM blink_api;
GRANT UPDATE (attempts) ON identity.wallet_challenges TO blink_api;

-- Result columns are prefixed so they cannot shadow table columns inside the bodies.
CREATE FUNCTION identity.issue_self_serve_key(
  p_challenge_id UUID, p_key_id UUID, p_secret_hash BYTEA,
  p_operator_id UUID, p_agent_id UUID, p_request_id TEXT)
RETURNS TABLE (out_status TEXT, out_key_id UUID, out_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c identity.wallet_challenges%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_agent UUID;
  v_operator UUID;
  v_new BOOLEAN := false;
  v_expires TIMESTAMPTZ;
  v_name TEXT;
BEGIN
  -- The row lock makes concurrent verifications of one challenge issue exactly one key.
  SELECT * INTO c FROM identity.wallet_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR c.action <> 'issue' THEN
    RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  IF c.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'USED'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  -- Waiting for a lock must not extend the challenge: the clock is read again after every wait.
  v_now := clock_timestamp();
  IF c.expires_at <= v_now THEN
    RETURN QUERY SELECT 'EXPIRED'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  v_name := '0x' || encode(c.address, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('identity.wallet:' || v_name, 0));
  -- The last blocking wait is over: this read of the clock precedes every write, so no
  -- non-OK result is ever returned after the operator, agent or key rows are written.
  v_now := clock_timestamp();
  IF c.expires_at <= v_now THEN
    RETURN QUERY SELECT 'EXPIRED'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  SELECT b.agent_id INTO v_agent FROM identity.wallet_bindings b
    WHERE b.chain_id = 84532 AND b.address = c.address;
  IF v_agent IS NULL THEN
    v_new := true;
    v_agent := p_agent_id;
    v_operator := p_operator_id;
    INSERT INTO identity.operators (id, name) VALUES (v_operator, v_name);
    INSERT INTO identity.agents (id, operator_id, name) VALUES (v_agent, v_operator, v_name);
  ELSE
    SELECT a.operator_id INTO v_operator FROM identity.agents a WHERE a.id = v_agent;
    IF (SELECT count(*) FROM identity.api_keys k
        WHERE k.agent_id = v_agent AND k.revoked_at IS NULL AND k.expires_at > v_now) >= 5 THEN
      RETURN QUERY SELECT 'KEY_LIMIT'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
    END IF;
  END IF;
  v_expires := v_now + interval '30 days';
  INSERT INTO identity.api_keys (id, operator_id, agent_id, secret_hash, scopes, expires_at)
    VALUES (p_key_id, v_operator, v_agent, p_secret_hash,
            ARRAY['forecast:write','rfq:write','content:write','suggestion:claim']::TEXT[], v_expires);
  UPDATE identity.wallet_challenges
    SET agent_id = v_agent, key_id = p_key_id, consumed_at = v_now WHERE id = c.id;
  IF v_new THEN
    INSERT INTO identity.wallet_bindings (agent_id, chain_id, address, challenge_id)
      VALUES (v_agent, 84532, c.address, c.id);
  END IF;
  INSERT INTO operations.audit_log (id, actor, action, resource, reason, request_id)
    VALUES (gen_random_uuid(), v_name, 'identity.key_issued', p_key_id::TEXT,
            'Self-serve key issued by wallet proof', p_request_id);
  RETURN QUERY SELECT 'OK'::TEXT, p_key_id, v_expires;
END $$;

CREATE FUNCTION identity.revoke_self_serve_key(p_challenge_id UUID, p_request_id TEXT)
RETURNS TABLE (out_status TEXT, out_key_id UUID, out_revoked_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c identity.wallet_challenges%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_agent UUID;
  v_revoked TIMESTAMPTZ;
  v_name TEXT;
BEGIN
  SELECT * INTO c FROM identity.wallet_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR c.action <> 'revoke' THEN
    RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  IF c.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'USED'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  v_now := clock_timestamp();
  IF c.expires_at <= v_now THEN
    RETURN QUERY SELECT 'EXPIRED'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  v_name := '0x' || encode(c.address, 'hex');
  SELECT b.agent_id INTO v_agent FROM identity.wallet_bindings b
    WHERE b.chain_id = 84532 AND b.address = c.address;
  IF v_agent IS NULL THEN
    RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  -- Only a key of the agent bound to the signing address can be revoked by that address.
  PERFORM 1 FROM identity.api_keys k
    WHERE k.id = c.target_key_id AND k.agent_id = v_agent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  -- The key row lock may have been a wait: read the clock again before revoking.
  v_now := clock_timestamp();
  IF c.expires_at <= v_now THEN
    RETURN QUERY SELECT 'EXPIRED'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  UPDATE identity.api_keys k SET revoked_at = COALESCE(k.revoked_at, v_now)
    WHERE k.id = c.target_key_id AND k.agent_id = v_agent
    RETURNING k.revoked_at INTO v_revoked;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  UPDATE identity.wallet_challenges SET agent_id = v_agent, consumed_at = v_now WHERE id = c.id;
  INSERT INTO operations.audit_log (id, actor, action, resource, reason, request_id)
    VALUES (gen_random_uuid(), v_name, 'identity.key_revoked', c.target_key_id::TEXT,
            'Self-serve key revoked by wallet proof', p_request_id);
  RETURN QUERY SELECT 'OK'::TEXT, c.target_key_id, v_revoked;
END $$;

REVOKE ALL ON FUNCTION identity.issue_self_serve_key(UUID, UUID, BYTEA, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.revoke_self_serve_key(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.issue_self_serve_key(UUID, UUID, BYTEA, UUID, UUID, TEXT) TO blink_api;
GRANT EXECUTE ON FUNCTION identity.revoke_self_serve_key(UUID, TEXT) TO blink_api;

-- No operator console remains: drop the identity administration role after revoking its grants.
REVOKE ALL ON identity.operators, identity.agents, identity.api_keys FROM blink_identity_admin;
REVOKE ALL ON operations.audit_log FROM blink_identity_admin;
REVOKE ALL ON SCHEMA identity, blink, operations FROM blink_identity_admin;
DROP ROLE blink_identity_admin;
