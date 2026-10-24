# RFQ and trading policy

Responsibility: Quotes, fund reservations and mandates; external takers are not custodied.

Data ownership: rfqs / quotes / collateral_reservations / mandates / risk_reservations

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/trading/` and external adapters in `packages/adapters/src/trading/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
