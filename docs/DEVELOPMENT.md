# Local Development and Verification

For the project introduction, see the [README](../README.md). This page holds the startup, verification and infrastructure commands in one place.

For the latest way to enable manual approval, see [M2 approval delivery](M2_APPROVAL_DELIVERY.md#configuration--manual-operations). Approval mode needs migration 0004, a public spec origin, a persisted spec directory and a read-only evidence directory. The deployment-registration CLI uses a separate account. This does not mean a real deployment exists locally, and it does not submit transactions automatically.

## Local startup

Requirements: Node.js 22.23.1 and pnpm 11.20.0. The versions are written in .nvmrc / packageManager. Use existing tools whose versions match.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:contracts
pnpm test:contracts:seeds
pnpm replay
pnpm dev
```

With no environment variables set, the API uses the scaffold, and the Worker / Indexer business features and the Signer are disabled. No database, RPC, model key or wallet is needed, and no gas or model fees are spent. The Web is a read-only explainer site with fictional REPLAY samples, and has no trading / wallet / admin UI. The addresses in the table below are for local development only. There is no public API host and no Base Sepolia deployment.

| Entry         | Address                            | Current behavior                                        |
| ------------- | ---------------------------------- | ------------------------------------------------------- |
| Web           | http://127.0.0.1:3000              | Read-only Next.js site, docs and fictional REPLAY samples |
| API config    | http://127.0.0.1:3001/v1/config    | scaffold returns deployment=null, tradingEnabled=false; trading reports according to deployment and the RFQ gate |
| Architecture list | http://127.0.0.1:3001/architecture | List of modules and API routes                       |
| OpenAPI contract | http://127.0.0.1:3001/openapi.json | Contract generated from the shared schemas; the enabled flag follows the registered services |
| Worker        | http://127.0.0.1:3002/health/live  | Liveness check; /jobs returns the enabled state and the job list; consumes the queue once enabled |
| Indexer       | http://127.0.0.1:3003/health/live  | Liveness check; keeps syncing once CHAIN_INDEXER_ENABLED=true and fully configured |
| Signer        | http://127.0.0.1:3004/health/live  | Liveness check; /internal/sign exists only when `SIGNER_ENABLED=true` |

API modes are enabled layer by layer, and business paths that are not registered stay fail-closed. The modes and their requirements follow `apps/api/src/config.ts` and `main.ts`:

- `scaffold`: no DB. A malformed request returns 400. A valid request for a feature that is not enabled returns 501. `/v1/config` shows deployment=null, tradingEnabled=false.
- `identity` / `preparation` / `approval`: add, in order, wallet auth, evidence / candidates and manual approval. See [identity](M2_IDENTITY_DELIVERY.md), [candidates](M2_PREPARATION_DELIVERY.md) and [approval](M2_APPROVAL_DELIVERY.md).
- `markets`: also wires public markets / positions / settlement / transaction tracking, forecast, resolution reports and public evaluation metrics. It does not wire the RFQ signer. Like the earlier modes, the API `/v1/health` and `/health/ready` still return 503, because no trading readiness service is injected.
- `trading`: also wires RFQ, faucet, health and admin execution metrics. `/v1/health` publicly returns `{status, tradingEnabled, reasons}`. It is 200 only when there is no gate reason, and 503 otherwise. With a valid admin key it adds diagnostics. An invalid or non-admin key gets 401 / 403. The API `/health/ready` uses the same public readiness decision. This mode needs the signer, RPC, a registered deployment and complete DB / archive settings. Switching the mode alone does not make it ready. See [Health and metrics](M5_HEALTH_METRICS.md).

The Worker is disabled by default. Set `WORKER_ENABLED=true` and a dedicated DB login to run the queue / outbox / periodic scheduling. Research, execution and trader are composed according to their own settings, and readiness depends on whether the work loop is running. The Indexer's creation polling, transaction tracking and continuous chain index are each enabled separately. The global `/health/ready` is still 503, and the chain-index state is under `/health/chain-index`. The Signer is disabled by default. Once enabled, `/health/ready` reports on the DB, deployment and RPC. None of these process or deployment readiness signals guarantees that a given market or taker can fill, and none means the public deployment is done.

To start one app alone, use `pnpm --filter @blink/api dev`, and likewise for the other apps. Web build: `pnpm build`.

Standalone backend deployment artifacts: `pnpm build:services`. To verify a bundle that does not depend on the workspace / tsx: `pnpm test:service-build`. The API container template is `infra/Dockerfile.api`, and the build context is the repo root. Public deployment acceptance is not yet complete.

## Optional local infrastructure

```sh
pnpm infra:up
```

This starts only a local PostgreSQL. The credentials are for development, and data lives in a Docker named volume. Outside scaffold mode, the API connects to the DB with the dedicated `API_DATABASE_URL`. Compose does not enable it automatically. To stop, use `pnpm infra:down`, which keeps the volume. M0 has a basic migration runner. Name the database explicitly before running it:

```sh
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

It creates domains, group roles, and audit / idempotency / outbox / jobs. It needs a migration account with permission to create schemas and roles. Migrations 0001–0019 now include the business tables for identity, candidates, approval, chain, forecast, signing, trading and observability. The S3 adapter is still not implemented. `pnpm test` uses an isolated PGlite PostgreSQL engine and does not connect to an existing database.

## Directory layout

```text
apps/                 web / api / worker / indexer / signer
packages/
  schemas/            wire schema, GM template, EIP-712 fields
  domain/             responsibilities and terms of the twelve business modules
  ports/              boundaries for DB transaction, queue, storage, RPC, model and signer
  application/        wired use cases, jobs, RFQ, health and execution coordination
  adapters/           DB transaction/migrations, spec archive, local object store, deployment verification
  runtime/            shared HTTP startup, health, error handling
  client/             Private typed responses, runtime validation, spec / quote verification and same-key retry
contracts/            TestUSD/Market contracts, Foundry tests, generated ABI/bytecode artifacts
infra/                local PostgreSQL
deployments/          release manifest template, no real addresses
fixtures/replay/      schema fixtures explicitly marked REPLAY
docs/                 architecture, data, operations, ADR, roadmap
tests/                unit, integration, contract protocol, PostgreSQL / Anvil / Alpha and browser checks
```

Do not treat REPLAY as a LIVE question, and do not treat a passing local test as audited or ready for public trading. An official deployment manifest must have a real commit, addresses and on-chain verification. The template and a LOCAL_REPLAY_ONLY report must not be used as an official manifest.
