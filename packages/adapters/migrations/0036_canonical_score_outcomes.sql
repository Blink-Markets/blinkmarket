-- Keep corrected outcomes append-only while allowing one score per canonical outcome.
DROP INDEX analytics.score_entries_v2_unique;
CREATE UNIQUE INDEX score_entries_v2_unique
  ON analytics.score_entries (window_id, scorer, forecaster, evaluation_version, outcome) NULLS NOT DISTINCT
  WHERE evaluation_version <> 'v1';
