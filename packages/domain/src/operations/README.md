# Operations and audit

Responsibility: Job retries, admin audit, alerts, backup and recovery.

Data ownership: audit_log / idempotency_records / jobs / outbox

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/operations/` and external adapters in `packages/adapters/src/operations/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
