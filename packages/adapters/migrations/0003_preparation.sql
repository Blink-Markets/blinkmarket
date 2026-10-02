CREATE SCHEMA evidence;
CREATE SCHEMA discovery;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='blink_evidence_admin') THEN
    CREATE ROLE blink_evidence_admin NOLOGIN;
  END IF;
END $$;

CREATE TABLE evidence.sources (
  id UUID PRIMARY KEY,
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 4000),
  source_url TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  lock_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE evidence.records (
  id UUID PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES evidence.sources(id),
  operator_id UUID NOT NULL REFERENCES identity.operators(id),
  content_hash blink.hash NOT NULL,
  object_uri TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at TIMESTAMPTZ,
  access_policy TEXT NOT NULL CHECK (access_policy IN ('PUBLIC','EXCERPT','PRIVATE')),
  excerpt TEXT CHECK (length(excerpt) <= 4000),
  CHECK (access_policy <> 'EXCERPT' OR length(trim(excerpt)) > 0 AND excerpt IS NOT NULL),
  CHECK (published_at IS NULL OR published_at <= observed_at)
);
CREATE TABLE discovery.candidates (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES identity.operators(id),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE discovery.candidate_revisions (
  candidate_id UUID NOT NULL REFERENCES discovery.candidates(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(candidate_id,revision),
  CHECK (snapshot->>'candidateId'=candidate_id::text AND (snapshot->>'revision')::integer=revision),
  CHECK (snapshot->>'state' IN ('DRAFT','VALIDATING','NEEDS_REVISION','REJECTED','APPROVED','DEPLOY_PENDING','DEPLOYED'))
);
ALTER TABLE discovery.candidates ADD CONSTRAINT current_revision_exists
  FOREIGN KEY (id,current_revision) REFERENCES discovery.candidate_revisions(candidate_id,revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE discovery.candidate_evidence (
  candidate_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  evidence_id UUID NOT NULL REFERENCES evidence.records(id),
  PRIMARY KEY(candidate_id,revision,evidence_id),
  FOREIGN KEY(candidate_id,revision) REFERENCES discovery.candidate_revisions(candidate_id,revision)
);
CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON evidence.records
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();
CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON discovery.candidate_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();
CREATE TRIGGER links_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON discovery.candidate_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation();

REVOKE ALL ON SCHEMA evidence,discovery FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA evidence,discovery FROM PUBLIC;
GRANT USAGE ON SCHEMA evidence,discovery TO blink_api;
GRANT SELECT ON evidence.sources,evidence.records TO blink_api;
-- PostgreSQL requires UPDATE on at least one column for SELECT FOR SHARE.
-- This grants locking without allowing the API to alter source policy.
GRANT UPDATE(lock_version) ON evidence.sources TO blink_api;
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA discovery TO blink_api;
GRANT UPDATE(current_revision) ON discovery.candidates TO blink_api;
GRANT USAGE ON SCHEMA blink,operations,evidence TO blink_evidence_admin;
GRANT SELECT,INSERT ON evidence.sources,evidence.records TO blink_evidence_admin;
GRANT UPDATE(enabled) ON evidence.sources TO blink_evidence_admin;
GRANT INSERT ON operations.audit_log TO blink_evidence_admin;
