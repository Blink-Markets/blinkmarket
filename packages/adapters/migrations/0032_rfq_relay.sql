-- P2: the RFQ relay and protocol transaction tracking.
-- The platform only relays: an RFQ and a maker-signed quote are stored exactly as received and are
-- never priced, signed or filled here. State lives in PostgreSQL, so every API instance sees the
-- same RFQs. Times are unix seconds (the relay's clock), not database timestamps.

CREATE SCHEMA rfq;

CREATE TABLE rfq.requests (
  -- seq orders the open list and is its paging cursor; id is the public identifier.
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
  taker blink.address NOT NULL,
  market_id blink.uint256 NOT NULL,
  spec_hash blink.hash NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES','NO')),
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  expires_at BIGINT NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX requests_open ON rfq.requests (deployment_id, expires_at);
CREATE INDEX requests_taker ON rfq.requests (deployment_id, taker, expires_at);

CREATE TABLE rfq.quotes (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  rfq_id UUID NOT NULL REFERENCES rfq.requests(id),
  deployment_id TEXT NOT NULL REFERENCES markets.protocol_deployments(deployment_id),
  maker blink.address NOT NULL,
  -- The EIP-712 digest, matched against QuoteFilled and QuoteCancelled for the maker stats.
  digest blink.hash NOT NULL,
  price_bps INTEGER NOT NULL CHECK (price_bps BETWEEN 1 AND 9999),
  expires_at BIGINT NOT NULL CHECK (expires_at >= 0),
  -- The posted fields as JSON text and the signature as sent: returned unchanged.
  quote TEXT NOT NULL CHECK (char_length(quote) BETWEEN 2 AND 2048),
  signature TEXT NOT NULL
    CHECK (signature ~ '^0x[0-9a-fA-F]+$' AND char_length(signature) % 2 = 0 AND char_length(signature) BETWEEN 4 AND 16386),
  received_at BIGINT NOT NULL CHECK (received_at >= 0),
  -- One quote per maker per RFQ.
  PRIMARY KEY (rfq_id, maker)
);
CREATE INDEX quotes_by_price ON rfq.quotes (rfq_id, price_bps, seq);
CREATE INDEX quotes_by_digest ON rfq.quotes (deployment_id, digest);
CREATE INDEX quotes_by_maker ON rfq.quotes (deployment_id, maker);

-- Fills and cancels are matched to relayed quotes by digest.
CREATE INDEX protocol_events_quote_digest ON protocol.events (deployment_id, (lower(args->>'digest')))
  WHERE name IN ('QuoteFilled','QuoteCancelled');

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['rfq.requests','rfq.quotes'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION operations.reject_mutation()', t);
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA rfq FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA rfq FROM PUBLIC;
GRANT USAGE ON SCHEMA rfq TO blink_api;
GRANT SELECT, INSERT ON rfq.requests, rfq.quotes TO blink_api;

-- Transaction tracking moves from the v0.1 market contract to the protocol generation. The hint
-- is now just a hash: the tracker decodes the function name from the protocol ABI and checks the
-- sender and target. v0.1 hints belong to a deployment that no longer exists (no production
-- database was ever deployed), so they are removed.
DELETE FROM chain.transactions;
ALTER TABLE chain.transactions DROP CONSTRAINT transactions_deployment_id_fkey;
ALTER TABLE chain.transactions ADD CONSTRAINT transactions_protocol_deployment_fkey
  FOREIGN KEY (deployment_id) REFERENCES markets.protocol_deployments(deployment_id);
ALTER TABLE chain.transactions DROP CONSTRAINT transactions_action_check;
-- Also drops the FILL-needs-quote check, which names this column.
ALTER TABLE chain.transactions DROP COLUMN quote_id;
-- Unknown until the tracker has decoded the transaction.
ALTER TABLE chain.transactions ALTER COLUMN action DROP NOT NULL;
ALTER TABLE chain.transactions ADD CONSTRAINT transactions_action_name
  CHECK (action IS NULL OR action ~ '^[A-Za-z][A-Za-z0-9]{0,63}$');
GRANT UPDATE (action) ON chain.transactions TO blink_indexer;
