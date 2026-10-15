-- A stable receipt observation time: updated_at also changes on finalization and retries.
-- Existing receipts have no trustworthy observation time and stay out of latency samples.
ALTER TABLE signing.tx_attempts ADD COLUMN included_at TIMESTAMPTZ;
CREATE FUNCTION signing.observe_inclusion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('REORGED','SIGNED','SUBMITTED','UNKNOWN','REPLACED') THEN
    NEW.included_at := NULL;
  ELSIF NEW.status IN ('INCLUDED','FINALIZED','REVERTED') AND
    (TG_OP = 'INSERT' OR OLD.status NOT IN ('INCLUDED','FINALIZED','REVERTED') OR
     OLD.receipt_block_hash IS DISTINCT FROM NEW.receipt_block_hash) THEN
    NEW.included_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tx_attempt_inclusion BEFORE INSERT OR UPDATE ON signing.tx_attempts
  FOR EACH ROW EXECUTE FUNCTION signing.observe_inclusion();
GRANT SELECT (status, submitted_at, included_at) ON signing.tx_attempts TO blink_api;
GRANT SELECT ON signing.gas_spend TO blink_api;
