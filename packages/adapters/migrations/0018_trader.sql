-- Internal trader (spec 9.3, 12.3): one mandate per trading agent, and the conservative risk it
-- occupies from the moment a buy is decided until the fill is on the canonical chain or the buy
-- definitively failed. Money here is bUSD micros and is never added to USD or gas amounts.
CREATE TABLE trading.mandates (
  agent_id UUID PRIMARY KEY REFERENCES identity.agents(id),
  wallet blink.address NOT NULL UNIQUE,
  forecaster_role TEXT NOT NULL CHECK (forecaster_role IN ('FORECASTER_A','FORECASTER_B')),
  daily_notional_cap_micros blink.uint256 NOT NULL DEFAULT 100000000,
  open_notional_cap_micros blink.uint256 NOT NULL DEFAULT 500000000,
  max_fill_shares INTEGER NOT NULL DEFAULT 20 CHECK (max_fill_shares BETWEEN 1 AND 100),
  shares_per_trade INTEGER NOT NULL DEFAULT 10 CHECK (shares_per_trade BETWEEN 1 AND 100),
  edge_threshold_bps INTEGER NOT NULL DEFAULT 500 CHECK (edge_threshold_bps BETWEEN 0 AND 10000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128)
);

-- intent_id names one buy (agent, market, forecast window): the same window is never bought twice.
-- notional_micros is the maximum payout of the shares (shares * 1e6), not the price paid. HELD is
-- pending, in flight or INCLUDED; ACCOUNTED is a fill the canonical projection shows; RELEASED is a
-- definitive failure (a revert, a rejection, or expiry by block time without a fill).
CREATE TABLE trading.risk_reservations (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES trading.mandates(agent_id),
  intent_id UUID NOT NULL UNIQUE,
  day DATE NOT NULL,
  notional_micros blink.uint256 NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('HELD','ACCOUNTED','RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(),
  -- What the buy is, so a restarted worker can carry it on without the decision being repeated.
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  market_id blink.uint256 NOT NULL CHECK (market_id > 0),
  window_id UUID NOT NULL REFERENCES forecasts.windows(id),
  side TEXT NOT NULL CHECK (side IN ('YES','NO')),
  shares INTEGER NOT NULL CHECK (shares BETWEEN 1 AND 100),
  ask_bps INTEGER NOT NULL CHECK (ask_bps BETWEEN 1 AND 9999),
  own_probability_millionths INTEGER NOT NULL CHECK (own_probability_millionths BETWEEN 0 AND 1000000),
  release_reason TEXT CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 200),
  CHECK (notional_micros = shares::numeric * 1000000),
  CHECK ((state = 'RELEASED') = (release_reason IS NOT NULL))
);
CREATE INDEX risk_reservations_agent_day ON trading.risk_reservations (agent_id, day, state);
CREATE INDEX risk_reservations_held ON trading.risk_reservations (agent_id) WHERE state = 'HELD';

-- A reservation only ever moves HELD -> ACCOUNTED, HELD -> RELEASED, or back ACCOUNTED -> HELD
-- (the fill's block was reorged away). RELEASED is final: capacity once given back is not retaken.
CREATE FUNCTION trading.guard_risk_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.state, NEW.state) NOT IN (('HELD','HELD'),('HELD','ACCOUNTED'),('HELD','RELEASED'),('ACCOUNTED','ACCOUNTED'),('ACCOUNTED','HELD')) THEN
    RAISE EXCEPTION 'illegal risk reservation transition % -> %', OLD.state, NEW.state USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_reservations_transition BEFORE UPDATE ON trading.risk_reservations
  FOR EACH ROW EXECUTE FUNCTION trading.guard_risk_reservation();

REVOKE ALL ON trading.mandates, trading.risk_reservations FROM PUBLIC;
-- Mandates are set by the database owner; the worker only reads them and cannot widen its own limits.
GRANT SELECT ON trading.mandates TO blink_worker;
GRANT SELECT, INSERT ON trading.risk_reservations TO blink_worker;
GRANT UPDATE (state, release_reason, updated_at) ON trading.risk_reservations TO blink_worker;

-- What the trader reads to decide. The operator's quote gates, and the platform forecasters' answers
-- of the latest closed window per market (the same rule the RFQ's snapshot uses: closed within 24
-- hours, both answered, none annotated). The worker still has no grant on forecasts.submissions: the
-- view runs with its owner's rights and shows nothing from a window before its deadline, so the
-- forecasters that run in the same process cannot read each other's open answers through it.
GRANT SELECT ON trading.quote_gates TO blink_worker;
CREATE VIEW trading.trader_snapshots WITH (security_barrier) AS
SELECT DISTINCT ON (w.deployment_id, w.market_id)
  w.deployment_id, w.market_id, w.id AS window_id, a.probability AS a_probability, b.probability AS b_probability
FROM forecasts.windows w
JOIN forecasts.platform_agents pa ON pa.role = 'FORECASTER_A'
JOIN forecasts.platform_agents pb ON pb.role = 'FORECASTER_B'
JOIN forecasts.submissions a ON a.window_id = w.id AND a.agent_id = pa.agent_id
JOIN forecasts.submissions b ON b.window_id = w.id AND b.agent_id = pb.agent_id
WHERE w.deadline <= blink.now() AND w.deadline >= blink.now() - interval '24 hours'
  AND NOT EXISTS (SELECT 1 FROM forecasts.annotations n WHERE n.submission_id IN (a.id, b.id))
ORDER BY w.deployment_id, w.market_id, w.deadline DESC, w.horizon_type, w.id;
REVOKE ALL ON trading.trader_snapshots FROM PUBLIC;
GRANT SELECT ON trading.trader_snapshots TO blink_worker;

-- Which forecast window a quote's snapshot was made from, so the trader can refuse a quote priced
-- from a different window than the one it decided on. Snapshots exist only for closed windows.
CREATE VIEW trading.trader_snapshot_windows WITH (security_barrier) AS
SELECT id AS snapshot_id, window_id FROM forecasts.snapshots;
REVOKE ALL ON trading.trader_snapshot_windows FROM PUBLIC;
GRANT SELECT ON trading.trader_snapshot_windows TO blink_worker;
