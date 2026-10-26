# Operations and deployment design

After P2 the platform runs three backend processes (API, indexer, worker) plus the documentation site, and migrations 0001–0034 (there is no 0021). It holds no key and plays no market role. For what was removed, see [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md); for the architecture, see [Architecture](ARCHITECTURE.md). Nothing is deployed: there is no public API host, no deployment of the protocol generation and no hosted environment. The deployment target below is a design, and the v0.1 procedure in the [Deployment runbook](DEPLOYMENT_RUNBOOK.md) is historical.

## What runs today

`pnpm dev` starts the Web app, API, worker and indexer on loopback hosts. The API defaults to the scaffold, and the worker and indexer business functions are disabled by default, so nothing connects to a DB or RPC before it is configured. For how to enable them, see [Local development](DEVELOPMENT.md). Once configured fully, the wiring that is implemented includes:

- **API.** Modes `scaffold`, `identity` and `markets`. `markets` serves self-serve wallet identity, public protocol reads, hash-addressed content, human suggestions, the RFQ and quote relay, transaction tracking and signed forecasts. Signature checks go through the RPC; they never sign.
- **Worker** (with `WORKER_ENABLED=true` and a dedicated DB login). It consumes the durable queue and the outbox and runs five job types: `forecast.schedule` (opens and closes forecast windows and stores their Merkle roots, every 30 seconds), `evaluation.score`, `alert.deliver`, `alert.evaluate` and `operations.prune`. Alerts are delivered at least once through a stdout, file or webhook sink (see [Alert delivery](M5_ALERTS.md), partly historical), and are produced from real conditions by `alert.evaluate` every minute: RPC failure (reuses `BASE_SEPOLIA_RPC_URL`), indexer lag, DEAD jobs, and undistributed fees on a FINAL market. Each condition is one episode: OPEN when it starts, CLEARED when it ends. When the source cannot be read, that family produces neither.
- **Indexer** (with `CHAIN_INDEXER_ENABLED=true` and dedicated DB, RPC and deployment settings). It keeps syncing the protocol generation's blocks, events and projections and handles reorgs. Transaction tracking has its own switch.
- **Keys.** The API, worker and indexer refuse to start with a private key, mnemonic, key file or bare 32-byte hex value in their environment. The platform's keeper, faucet and trader are gone: any agent may call the permissionless steps.

`pnpm build:services` produces `dist/services/{api,worker,indexer}.mjs`, the operator tool bundles and the migrations, and `pnpm test:service-build` verifies the standalone bundles. `infra/Dockerfile.{api,worker,indexer}` each build one multi-stage image per service; the images are non-root and contain no npm, yarn or corepack at run time. `infra/compose.alpha.yaml` and `pnpm images:smoke` run the services with local containers (see [Service images](M5_SERVICE_IMAGES.md)). `pnpm deploy:preflight <env-file>` is an offline env check. Public deployment and the supply-chain release process have not been accepted.

`pnpm check` runs two TypeScript typechecks, contract compilation, the Node unit and integration tests and package boundaries. `pnpm test:contracts` runs the Foundry suites. `pnpm alpha:local` uses a dedicated local PostgreSQL and Anvil to run the infrastructure-only local alpha. `pnpm drill:restore` rehearses locally a `pg_dump` backup and a restore into a new database (see [Restore drill](M5_RESTORE_DRILL.md), partly historical). None of this equals a public deployment, backup and restore in a hosted environment, or a security audit.

## Target topology (design only)

A single-region application host runs the API, worker and indexer. The Web app can share the host or be hosted. There is one managed PostgreSQL, a private S3-compatible bucket (the adapter is not implemented; the content store is a local directory today) and a primary and a backup Base Sepolia RPC. Do not use Kubernetes at first. Until the load is known, do not prepay for multi-region infrastructure. The vendors, quotes and region are to be confirmed before any deployment, and no monthly fee is invented here.

The local Compose is for PostgreSQL development only. A production image must update patches, pin digests, scan, and keep a manifest.

## Service identity matrix

| Identity | DB / network | Key |
| --- | --- | --- |
| Web | The static site does not connect to the backend | None |
| API | Business DB privileges (`blink_api`), RPC for signature checks and index health | None |
| Worker | Job, forecast-root and scoring grants (`blink_worker`) | None |
| Indexer | RPC, chain and protocol projection tables (`blink_indexer`) | None |
| Operator tools (deploy, register, restore) | Separate administrator credentials, used only for the command that needs them | The deployer key is read only by `pnpm contracts:deploy --broadcast`, and never mounted into a service |

No platform process holds a market role or a role key.

## Release manifest

`deployments/base-sepolia/manifest.template.json` is an undeployed manifest v2 template and cannot serve as runtime config. A real deployment needs schema validation (`parseProtocolDeployment`), a hard limit of chainId=84532, address, bytecode and ABI hashes, the deployment blocks, commit and compiler, and the generation's parameters. A new deployment gets a new `deploymentId`, and the API, worker and indexer all compare against it. The `alpha-2` manifest is a v0.1 record kept as history (`HISTORICAL_V1_MANIFEST`).

Mainnet is forbidden, and is rejected even if env says 8453. `pnpm contracts:deploy` is a dry run by default. Only with `--broadcast` does it read the deployment key and send transactions. It has so far been verified only on a local Anvil (chain ID 84532). For its usage and checks, see [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md#deploy-tooling-local-only-nothing-deployed); [M5 deployment tooling](M5_DEPLOYMENT_TOOLING.md) is the v0.1 record.

## Health and observability

- live only means the process can respond. The API's `/v1/health` and `/health/ready` use the same public readiness decision: ready is 200, otherwise 503. In the P2 modes it reports only what the process can know; it does not guarantee that any market can trade.
- Worker readiness only reflects whether the work loops are running. The indexer's chain index state is reported at `/health/chain-index`.
- The index is stale when its latest block timestamp trails the chain head by more than 30 seconds. Every identity-acting write then fails with `503 INDEX_STALE` and the relay stops, but nothing on the contracts is affected.
- Logs do not record API keys, private keys or provider secrets. Audit records actor, reason and hashes.
- Worker shutdown stops the schedules and the work loops, waits for work in flight and closes the pool. The indexer stops its observation loops.
- The admin read routes (`/v1/admin/*`) and `pnpm ops:status` remain in the code, but no key can carry the `admin` scope (P2 Task 6), so they cannot be used.

## Incidents and backup

The contracts are not upgradeable and have no pause. In a security incident all the platform can do is stop API relaying, announce on the website and in the documentation, and publish a new deployment (a new generation). Old markets run to completion under their old rules. Take a daily DB backup, with object-store versioning and retention. The local rehearsal is the `pg_dump` and restore drill ([Restore drill](M5_RESTORE_DRILL.md)); the hosted rehearsal, and the restore of archived objects, wait for a deployment that does not exist yet.

When a gas bound or RPC finality capability is unknown, stay stopped. Do not automatically assume free, failed or finalized.
