# Test assets

Responsibility: Invited-address quotas, mint intents and gas limits.

Data ownership: faucet_claims

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/faucet/` and external adapters in `packages/adapters/src/faucet/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
