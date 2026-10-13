-- TEMPORARY (controller removes at merge once 0007_chain_index lands): same definition as 0007.
CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
  SELECT clock_timestamp() + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds', true), ''), '0')::double precision)
$$;
GRANT EXECUTE ON FUNCTION blink.now() TO blink_api, blink_worker, blink_indexer, blink_signer;

-- Reviewed fetch policy per source. Fetching stays off until an evidence admin enables it.
ALTER TABLE evidence.sources
  ADD COLUMN fetch_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN allowed_mime TEXT[] NOT NULL DEFAULT ARRAY['text/html','application/pdf','text/plain'],
  ADD COLUMN redirect_prefixes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN fetch_access_policy TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (fetch_access_policy IN ('PUBLIC','PRIVATE'));

CREATE TABLE evidence.fetch_attempts (
  id UUID PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES evidence.sources(id),
  job_id UUID,
  state TEXT NOT NULL CHECK (state IN ('SUCCEEDED','FAILED','MANUAL')),
  error_code TEXT,
  evidence_id UUID REFERENCES evidence.records(id),
  final_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER fetch_attempts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON evidence.fetch_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();

REVOKE ALL ON evidence.fetch_attempts FROM PUBLIC;
GRANT USAGE ON SCHEMA evidence TO blink_worker;
GRANT SELECT ON evidence.sources TO blink_worker;
GRANT SELECT,INSERT ON evidence.records,evidence.fetch_attempts TO blink_worker;
GRANT UPDATE(fetch_enabled,allowed_mime,redirect_prefixes,fetch_access_policy) ON evidence.sources TO blink_evidence_admin;
