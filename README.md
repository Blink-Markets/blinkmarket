<p align="center">
  <img src="apps/web/app/icon.svg" width="72" height="72" alt="Blink Market logo">
</p>

<h1 align="center">Blink Market</h1>

<p align="center">
  Prediction research, traceable evidence and fully collateralized testnet markets on Base Sepolia.
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-2148B8" alt="English"></a>
  <a href="README.zh-TW.md"><img src="https://img.shields.io/badge/lang-%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-C65F38" alt="繁體中文"></a>
</p>

<p align="center">
  <a href="https://github.com/Blink-Markets/blinkmarket/actions/workflows/ci.yml"><img src="https://github.com/Blink-Markets/blinkmarket/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2148B8" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/network-Base%20Sepolia%20testnet-C65F38" alt="Network: Base Sepolia testnet">
</p>

<p align="center">
  <a href="https://blink-markets.github.io/blinkmarket/">Website</a> ·
  <a href="https://blink-markets.github.io/blinkmarket/docs/">Docs</a> ·
  <a href="https://blink-markets.github.io/blinkmarket/docs/agents/">Agent guide</a> ·
  <a href="https://blink-markets.github.io/blinkmarket/llms.txt">llms.txt</a>
</p>

---

## About

Blink Market is an experimental platform for agents and the people who run them. It starts from questions with explicit resolution rules, keeps the original source evidence, collects model and external forecasts, and lets takers trade YES/NO shares through signed RFQ quotes. Humans propose outcomes, and a challenge process settles disputes.

The goal is to understand not only whether a forecast was right, but also its evidence, cost, reproducibility and quality over time.

> [!IMPORTANT]
> Blink Market is a research project on the Base Sepolia **testnet**. It uses a test token with no value, the contracts are not audited, and nothing here is financial advice.

## Current status

The API and contracts are **implemented, not yet deployed**. There is no public API host or Base Sepolia deployment, and nothing trades on this read-only site. Its markets are fictional REPLAY samples. Local verification uses REPLAY fixtures and Anvil with chain ID 84532; no paid model provider is connected and LIVE approval remains rejected.

Tasks 1–13 deliver durable jobs and budgets, allowlisted evidence fetching, discovery and fixture forecasters, forecast windows and evaluation, public chain reads and transaction tracking, reorg-aware indexing, restricted signing, RFQ reservations, resolution reports, keeper finalization and the test-asset faucet. Tasks 14–16 add the internal trader under a mandate, the typed client SDK and external example agent, health/readiness and admin execution metrics, and a one-command local Alpha harness. The trader is limited to one trader per deployment and buys only when its linked forecaster’s edge strictly exceeds the mandate threshold (default 500 bps). Wallet/trading/admin UI, public deployment, paid providers, alert delivery and external acceptance remain open; local verification does not complete public Alpha.

## Local Alpha and agent tooling

With dependencies installed and a dedicated local PostgreSQL administrator URL, run:

```sh
TEST_POSTGRES_ADMIN_URL='<dedicated local PostgreSQL administrator URL>' pnpm alpha:local
```

The administrator needs CREATEDB/CREATEROLE privileges. The harness refuses non-loopback PostgreSQL hosts, creates and removes its own database and service logins, and starts local Anvil on chain ID 84532. It exercises normal YES, disputed NO and timeout INVALID REPLAY lifecycles, the example agent, worker keeper finalization, and canonical rebuild/drop-and-reindex drills. This verifies local flows; it does not establish public-network finality or hosted readiness. See [Local Alpha](docs/M5_LOCAL_ALPHA.md) for prerequisites and limits.

`@blink/client` is a private workspace package, not published on npm. It provides typed endpoint responses, runtime validation, same-key retries for server-marked retryable errors, spec-hash checking and `verifySignedQuote`. [The example agent](examples/agent/README.md) binds its wallet, forecasts, claims test assets, verifies a quote, approves exactly its cost, fills and redeems. Its RPC is loopback-only; the client can target a local API or a future operator-configured testnet API. No public API host exists.

`GET /v1/health` exposes public readiness; an admin key adds diagnostics. The API’s `/health/ready` uses the same decision, and `GET /v1/admin/metrics` exposes admin-only execution latency, persisted status/error counts and role/day gas accounting. Public forecast evaluation metrics remain separate. Readiness is deployment-level availability, not a guarantee that any market or taker can trade.

## Architecture

![Hand-drawn Blink Market target architecture: Web and wallets request quotes from the API; the backend coordinates research, storage and a private signer; wallets trade and redeem directly on Base Sepolia; the indexer syncs chain events into PostgreSQL.](docs/assets/architecture-sketch-light.png)

Three responsibilities shape the system:

- **Off-chain research and coordination.** The API receives requests, workers handle research and background jobs, PostgreSQL stores application records, and object storage keeps the original evidence and specification bytes.
- **On-chain funds and outcomes.** The `BlinkMarket` contract validates quotes, keeps every position fully collateralized, records positions, and enforces settlement and redemption. Users keep control of their own wallets.
- **Separate signing and synchronization.** A private signer checks its own signing policy. An indexer turns chain events into database projections that can always be rebuilt.

## How it works

1. **Define a market.** Preserve the source evidence, get human approval, freeze the specification, and create the market from an administrator wallet.
2. **Collect forecasts.** Gather forecasts in fixed windows. Only policy-compliant snapshots from the two platform models inform maker pricing; baseline and external forecasts are scored separately.
3. **Quote and trade.** A taker requests a quote. The service reserves capacity and returns an EIP-712 signed quote, which the taker submits from their own wallet. The contract checks it again.
4. **Resolve and redeem.** After the market closes, a human proposes the outcome, with challenges and arbitration when needed. Once final, each holder redeems on their own.
5. **Index and evaluate.** The indexer updates chain-derived records, and analytics score forecast quality and cost.

**Example.** Buying **100 YES at 6,000 bps** costs the taker 60 bUSD. The maker adds 40 bUSD, so the contract holds 100 bUSD as 100 complete sets. YES pays the taker 100 bUSD, NO pays the maker 100 bUSD, and INVALID pays each side 50 bUSD.

YES/NO shares are entries in the contract's internal ledger, not transferable tokens. Research probabilities, maker quotes and execution prices are separate things.

## Design principles

- **Testnet and test assets only.** `BlinkTestUSD` (bUSD) is a six-decimal test token. Mainnet trading is out of scope.
- **Models hold no keys and no authority.** Model output is research. Creating markets, proposing outcomes, challenging and arbitrating are explicit human roles.
- **A quote is not a trade.** A database reservation is not an on-chain lock; execution still depends on the contract's checks of balances, deadlines, caps and signatures.
- **The chain is the source of truth for funds.** Database projections can be rebuilt, and an unknown transaction state is never blindly treated as failed and resubmitted.
- **Pausing trading never freezes positions.** Settlement and redemption continue under the contract's rules.
- **LIVE and REPLAY stay separate.** Real prospective questions and test replays are evaluated apart, and passing tests is not a security audit.

## Tech stack

| Layer | Technology |
| --- | --- |
| Web | Next.js, React, TypeScript |
| Backend | Node.js, TypeScript, Fastify |
| Data | PostgreSQL |
| Evidence | Original bytes with Keccak-256 hashes; local object store, S3-compatible storage planned |
| Contracts | Solidity 0.8.30, OpenZeppelin, Base Sepolia |
| Chain access | viem, EIP-712 |
| Testing | Foundry, Anvil, Node test runner, PGlite, Playwright |
| Repository | pnpm workspace with layered packages |

The backend is a **modular monolith run as separate processes by responsibility**: web, API, worker, indexer and signer share one codebase and one set of domain definitions, but have distinct workloads and trust boundaries.

## Repository layout

```text
apps/          web · api · worker · indexer · signer
packages/
  schemas/     wire schemas, templates and EIP-712 fields
  domain/      business modules and their vocabulary
  ports/       boundaries for database, queue, storage, RPC, models and signer
  application/ use cases
  adapters/    database, migrations, evidence and specification archive, deployment checks
  runtime/     shared HTTP startup, health and error handling
  client/      Private typed SDK, spec/quote verification and same-key retries
examples/      External agent for the local stack
contracts/     BlinkTestUSD and BlinkMarket, Foundry tests, generated ABI and bytecode
infra/         local PostgreSQL (Docker Compose) and the API container template
deployments/   release manifest templates (no real addresses)
fixtures/      REPLAY fixtures
docs/          architecture, data model, design, ADRs and operations
tests/         unit, contract-protocol and browser tests
```

## Documentation

- **[Docs site](https://blink-markets.github.io/blinkmarket/docs/)**: concepts, lifecycle, API reference and a guide for agents. Every page is also available as Markdown.
- [Architecture walkthrough](docs/ARCHITECTURE_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Data model](docs/DATA_MODEL.md) · [Detailed design](docs/design/README.md)
- [Development](docs/DEVELOPMENT.md) · [Operations](docs/OPERATIONS.md) · [Roadmap](docs/ROADMAP.md) · [Architecture decisions](docs/adr/0001-platform.md) · [Domain terminology](CONTEXT.md)
- Backend delivery: [Foundation](docs/M2_FOUNDATION_SEAMS.md) · [RFQ](docs/M2_RFQ.md) · [Signer](docs/M2_SIGNER.md) · [Chain indexer](docs/M2_CHAIN_INDEXER.md) · [Public reads](docs/M2_PUBLIC_READS.md)
- Research and operations: [Jobs/budgets](docs/M3_JOBS_BUDGETS.md) · [Evidence fetcher](docs/M3_EVIDENCE_FETCHER.md) · [Forecasts](docs/M3_FORECASTS.md) · [Research workers](docs/M3_RESEARCH_WORKERS.md) · [Resolution](docs/M3_RESOLUTION.md) · [Evaluation](docs/M3_EVALUATION.md) · [Keeper/faucet](docs/M3_KEEPER_FAUCET.md)
- [Internal trader](docs/M3_INTERNAL_TRADER.md) · [Client SDK](docs/M5_CLIENT_SDK.md) · [Example agent](examples/agent/README.md)
- [Health and metrics](docs/M5_HEALTH_METRICS.md) · [Local Alpha](docs/M5_LOCAL_ALPHA.md) · [Acceptance matrix](docs/ACCEPTANCE_MATRIX.md)
- [Deployment tooling](docs/M5_DEPLOYMENT_TOOLING.md)
- [Original MVP specification](Blink_MVP_v0.1_Base_Sepolia_Spec.md)

Most documents in `docs/` are written in Traditional Chinese.

## Contributing

Issues and pull requests are limited to collaborators. Everyone can read the code, the [docs](https://blink-markets.github.io/blinkmarket/docs/) and existing discussions.

## License

[MIT](LICENSE) © 2026 Blink-Markets
