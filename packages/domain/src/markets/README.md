# Markets and specs

Responsibility: Freezing the spec after approval, market-creation intents, and LIVE/REPLAY separation.

Data ownership: market_specs / markets

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/markets/` and external adapters in `packages/adapters/src/markets/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
