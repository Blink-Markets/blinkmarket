# Operations and deployment design

The backend now has the API / Worker / Indexer / Signer business wiring and migrations 0001–0022 (there is no 0021). For the delivered scope, see the [overall architecture](ARCHITECTURE.md), [Local Alpha](M5_LOCAL_ALPHA.md) and the [acceptance matrix](ACCEPTANCE_MATRIX.md). The public service topology below is a deployment target, not an unimplemented backend: there is no public API host or Base Sepolia deployment yet, no paid model, LIVE approval is still rejected, and hosted services and external-user acceptance are not done.

## What runs today

`pnpm dev` starts five loopback hosts. The Web app is read-only explanations, docs and fictional REPLAY samples. The API defaults to the scaffold, and the Worker / Indexer business functions and the Signer are disabled by default, so nothing connects to a DB / RPC or signs before it is configured. For how to enable them, see [Local development](DEVELOPMENT.md). Once configured fully, the wiring that is implemented includes:

- The API enables identity, candidates, approval and public reads layer by layer, depending on mode. Trading mode also wires RFQ, faucet, and health/admin metrics, and calls the restricted signer with a caller token.
- With `WORKER_ENABLED=true` and a dedicated DB login, the Worker consumes the durable queue, the dispatch outbox and the schedules. Research, execution and trader combine according to their own settings, and cover fixture forecasts, evaluation, resolution jobs, reservation reconciliation, keeper, faucet and restricted transaction submission. Optional features that are not configured are not enabled automatically. `alert.*` outbox events are delivered at least once by a separate `alert.deliver` worker loop through at least one of the stdout / file / webhook sinks (see [Alert delivery](M5_ALERTS.md)). Alerts are produced from real conditions by `alert.evaluate` (every minute, in the main worker loop, with no keeper / signer / execution settings needed). The conditions are: budget (daily / question gate, signer gas cap rejection), pause (global / market / maker pool), RPC failure (reuses `BASE_SEPOLIA_RPC_URL`; not evaluated if unset), indexer lag, keeper timeout (due more than 600 chain seconds) and DEAD jobs. Each condition is one episode: OPEN is sent when it starts and CLEARED when it ends. A general condition sends STILL_OPEN every 60 minutes, and immediately when its reason changes. DEAD jobs (last 24 hours) and the question gate send STILL_OPEN immediately only when the count increases (no timed resend). When the source cannot be read (cursor gated or missing, query failed), that category produces neither OPEN nor CLEARED. The deadline alert `alert.deadline` is unchanged.
- With `CHAIN_INDEXER_ENABLED=true` and dedicated DB / RPC / deployment settings, the Indexer keeps syncing canonical blocks, events and projections and handles reorgs. Creation receipt polling and transaction tracking each have their own switches.
- With `SIGNER_ENABLED=true`, a key file, a DB login, RPC and a caller allowlist all in place, the Signer serves `POST /internal/sign`. It is wired to the trading API and the execution/trader Worker. The private key lives only in the signer. Caller authentication does not mean formal network isolation is done; see [Signer](M2_SIGNER.md).

`pnpm build:services` produces `dist/services/{api,worker,indexer,signer}.mjs`, the admin tool bundles and the migrations, and `pnpm test:service-build` verifies the standalone bundles. `infra/Dockerfile.{api,worker,indexer,signer}` each build one multi-stage image per service. The images are non-root and contain no npm / yarn / corepack at run time. `infra/compose.alpha.yaml` and `pnpm images:smoke` verify the whole set of services and the test-asset faucet with local containers. `--market` / `--full` additionally run quote fills and keeper settlement and redemption of a real-time REPLAY market (see [Service images](M5_SERVICE_IMAGES.md)). For the deployment steps and the offline env check `pnpm deploy:preflight`, see the [Deployment runbook](DEPLOYMENT_RUNBOOK.md). For the admin read-only status API and `pnpm ops:status`, see [Operator status](M5_OPERATOR_STATUS.md). Public deployment and the supply-chain release process have not been accepted.

`pnpm check` runs two TS typechecks, the Node unit / integration tests, package boundaries and Solidity contract compilation. `pnpm test:contracts` / `pnpm replay` verify the local ledger. `pnpm build` builds the Next.js Web app. `pnpm alpha:local` uses a dedicated local PostgreSQL and Anvil to verify the three REPLAY settlements and projection recovery. `pnpm drill:restore` rehearses locally a pg_dump backup, restore into a new database, replay of canonical events and quote reopening (see [Restore drill](M5_RESTORE_DRILL.md)). None of this equals a public Alpha, public-network finality, backup and restore in a hosted environment, or a security audit.

## Target Alpha topology

A single-region application host runs the API / Worker / Indexer. The Web app can share the host or be hosted. There is one managed PostgreSQL, a private S3-compatible bucket, and a primary and a backup Base Sepolia RPC. The Signer has a private host / container identity, separate secrets and a fixed caller allowlist. Do not use Kubernetes at first.

Until v0.1 quantifies the high-availability need, do not prepay for multi-region infrastructure. Cost is split into hosting/DB/object/RPC, model/data, and gas/faucet. The USD 20 per day is the model-data cap, not the total monthly hosting fee. The vendors, actual quotes and the deployment region are to be confirmed before deployment, and no monthly fee is invented here.

The local Compose is for PostgreSQL development only. A production image must update patches, pin digests, scan, and keep a manifest. No object storage provider has been chosen yet, so do not assume the local simulation has verified immutable storage.

## Service identity matrix

| Identity | DB/network | Key |
| --- | --- | --- |
| Web | The current static site does not connect to the backend; a future operator UI goes through the API only | None |
| API | Business DB privileges, a verified channel to the RFQ signer | None |
| Worker research | job/model/evidence/budget tables, allowlisted fetch/model | No on-chain private key |
| Worker execution | Restricted intent submission; does not accept arbitrary LLM calldata | No private key |
| Indexer | RPC, chain/projection tables | None |
| Signer maker/trader/faucet/keeper | Each reads and locks its own policy/intent/nonce, with restricted RPC / key-file; a secret store is a deployment target | Each role's own key |
| ADMIN/proposer/challenger/arbiter | Manual wallets, protected admin API | Not part of the automated worker/signer flow |

The Worker starts as one codebase, but at Alpha deployment research and execution must use different job allowlists / credentials. The maker EOA is a fixed signer. The four admin roles are distinct from each other and from the maker, and none may become a taker.

## Release manifest

deployments/base-sepolia/manifest.template.json is an undeployed template and cannot serve as runtime config. A real deployment needs artifact schema validation, a hard limit of chainId=84532, address / bytecode / ABI hashes, the deployment block, commit/compiler/dependencies, roles, and caps/price parameters. A new deployment gets a new deploymentId, and Web/API/signer all compare against it.

`deploymentBlock` is defined as the **inclusive safe replay lower bound** of the two contracts. It should be the earlier block number of the two deployment receipts. An earlier start (including 0) is safe but raises the scan cost. Besides checking the code / roles at the same head, the verifier also queries `deploymentBlock - 1` and requires that neither address had code at that point, so it does not miss early token or market events. This check applies to this project's contracts, which are fixed, non-upgradeable and have no selfdestruct. It is not a general proof of deployment history. If the RPC cannot provide the historical state that is needed, verification fails and the check is not skipped. Switch to a provider that supports that historical block. Finally, the head hash is still checked, which rejects a reorg during verification.

Mainnet is forbidden, and is rejected even if env says 8453. The deployment tool `pnpm contracts:deploy` is a dry run by default. Only with `--broadcast` does it read the deployment key and send transactions. For usage, checks and limits, see [M5 deployment tooling](M5_DEPLOYMENT_TOOLING.md). It has so far been verified only on a local Anvil (chainId 84532) and has not been deployed to Base Sepolia.

## Health and observability

- live only means the process can respond. The API scaffold through markets still returns 503 on `/v1/health` and `/health/ready`. Only trading mode injects the deployment health reader and the signer probe. Both paths use the same public readiness decision: ready is 200, otherwise 503.
- `/v1/health` publicly returns status / tradingEnabled / reasons. A valid admin key adds diagnostics such as queue / cursor / budget / maker pool, and an invalid or non-admin key gets 401 / 403. `/v1/admin/metrics` provides admin-only execution latency, persisted state / error counts and role/day gas, separate from the public forecast evaluation metrics. Readiness does not guarantee that an individual market or taker can fill; see [Health and metrics](M5_HEALTH_METRICS.md).
- Worker readiness only reflects whether the work loops are running. The Indexer's global `/health/ready` is still 503, and the chain index status is reported separately at `/health/chain-index`. After it is enabled, the Signer reports live from DB / deployment / RPC. Do not treat the readiness of different processes as one complete operational acceptance.
- trace: requestId → jobId → intentId → quote digest → tx hash / replacement → block hash.
- The target monitoring items also include queue age / attempt, indexer lag, unknown tx, reservation age, spent / unknown cost and keeper deadlines. This does not mean admin metrics already output each of them; the actual fields are as given in [Health and metrics](M5_HEALTH_METRICS.md).
- Logs do not record API keys, private keys or full provider secrets. Audit records actor/reason/hashes.
- Indexer lag >3 blocks OR an update stall >10 seconds stops new quotes. Deadline alerts do not depend on a single keeper process. `alert.evaluate` runs in every enabled Worker, even when the keeper is not configured. It is still recommended to run one more Worker with execution turned off, so that it is not held up by keeper jobs.
- Worker shutdown stops the schedules and the work loops, waits for work in flight and closes the pool. The Indexer stops its observation loops. Unresolved transactions and reservations are recovered / reconciled from durable records. Do not assume failure or release risk just because a process restarted. A complete operational shutdown / recovery still needs a deployment drill.

## Incidents and backup

A pause on new trades is separate from settlement / redemption of existing positions. Deployments are not upgradeable. A bug gets a new deployment, and old positions settle as already defined. Take a daily DB backup, with object versioning/retention. Before Alpha, rehearse a DB restore + canonical event replay, a data check and quote reopening. The local rehearsal is done ([Restore drill](M5_RESTORE_DRILL.md)). The hosted-environment rehearsal and the restore of archived objects still wait for deployment; for the steps, see the [Deployment runbook](DEPLOYMENT_RUNBOOK.md).

When the fee rate is undecided, the gas upper bound is unknown, or RPC finality capability is missing, stay stopped / unknown. Do not automatically assume free, failed or finalized.
