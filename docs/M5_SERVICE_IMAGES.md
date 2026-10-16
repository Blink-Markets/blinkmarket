# M5 service images — Task A1 delivery

中文摘要：API、Worker、Indexer、Signer 各有一個固定版本、非 root、只含自己 bundle 的容器映像；本機以 Compose 啟動 PostgreSQL、Anvil 與四個映像並驗證健康與就緒。市場流程不在容器內執行（Worker 拒絕位移的業務時鐘），仍由 `pnpm alpha:local` 驗證。

This slice makes the four backend services container images that build reproducibly from the existing esbuild bundles and run locally. Nothing is deployed, published to a registry, signed or paid for; all keys are the public Anvil test keys.

## Images

| Image | File | Listener | Notes |
| --- | --- | --- | --- |
| `blink-api` | `infra/Dockerfile.api` | 3001 (`API_PORT`) | `BLINK_API_MODE` selects the layers; `trading` needs the database, signer, RPC and object directories |
| `blink-worker` | `infra/Dockerfile.worker` | 3002, loopback only | Health listener is fixed in code; reachable only by the container's own healthcheck |
| `blink-indexer` | `infra/Dockerfile.indexer` | 3003 (`INDEXER_PORT`) | `CHAIN_INDEXER_ENABLED`, creation polling and tx tracking each have their own switch |
| `blink-signer` | `infra/Dockerfile.signer` | 3004 (`SIGNER_PORT`) | The only listener is the internal sign port; keep it on a private network |

Common rules, all enforced by `tests/images.test.mjs`:

- Two stages. The build stage runs `pnpm install --frozen-lockfile && pnpm build:services`; the runtime stage copies only `dist/services/<service>.mjs` (owned by `node`) and runs as `USER node`. The runtime layer holds that one file under `/app`: no `node_modules`, source, `.env`, `*.key`, `*.pem` or `contracts/artifacts`, and no dev dependency.
- One service per image; base `node:22.23.1-bookworm-slim` (exact version, digest below).
- `HEALTHCHECK` calls `/health/live`. `/health/ready` stays a separate answer for the orchestrator (503 for an unconfigured stub, 200 once the service's adapters are connected).
- Each entry fails closed with a code only (`IDENTITY_CONFIGURATION_REQUIRED`, `WORKER_CONFIGURATION_REQUIRED`, `INDEXER_TRACKER_CONFIGURATION_REQUIRED`, `SIGNER_CONFIGURATION_REQUIRED`), as `tests/service-build.test.mjs` asserts for the bundles.
- Nothing secret exists at build time: no build argument, no copied environment file. The image configuration carries no `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_DATABASE_URL` or `*_RPC_URL` variable. Credentials arrive as environment variables at run time; signer keys arrive as files.
- Signer keys are read only from the paths in `SIGNER_*_KEY_FILE`, which must be mode 0600 and readable by the `node` user (uid 1000). The smoke test seeds them into a named volume owned by `node`; a real deployment mounts its secret store at the same paths.

### Pinned artifacts (digests recorded when built, 2026-10-16)

| Reference | Digest |
| --- | --- |
| `node:22.23.1-bookworm-slim` (image index) | `sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3` |
| `postgres:17.6` (local Compose only) | `sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929` |
| `ghcr.io/foundry-rs/foundry:v1.7.1` (local Compose only) | `sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd` |

The Dockerfiles pin the exact tag, as `Dockerfile.api` already did. A release build should pin `tag@digest`, rebuild when the base receives a patch, scan the result and keep the build manifest (`docs/OPERATIONS.md`); none of that supply-chain work is done here.

## Commands

```sh
pnpm images:build     # docker build the four images as blink-<service>:local
pnpm test:images      # opt-in image tests (needs a Docker daemon and network for pnpm install); skips without Docker
pnpm images:smoke     # opt-in Compose smoke (below); not part of pnpm check or CI
```

`tests/images.test.mjs` builds the four images as `blink-<service>:test`, then per image checks: non-root user, the runtime layer holds exactly the bundle, no secret-shaped file or variable or private-key text, entry fails closed, and the container reports `healthy` from `/health/live` while `/health/ready` answers 503 unconfigured. Without a reachable Docker daemon every test is skipped with the reason `Docker daemon not available`. It is not in `pnpm test` or the CI `check` job.

## Local smoke (`infra/compose.alpha.yaml`, `pnpm images:smoke`)

Compose starts PostgreSQL 17.6, Anvil with chain ID 84532 and the four images; the file holds no secret and refuses to start a service whose required value is missing. The driver `scripts/images-smoke.ts`:

1. starts PostgreSQL and Anvil, migrates, creates one ordinary login per service (in exactly its own group) plus a registration login that is never given to a container;
2. deploys the contracts to Anvil, registers and verifies the deployment, funds the maker pool, switches `tradingEnabled` on in the deployment row;
3. seeds the signer key files (mode 0600, owner `node`) and the object directories into named volumes, then starts signer, API, indexer and worker;
4. asserts: all four containers are running, `healthy` and non-root; the signer and worker answer `/health/ready` 200; the indexer's `/health/chain-index` is ready; the API's `/v1/health` is `{status: ready, tradingEnabled: true, reasons: []}` and `/v1/config` reports chain 84532; no container log contains a generated password, caller token or key;
5. always runs `docker compose down -v`.

### Reduced scope (controller ruling for A1)

The brief's rule 4 asks for the Task 16 REPLAY scenarios against the containers. This smoke does not run a market. The worker container's start-up check refuses a shifted business clock (`assertProductionClock(pool, false)`), and the scenarios need the chain and `blink.now()` moved forward by hours to pass the forecast window, close and challenge periods. So the containerized stack proves configuration, least-privilege logins, key files, service-to-service reachability and readiness; the keeper finalization and the example agent's buy and redeem remain covered by `pnpm alpha:local` against in-process services. Running a market through the containers needs either a clock-shift hook in the worker bundle or real-time waiting; both are left as open items.

Other limits: the signer started in oracle fee mode (Anvil has no Base GasPriceOracle, so signing a transaction in the containerized signer is untested here); the image set is built for `linux/arm64` or `linux/amd64` by the local daemon only; no registry push, signing of images or vulnerability scan; the worker's health listener binds to loopback and is checked with `docker compose exec`.

## Verification

Run on 2026-10-16 with Docker 28.3.2:

- `node --test tests/images.test.mjs`: 16 pass, 0 fail (4 images × 4 checks).
- `pnpm images:smoke`: `IMAGES SMOKE ok: signer, api, indexer and worker healthy, non-root and ready (chain index lag 0)`; no container, volume or network left afterwards.
- `pnpm check`, `pnpm build:services && pnpm test:service-build`, `pnpm test:anvil`, `pnpm test:postgres`: `pnpm check` 619 pass; `test:service-build` 5 pass; `test:anvil` 50 pass; `test:postgres` 53 pass (all 0 failures). `pnpm build` was not needed: no web-consumed package changed.
