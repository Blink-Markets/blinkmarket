# Candidate research

Responsibility: Scanning, GM_LT_V1, validation, revision and manual review.

Data ownership: candidates / candidate_revisions

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/discovery/` and external adapters in `packages/adapters/src/discovery/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
