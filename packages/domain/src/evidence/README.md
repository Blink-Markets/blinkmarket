# Data and evidence

Responsibility: Source fetching, bytes that cannot be overwritten, hashes and public permissions.

Data ownership: evidence / source_allowlists

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/evidence/` and external adapters in `packages/adapters/src/evidence/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
