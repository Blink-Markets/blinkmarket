---
title: Status
description: What Blink can do locally today, what is still planned, and where the delivery records live.
group: Reference
order: 2
agentTask: check whether a Blink capability exists before relying on it
---

# Status

Blink is an experiment on Base Sepolia (chain ID 84532) with a valueless test token, bUSD. This page separates what runs locally from what is planned. Milestones are taken from `docs/ROADMAP.md`.

> [!PLANNED]
> There is no Sepolia deployment, no trading and no public API. Status: Planned.

## Where is each milestone?

| Milestone | Status | Outcome or next step |
| --- | --- | --- |
| M0 Engineering and contracts | Implemented, verified locally | Schemas, v0.1.1 specification bytes and hash, manifest, ports, database foundation migration, OpenAPI and client, CI |
| M1 Ledger and settlement | Implemented, verified locally | TestUSD and Market contracts, EIP-712, caps, full settlement and redemption, 24 contract tests and invariants (three takers, two markets), three REPLAY scenarios |
| M2 Core vertical flow | In progress: approval and single market-creation tracking implemented | Identity, evidence, approval, unsigned creation intents, and operator-triggered MarketCreated, confirmation and reorg observation. Still to connect: continuous indexer, replacement tracking, reservation and RFQ, signer |
| M3 Agent | Not started | Allowlisted fetch, discovery, two forecasters and a baseline, cost tracking, mandates, operations jobs |
| M4 Product interface | In progress: read-only showcase | Seven page types, wallet, limited approve, separate price and research probability, error states |
| M5 Sepolia Alpha | Not started | Real roles and manifest, forward-looking questions, RPC and backup drills, external user acceptance |

Local contract tests and REPLAY runs are not a public deployment and not a security audit.

## What works locally today?

The API starts in the mode set by `BLINK_API_MODE`: `scaffold` (default), `identity`, `preparation` or `approval`. Each mode adds endpoints on top of the previous ones. Every mode serves `GET /v1/config`, which reports Base Sepolia, no deployment and trading disabled.

| Status word | Endpoints |
| --- | --- |
| `Identity mode` | `/v1/auth/wallet-challenges`, `/v1/auth/wallet-verifications` |
| `Preparation mode` | `/v1/candidates`, `/v1/candidates/:id`, `/v1/candidates/:id/revisions`, `/v1/admin/candidates/:id/reject`, `/v1/evidence/:id` |
| `Approval mode` | `/v1/admin/candidates/:id/approve`, `/v1/admin/creation-intents/:id`, `/v1/specs/:specHash`, `/v1/admin/creation-intents/:id/chain-status` |
| `Planned` | Everything else in the [API reference](/docs/api), including markets, forecasts, RFQs, quotes, transactions, positions, resolution, faucet and metrics |

> [!NOTE]
> The scaffold mode needs no database, RPC endpoint, model API key, wallet or `.env` file. The identity, preparation and approval modes are opt-in and use PostgreSQL.

Other things that run locally:

- Smart contract tests and REPLAY scenarios (M1).
- An operator-triggered tool that verifies a MarketCreated receipt, records confirmation counts (12 confirmations is a fixed observation policy, not Base L1 finality) and withdraws a result after a reorg. It sends no transactions and accepts no private key.
- A read-only web showcase. It has no trading UI.

## What is not available?

> [!PLANNED]
> No Sepolia deployment. Status: Planned.

> [!PLANNED]
> No trading: `tradingEnabled` is false and there is no RFQ, signer or fill path. Status: Planned.

> [!PLANNED]
> No public API host. The API only runs on `http://127.0.0.1:3001`. Status: Planned.

Also not built: continuous indexing (the indexer, worker and signer processes answer a liveness check only; nothing polls automatically), research automation and the product UI beyond the showcase.

## Where are the delivery records?

Each slice has a delivery document in the repository. Paths, relative to the repository root:

- `docs/ROADMAP.md`
- `docs/M0_M1_DELIVERY.md`
- `docs/M2_IDENTITY_DELIVERY.md`
- `docs/M2_PREPARATION_DELIVERY.md`
- `docs/M2_APPROVAL_DELIVERY.md`
- `docs/M2_CREATION_TRACKING.md`
- `docs/M4_WEB_SHOWCASE_DELIVERY.md`
- `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md`

Most of these are written in Traditional Chinese.

## Hand it to your agent

```prompt
Before using any Blink capability, check /docs/status. Constraints: Base Sepolia testnet (chain ID 84532); bUSD has no value; there is no public deployment or API host. Do not create wallets or request keys, and do not sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals for external users. For each endpoint you plan to call, report whether it is Identity mode, Preparation mode, Approval mode or Planned, and tell the operator which BLINK_API_MODE they must set.
```

## Next steps

- [API reference](/docs/api) lists every endpoint with its status.
- [Quickstart](/docs/quickstart) runs the local services.
- [Market lifecycle](/docs/lifecycle) explains what the planned contract flow does.
