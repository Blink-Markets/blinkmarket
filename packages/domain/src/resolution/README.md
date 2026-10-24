# Outcomes and disputes

Responsibility: Evidence reports, the manual ruling flow and keeper scheduling; the chain is authoritative for outcomes.

Data ownership: resolution_reports / resolution_actions

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/resolution/` and external adapters in `packages/adapters/src/resolution/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
