---
title: Architecture
description: How Blink splits research, funds and signing across processes and trust boundaries.
group: How markets work
order: 2
agentTask: understand which Blink component is responsible for what
---

# Architecture

> [!NOTE]
> **v0.1 architecture.** This page describes the v0.1 processes, including a private signer, platform research and a single maker, which P2 removed. The platform now runs only an API, an indexer and a worker, holds no key and plays no market role; see [P2 off-chain protocol](https://github.com/Blink-Markets/blinkmarket/blob/main/docs/P2_OFFCHAIN_PROTOCOL.md). P3 rewrites this page. The current design is the [autonomous market design](https://github.com/Blink-Markets/blinkmarket/blob/main/docs/superpowers/specs/2026-10-23-autonomous-market-design.md).

Blink is a modular monolith with implemented API, worker, indexer and restricted signer processes. They are not deployed; local verification uses REPLAY fixtures with no paid model provider. The public site is read-only, with fictional samples and no trading. LIVE approval remains rejected. The contracts are deployed on Base Sepolia with trading disabled; see [Deployment](/docs/deployment). The mandate trader, typed SDK and local example agent, local Alpha harness, health/readiness and admin execution metrics are implemented. The harness exercises normal YES, disputed NO and timeout INVALID settlement plus projection recovery on a local stack; it does not establish public-network finality or hosted readiness. Container images for the four processes, operator status reads, alert delivery, a backup restore drill and a deployment runbook are also implemented and verified locally; none of them is a hosted deployment.

![Hand-drawn sketch of the target Blink architecture (target, not live): web, API, worker, indexer and signer processes around PostgreSQL, object storage and the BlinkMarket contract.](/docs-assets/architecture-sketch.jpg)

The trading-mode API exposes public `GET /v1/health` and uses the same readiness decision for `/health/ready`. An admin key adds private diagnostics; `GET /v1/admin/metrics` is admin-only and reports execution latency, persisted status/error counts and role/day gas. Public evaluation metrics remain separate. Readiness does not guarantee a particular market or wallet can trade.

The internal trader reserves mandate risk, verifies public RFQs and uses the restricted signer for exact approval, fill and FINAL redemption. It supports one trader per deployment; mandate caps are enforced by the worker, not independently by the signer. External agents can use the private [typed client](/docs/client) and local example; a future testnet API needs operator configuration.

## What are the three responsibilities?

- **Off-chain research and coordination.** The API receives requests, workers handle research and background jobs, PostgreSQL stores application records, and object storage preserves original evidence and specification bytes.
- **On-chain funds and outcomes.** The BlinkMarket contract validates quotes, keeps full collateralization, records positions, and enforces settlement and redemption. Users keep control of their own wallets.
- **Separate signing and synchronization.** A private signer independently checks signing policy. An indexer turns chain events into rebuildable database projections.

## Which processes exist?

Web, API, Worker, Indexer and Signer share one codebase and domain definitions, but have different workloads and trust boundaries.

| Process | Job |
| --- | --- |
| Web | Read-only explainer and fictional REPLAY samples; no wallet, trading or admin UI |
| API | Authentication, validation, reads and command intake |
| Worker | Discovery, forecasting, cost reconciliation and keeper scheduling |
| Indexer | Chain event pulling, reorg handling and projections |
| Signer | Restricted signing for maker quotes and similar roles; private boundary |
| Contracts | Collateral, fills, positions, final outcomes and redemption; not upgradeable |

## Where are the trust boundaries?

- The Web host holds no database or signer secrets. The current showcase serves static samples; backend public reads are implemented separately.
- Models hold neither keys nor adjudication authority. Their output is research or a recommendation.
- A quote is not a trade, and a database reservation is not an on-chain lock. The contract re-checks balances, deadlines, caps and signatures.
- The chain is the source of truth for funds. Database projections can be rebuilt. An unknown transaction state is not proof of failure and must not be blindly resubmitted.
- The restricted signer re-verifies policy, intent and nonce and authenticates callers with bearer tokens. Network ACLs, mTLS and key encryption at rest remain deployment work. Administrator, proposer, challenger and arbiter actions use their own manual wallets, not the automatic signer.
- Pausing stops new trades only. Existing positions can still settle and redeem.

## How is the code layered?

Dependencies point one way: apps wire things together, application use cases depend on ports and domain, adapters implement ports, and schemas define the JSON wire contract used by the API, client and web.

- `schemas`: wire contract, no framework or database dependency.
- `domain`: state and invariants.
- `application`: use cases and transaction boundaries.
- `ports`: interfaces to storage, chain, models and signing.
- `adapters`: PostgreSQL, viem and other concrete implementations.
- `apps`: composition roots and process lifecycles.

A boundary check in the repository verifies the basic import direction. It is not a key-isolation guarantee.

## What are the ports?

Ports are the interfaces the application layer depends on. Adapters provide the concrete implementations.

| Port | Responsibility |
| --- | --- |
| `ImmutableObjectStore` | Put-if-absent storage and reads of evidence and specification bytes |
| `SourceFetcher` | Fetch from allowlisted sources |
| `ModelGateway` | Budgeted model forecast calls |
| `ChainSnapshotReader` | Read the RPC head, then the market, maker and taker state at that one block hash |
| `SpecArchive` | Freeze a market specification to bytes and a hash, and read it back |
| `JobQueue` | Enqueue within a transaction, lease and acknowledge jobs |
| `UnitOfWork` | Run work inside one database transaction |
| `RestrictedSigner` | Sign a request after re-checking trusted intent, policy and nonce |
| `IdentityStore`, `IdentityCrypto` | Invited keys, wallet challenges and hashing |
| `PreparationStore` | Evidence records and candidate revisions |
| `ApprovalStore` | Human approval and unsigned creation intents |
| `CreationTrackerStore`, `CreationReceiptReader` | Operator-driven tracking of market-creation receipts |

## How does a market get created?

Evidence is fetched from an allowlisted source, stored as bytes with a hash, and attached to a candidate revision. A human approves it. The approval writes the approval, the frozen specification record, an unsigned creation intent, an audit entry and an outbox entry in one database transaction. An administrator then signs the creation transaction in their own wallet. Nothing signs or broadcasts it automatically.

## Hand it to your agent

```prompt
Read https://blink-markets.github.io/blinkmarket/docs/architecture.md and tell me which Blink process or port is responsible for a given task (for example: freezing a specification, signing a quote, reading a creation receipt), and which trust boundary applies. Hard rules: Base Sepolia testnet only (chain ID 84532); bUSD has no value. Do not create wallets, request keys, or sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals. The page describes implemented backend services; the API is not deployed, so do not call any host.
```

## Next steps

- [Market lifecycle](/docs/lifecycle) covers states and settlement.
- [Roles](/docs/roles) describes who holds each role and key.
