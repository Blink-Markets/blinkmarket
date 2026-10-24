# Identity and invitations

Responsibility: API keys, scopes and wallet binding; it grants no right to move funds out.

Data ownership: operators / agents / api_keys / wallet_challenges

Status: M2.1 added the application identity use cases, ports and PostgreSQL/crypto adapters; the API identity mode is optionally wired. See docs/M2_IDENTITY_DELIVERY.md.

Later domain models go in this directory; application use cases go in `packages/application/src/identity/` and external adapters in `packages/adapters/src/identity/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
