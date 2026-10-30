# Local Development and Verification

For the project introduction, see the [README](../README.md). This page holds the startup, verification and infrastructure commands in one place. The current design is described in [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md); the v0.1 approval, signer and trading modes no longer exist.

## Local startup

Requirements: Node.js 22.23.1 and pnpm 11.20.0. The versions are written in .nvmrc / packageManager. Use existing tools whose versions match. Contract tests use the pinned Foundry through `scripts/foundry.mjs`; Docker is needed for the PostgreSQL suites on a host without a local PostgreSQL.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:contracts
pnpm test:contracts:seeds
pnpm dev
```

With no environment variables set, the API uses the scaffold, and the Worker and Indexer business features are disabled. No database, RPC or wallet is needed. The Web is a documentation site with no trading, wallet or admin UI. There is no public API host and no deployment of the protocol generation.

| Entry         | Address                            | Current behavior                                        |
| ------------- | ---------------------------------- | ------------------------------------------------------- |
| Web           | http://127.0.0.1:3000              | Documentation site and read-only samples                |
| API config    | http://127.0.0.1:3001/v1/config    | scaffold returns deployment=null, tradingEnabled=false  |
| Architecture list | http://127.0.0.1:3001/architecture | List of modules and API routes                       |
| OpenAPI contract | http://127.0.0.1:3001/openapi.json | Contract generated from the shared schemas; the enabled flag follows the registered services |
| Worker        | http://127.0.0.1:3002/health/live  | Liveness check; /jobs returns the enabled state and the job list |
| Indexer       | http://127.0.0.1:3003/health/live  | Liveness check; keeps syncing once CHAIN_INDEXER_ENABLED=true and fully configured |

There is no signer process. API modes are enabled layer by layer, and each includes the previous one. They follow `apps/api/src/config.ts`:

- `scaffold`: no database. A valid request for a feature that is not enabled returns 501.
- `identity`: needs `API_DATABASE_URL` and `WALLET_BINDING_ORIGIN`. Adds self-serve wallet identity (`/v1/auth/wallet-challenges`, `/v1/auth/wallet-verifications`). Signature checks need `BASE_SEPOLIA_RPC_URL`; without it every check answers `503 SIGNATURE_CHECK_UNAVAILABLE`.
- `markets`: also needs `BLINK_DEPLOYMENT_ID`, `SPEC_OBJECT_DIRECTORY` and `SPEC_PUBLIC_ORIGIN`. Adds the public protocol reads, content upload, human suggestions, the RFQ relay, transaction tracking, signed forecasts and consensus.

The API, worker and indexer refuse to start when their environment holds a private key, mnemonic, key file or bare 32-byte hex value (`PLATFORM_ROLE_KEY_FORBIDDEN`).

The Worker is disabled by default. Set `WORKER_ENABLED=true` and a dedicated `WORKER_DATABASE_URL` to run the queue, the outbox and the periodic jobs (`forecast.schedule`, `evaluation.score`, `alert.deliver`, `alert.evaluate`, `operations.prune`). `FORECAST_PRE_CLOSE_LEAD_SECONDS` (default 3600) and `FORECAST_WINDOW_OPEN_SECONDS` (default 1800) set the PRE_CLOSE window schedule. Without `BLINK_DEPLOYMENT_ID` the forecast jobs find no market, and `BASE_SEPOLIA_RPC_URL` enables the RPC alert family. The Indexer needs `CHAIN_INDEXER_ENABLED=true`, `INDEXER_DATABASE_URL`, `INDEXER_DEPLOYMENT_ID` and `BASE_SEPOLIA_RPC_URL`; transaction tracking has its own switch, `INDEXER_TX_TRACKING_ENABLED`. None of these readiness signals guarantees that a given market can trade, and none means a public deployment exists.

To start one app alone, use `pnpm --filter @blink/api dev`, and likewise for the other apps. Web build: `pnpm build`.

Standalone backend bundles: `pnpm build:services` (API, worker and indexer). To verify a bundle that does not depend on the workspace or tsx: `pnpm test:service-build`. The container templates are `infra/Dockerfile.{api,worker,indexer}`, and the build context is the repo root.

## Verification commands

| Command | What it checks |
| --- | --- |
| `pnpm check` | Two TypeScript typechecks, contract compilation and EIP-170 sizes, the unit and integration tests (PGlite), and package boundaries |
| `pnpm test:contracts`, `pnpm test:contracts:seeds` | Foundry unit, fuzz and invariant tests |
| `pnpm test:postgres` | Real PostgreSQL concurrency suites, serially. Needs `TEST_POSTGRES_ADMIN_URL` |
| `pnpm test:anvil` | Suites that start a local Anvil on chain ID 84532 |
| `pnpm alpha:local` | The infrastructure-only local alpha: real API, indexer and worker, independent actors, one full market. Needs `TEST_POSTGRES_ADMIN_URL`; about five and a half minutes |
| `pnpm drill:restore:test` | The `pg_dump` and restore drill. Needs `TEST_POSTGRES_ADMIN_URL` and Docker |
| `pnpm build`, `pnpm build:pages` | The Web build. Turbopack needs a newer glibc than RHEL 8's 2.28, so these run in CI on that kind of host |
| `pnpm test:images`, `pnpm images:smoke` | The container images and a Compose smoke. Need Docker |

A PostgreSQL 17.6 container (the same image as CI) is enough for the PostgreSQL suites; point `TEST_POSTGRES_ADMIN_URL` at an administrator login with CREATEDB and CREATEROLE. The PostgreSQL suites run serially because historical migrations create cluster-wide roles that migration 0025 drops. Measured results are in [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md#verification).

## Optional local infrastructure

```sh
pnpm infra:up
```

This starts only a local PostgreSQL. The credentials are for development, and data lives in a Docker named volume. Outside scaffold mode, the API connects to the DB with the dedicated `API_DATABASE_URL`. Compose does not enable it automatically. To stop, use `pnpm infra:down`, which keeps the volume. Name the database explicitly before running the migration runner:

```sh
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

It creates domains, group roles and every schema. It needs a migration account with permission to create schemas and roles. Migrations are forward-only (0001–0034, with no 0021); an applied file must never be edited. `pnpm test` uses an isolated PGlite engine and does not connect to an existing database.

## Directory layout

```text
apps/                 web / api / worker / indexer
packages/
  schemas/            wire schema, deployment manifest v2, market spec, protocol parameters
  domain/             business modules and their vocabulary
  ports/              boundaries for DB transaction, queue, storage, RPC and signature checking
  application/        use cases, jobs, the RFQ relay, health
  adapters/           DB transaction/migrations, local object store, protocol ABI, indexer store, deployment tooling
  runtime/            shared HTTP startup, health, error handling, platform-key guard
  client/             Private typed responses, quote verification and same-key retry
contracts/            protocol contracts (src/protocol), BlinkTestUSD, Foundry tests, generated ABI/bytecode artifacts
examples/agents/      Reference agents (shared runtime and all eight roles)
infra/                local PostgreSQL and container templates
deployments/          release manifest template, historical alpha-2 manifest
fixtures/replay/      schema fixtures explicitly marked REPLAY
docs/                 architecture, data, operations, ADR, roadmap
tests/                unit, integration, contract protocol, PostgreSQL / Anvil / alpha and browser checks
```

Do not treat a passing local test as audited or ready for public trading. An official deployment manifest must have a real commit, addresses and on-chain verification. The template must not be used as an official manifest.
