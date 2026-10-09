CREATE TABLE chain.creation_tracking_schedule (
  intent_id UUID PRIMARY KEY REFERENCES chain.creation_projections(intent_id),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt>=0),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  lease_token BIGINT NOT NULL DEFAULT 0 CHECK (lease_token>=0),
  last_error_code TEXT,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX creation_tracking_due
  ON chain.creation_tracking_schedule(next_run_at,intent_id);
CREATE INDEX creation_tracking_leases
  ON chain.creation_tracking_schedule(lease_until)
  WHERE lease_until IS NOT NULL;

INSERT INTO chain.creation_tracking_schedule(intent_id)
SELECT intent_id FROM chain.creation_projections
WHERE payload->>'txHash' IS NOT NULL
ON CONFLICT DO NOTHING;

REVOKE ALL ON chain.creation_tracking_schedule FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON chain.creation_tracking_schedule TO blink_indexer;
