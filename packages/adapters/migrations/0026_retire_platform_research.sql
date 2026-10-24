-- P2: retire platform research, approval and creation tracking. Historical migrations stay intact.
-- Agents create markets, forecast and resolve through the protocol; the platform keeps no such role.

-- Fence any old lease as well as retiring queued work. The column is last_error_code here.
UPDATE operations.jobs
SET state='DEAD', last_error_code='RETIRED_P2', finished_at=blink.now(),
    lease_owner=NULL, lease_until=NULL, lease_token=lease_token+1
WHERE state IN ('QUEUED','LEASED') AND
  (type IN ('evidence.fetch','candidate.validate','market.deploy','forecast.dispatch','forecast.run',
            'baseline.run','budget.reconcile','resolution.parse','resolution.alerts')
   OR type LIKE 'discovery.%');
-- Research budgets no longer exist, so their alert episodes must not linger in the alert stream.
DELETE FROM operations.alert_episodes WHERE family='budget';

-- The scoring view joined the platform agents only to label their rows; scoring is per submission now.
DROP VIEW analytics.final_forecasts;
CREATE VIEW analytics.final_forecasts WITH (security_barrier=true) AS
SELECT w.id AS window_id,w.deployment_id,w.market_id::text AS market_id,m.mode,m.final_outcome AS outcome,
  s.agent_id,(s.probability*1000000)::integer AS probability_millionths,
  EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id AND a.kind='WITHDRAWN') AS withdrawn,
  EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id) AS contaminated
FROM forecasts.windows w
JOIN chain.markets m USING(deployment_id,market_id)
LEFT JOIN forecasts.submissions s ON s.window_id=w.id
WHERE m.state='FINAL' AND m.final_outcome IS NOT NULL;
REVOKE ALL ON analytics.final_forecasts FROM PUBLIC;
GRANT SELECT ON analytics.final_forecasts TO blink_worker;

-- The worker no longer fetches evidence or parses resolutions.
REVOKE ALL ON evidence.sources, evidence.records FROM blink_worker;
REVOKE ALL ON SCHEMA evidence FROM blink_worker;

-- Creation tracking, children before parents.
DROP TABLE chain.creation_tracking_schedule;
DROP TABLE chain.creation_observations;
DROP TABLE chain.creation_projections;
DROP TABLE markets.active_slots;
DROP TABLE markets.creation_intents;
DROP TABLE markets.approvals;

-- Candidates: the deferred current-revision foreign key goes first, then children before parents.
ALTER TABLE discovery.candidates DROP CONSTRAINT current_revision_exists;
DROP TABLE discovery.scan_runs;
DROP TABLE discovery.daily_counters;
DROP TABLE discovery.candidate_evidence;
DROP TABLE discovery.candidate_revisions;
DROP TABLE discovery.candidates;
DROP SCHEMA discovery;

-- Research budgets.
DROP TABLE budgets.cost_entries;
DROP TABLE budgets.reservations;
DROP TABLE budgets.questions;
DROP TABLE budgets.daily;
DROP SCHEMA budgets;

-- Platform forecasters, snapshots and model runs.
DROP TABLE forecasts.pending_answers;
DROP TABLE forecasts.model_runs;
DROP TABLE forecasts.snapshots;
DROP TABLE forecasts.platform_agents;

-- Resolution reports, suggestions and alerts.
DROP TABLE resolution.report_events;
DROP TABLE resolution.reports;
DROP TABLE resolution.suggestions;
DROP TABLE resolution.alerts_sent;

-- Evidence fetch bookkeeping.
DROP TABLE evidence.fetch_attempts;
