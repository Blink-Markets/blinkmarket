-- alert.evaluate gains an informational family: a FINAL market whose fees nobody distributed a day
-- after it finalized. The platform cannot act on it (anyone may call distributeFees), so it only
-- informs. The episode vocabulary is closed, so the family list is widened here; no row changes.
ALTER TABLE operations.alert_episodes DROP CONSTRAINT alert_episodes_family_check;
ALTER TABLE operations.alert_episodes ADD CONSTRAINT alert_episodes_family_check
  CHECK (family IN ('budget','pause','rpc','indexer_lag','keeper_overdue','jobs_dead','fees_undistributed'));
