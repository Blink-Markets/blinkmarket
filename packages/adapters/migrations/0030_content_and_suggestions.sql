-- P2: hash-addressed content (spec and evidence bytes) and the public human suggestion queue.
-- Bytes live in the immutable object store under their keccak256; only metadata is kept here.
-- A suggestion carries no on-chain right and no write access: nothing below is ever updated.

CREATE SCHEMA content;
CREATE SCHEMA suggestions;

CREATE TABLE content.objects (
  hash blink.hash PRIMARY KEY,
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 1048576),
  media_type TEXT NOT NULL
    CHECK (media_type IN ('application/json','text/plain','text/csv','text/html','application/pdf')),
  uploader blink.address NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE suggestions.items (
  -- seq orders the queue and is the paging cursor; id is the public identifier.
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id UUID PRIMARY KEY,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 20 AND 2000),
  source_urls TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_urls) <= 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Informational only: a claim gives no exclusivity, and one creator claims a suggestion once.
CREATE TABLE suggestions.claims (
  suggestion_id UUID NOT NULL REFERENCES suggestions.items(id),
  creator blink.address NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (suggestion_id, creator)
);

-- A spec that names a suggestion id. Whether a market exists for spec_hash is read from the index.
CREATE TABLE suggestions.spec_links (
  spec_hash blink.hash NOT NULL,
  suggestion_id UUID NOT NULL REFERENCES suggestions.items(id),
  linked_by blink.address NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (spec_hash, suggestion_id)
);
CREATE INDEX spec_links_by_suggestion ON suggestions.spec_links (suggestion_id);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['content.objects','suggestions.items','suggestions.claims','suggestions.spec_links'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation()', t);
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA content, suggestions FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA content, suggestions FROM PUBLIC;
GRANT USAGE ON SCHEMA content, suggestions TO blink_api;
GRANT SELECT, INSERT ON content.objects, suggestions.items, suggestions.claims, suggestions.spec_links TO blink_api;

-- The offline evidence CLI is gone: drop its role after revoking every grant.
REVOKE ALL ON evidence.sources, evidence.records FROM blink_evidence_admin;
REVOKE ALL ON operations.audit_log FROM blink_evidence_admin;
REVOKE ALL ON SCHEMA evidence, blink, operations FROM blink_evidence_admin;
DROP ROLE blink_evidence_admin;

-- Spec archive rows belonged to the retired approval flow; its only referencing table went in 0026.
-- (evidence.sources and evidence.records stay until the forecast rework replaces evidence ids.)
DROP TABLE markets.specs;
