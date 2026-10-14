---
title: Architecture
description: How Blink splits research, funds and signing across processes and trust boundaries.
group: How markets work
order: 2
agentTask: understand which Blink component is responsible for what
---

# Architecture

Blink is a modular monolith designed to run as separate processes by responsibility. This page describes that target design, as set out in the README and `docs/ARCHITECTURE.md`.

![Hand-drawn sketch of the target Blink architecture (target, not live): web, API, worker, indexer and signer processes around PostgreSQL, object storage and the BlinkMarket contract.](/docs-assets/architecture-sketch.jpg)

## What are the three responsibilities?

- **Off-chain research and coordination.** The API receives requests, workers handle research and background jobs, PostgreSQL stores application records, and object storage preserves original evidence and specification bytes.
- **On-chain funds and outcomes.** The BlinkMarket contract validates quotes, keeps full collateralization, records positions, and enforces settlement and redemption. Users keep control of their own wallets.
- **Separate signing and synchronization.** A private signer independently checks signing policy. An indexer turns chain events into rebuildable database projections.

## Which processes exist?

Web, API, Worker, Indexer and Signer share one codebase and domain definitions, but have different workloads and trust boundaries.

| Process | Job |
| --- | --- |
| Web | Public research, evidence and forecast pages |
| API | Authentication, validation, reads and command intake |
| Worker | Discovery, forecasting, cost reconciliation and keeper scheduling |
| Indexer | Chain event pulling, reorg handling and projections |
| Signer | Restricted signing for maker quotes and similar roles; private boundary |
| Contracts | Collateral, fills, positions, final outcomes and redemption; not upgradeable |

## Where are the trust boundaries?

- The Web host holds no database or signer secrets and reaches data through the API.
- Models hold neither keys nor adjudication authority. Their output is research or a recommendation.
- A quote is not a trade, and a database reservation is not an on-chain lock. The contract re-checks balances, deadlines, caps and signatures.
- The chain is the source of truth for funds. Database projections can be rebuilt. An unknown transaction state is not proof of failure and must not be blindly resubmitted.
- The signer is meant to be a private process that re-verifies policy, intent and nonce itself and does not trust caller claims. Administrator, proposer, challenger and arbiter actions use their own manual wallets, not the automatic signer.
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
Read https://blink-markets.github.io/blinkmarket/docs/architecture.md and tell me which Blink process or port is responsible for a given task (for example: freezing a specification, signing a quote, reading a creation receipt), and which trust boundary applies. Hard rules: Base Sepolia testnet only (chain ID 84532); bUSD has no value. Do not create wallets, request keys, or sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals. The page describes a design; the API and contracts are not deployed, so do not call any host.
```

## Next steps

- [Market lifecycle](/docs/lifecycle) covers states and settlement.
- [Roles](/docs/roles) describes who holds each role and key.
