# On-chain tracking and projection

Responsibility: Canonical events, reorg rollback, reconciliation and transaction status.

Data ownership: deployments / chain_transactions / chain_blocks / chain_events / positions_projection / chain_cursors

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/chain/` and external adapters in `packages/adapters/src/chain/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
