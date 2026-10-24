# ADR 0001 — Modular TypeScript backend and isolated signer

Status: adopted for the architecture baseline; date: 2026-09-22.

_Status: partially superseded — the technology choices (TypeScript/Node, PostgreSQL, Solidity/Foundry, EIP-712) still stand; the isolated signer, the single maker and the manual ADMIN/arbitration wallets are removed by sections 5.10 and 6 of docs/superpowers/specs/2026-10-23-autonomous-market-design.md (section 7 keeps the EIP-712 quote format and the job queue/outbox). Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

## Background and choice

v0.1 has a single maker, a small number of markets, external agent access, off-chain LLM/data IO and an on-chain funds ledger. It puts traceability, stability and low operating cost first.

| Option | Performance and reliability | Development / operating cost | Decision |
| --- | --- | --- | --- |
| TypeScript / Node.js | Suits concurrent IO; CPU-heavy work needs a separate process | Shared front-end/back-end schemas, consistent EVM tooling | Adopted |
| Go | Efficient resource use and controllable concurrency | Adds cross-language schema and agent tooling cost | Evaluate a local replacement once a bottleneck is measured |
| Python | Convenient model/research ecosystem | A second set of types and deployment for Web/EVM; there is no Python-only need today | Specific later research can run as a separate job |
| Rust | Strict typing and efficient resource control | The current load does not offset the implementation and review time | Not adopted for now |

The above is the trade-off for this project, not a benchmark conclusion. Node.js 22.23.1 is the fixed baseline that exists today and can be verified; the API uses Fastify 5. For framework compatibility see [Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/) and the [Next.js installation requirements](https://nextjs.org/docs/app/getting-started/installation). Exact package versions and the transitive lock are defined by package.json / pnpm-lock.yaml; verified versions cannot be guessed from the specification.

## Data layer

PostgreSQL 17 is the single relational source: one DB, with schema/table ownership split. Explicit SQL migrations and transactions come first; the M2 adapter uses pg + SQL, version-pinned at that time, and introduces no ORM for now. NUMERIC(78,0) + a uint256 check; amounts are never converted through a JS number.

A Postgres outbox/job queue is enough to start. `FOR UPDATE SKIP LOCKED` lets multiple consumers compete to claim queue rows, but a read that skips locks must not be used to check fund consistency; budgets and reservations need explicit locks. Using the same DB transaction prevents work from disappearing after a business commit. [PostgreSQL SELECT](https://www.postgresql.org/docs/17/sql-select.html)

No Redis/Kafka/standalone search engine is introduced. If real queue latency or database pressure appears, measure first, tune indexes/concurrency, then replace through ports.

## Contracts and signatures

Solidity 0.8.30 + Foundry; the ledger is not upgradeable. Standard token / ECDSA / permission code is intended to use pinned OpenZeppelin versions, introduced in M1. This round fixes only the Quote struct and the interface, and imports no unused library.

EIP-712 type ordering has a cross-language test; the domain has chainId=84532 and verifier=the deployed address. The protocol itself does not solve replay; consumed/cancelled/epoch/expiry are implemented in M1. [EIP-712](https://eips.ethereum.org/EIPS/eip-712)

The signer is separated from ordinary workers in secrets, credentials and network identity; different internal roles use different keys. The ADMIN/arbitration roles use manual wallets, and the API does not hold those keys. Credential and key isolation must be verified in M3/deployment acceptance; a TypeScript type is not used as access control.

## Costs and re-review conditions

A shared PostgreSQL is an early single point of failure; it needs managed backup, restore drills and a connection pool. Long CPU tasks in Node block the event loop; heavy parsing goes to worker child processes, and the RFQ path does not run an LLM. There is no K8s, cross-region active-active or multi-maker; write a new ADR when the need appears.

When upgrading Node / Next / React / Fastify and image patches, rerun the lockfile install, typecheck, contract tests and build. A formal deployment also pins image digests and produces an SBOM; the local Compose file is not treated as a production manifest.
