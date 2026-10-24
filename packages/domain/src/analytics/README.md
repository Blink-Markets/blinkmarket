# Quality and statistics

Responsibility: Brier score, missing rate, cost and adoption statistics; INVALID scores are excluded.

Data ownership: evaluation_runs / score_entries

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/analytics/` and external adapters in `packages/adapters/src/analytics/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
