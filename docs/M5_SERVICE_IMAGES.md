# M5 service images — Task A1 delivery

中文摘要：API、Worker、Indexer、Signer 各有一個固定版本、非 root、只含自己 bundle 的容器映像；本機以 Compose 啟動 PostgreSQL、Anvil 與四個映像並驗證健康與就緒。煙霧測試以容器內簽章的 faucet 鑄幣驗證簽章路徑；市場流程需約一小時真實時間（預測窗口規則），仍由 `pnpm alpha:local` 驗證。

This slice makes the four backend services container images that build reproducibly from the existing esbuild bundles and run locally. Nothing is deployed, published to a registry, signed or paid for; all keys are the public Anvil test keys.

## Images

| Image | File | Listener | Notes |
| --- | --- | --- | --- |
| `blink-api` | `infra/Dockerfile.api` | 3001 (`API_PORT`) | `BLINK_API_MODE` selects the layers; `trading` needs the database, signer, RPC and object directories |
| `blink-worker` | `infra/Dockerfile.worker` | 3002, loopback only | Health listener is fixed in code; reachable only by the container's own healthcheck |
| `blink-indexer` | `infra/Dockerfile.indexer` | 3003 (`INDEXER_PORT`) | `CHAIN_INDEXER_ENABLED`, creation polling and tx tracking each have their own switch |
| `blink-signer` | `infra/Dockerfile.signer` | 3004 (`SIGNER_PORT`) | The only listener is the internal sign port; keep it on a private network |

Common rules, all enforced by `tests/images.test.mjs`:

- Two stages. The build stage runs `pnpm install --frozen-lockfile && pnpm build:services`; the runtime stage copies only `dist/services/<service>.mjs` (owned by `node`) and runs as `USER node`. The runtime layer holds that one file under `/app`: no `node_modules` anywhere (npm, corepack and yarn are removed from the runtime stage too), source, `.env`, `*.key`, `*.pem` or `contracts/artifacts`, and no dev dependency.
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

`ALPHA_PROJECT` and `ALPHA_POSTGRES_PORT`/`ALPHA_ANVIL_PORT`/`ALPHA_API_PORT`/`ALPHA_INDEXER_PORT` override the Compose project name and host ports (defaults `blink-alpha`, 55420, 58545, 3001, 3003; the test PostgreSQL ports 55411-55415 are avoided). Compose starts PostgreSQL 17.6, Anvil with chain ID 84532 and the four images; the file holds no secret and refuses to start a service whose required value is missing. The driver `scripts/images-smoke.ts`:

1. starts PostgreSQL and Anvil, migrates, creates one ordinary login per service (in exactly its own group) plus a registration login that is never given to a container;
2. deploys the contracts to Anvil, registers and verifies the deployment, funds the maker pool, switches `tradingEnabled` on in the deployment row;
3. seeds the signer key files (mode 0600, owner `node`) and the object directories into named volumes, then starts signer, API, indexer and worker;
4. installs the GasPriceOracle stub (below), invites an agent, binds a taker wallet and claims the faucet; asserts that the mint is signed and lands on chain;
5. asserts: all four containers are running, `healthy` and non-root; the signer and worker answer `/health/ready` 200; the indexer's `/health/chain-index` is ready; the API's `/v1/health` is `{status: ready, tradingEnabled: true, reasons: []}` and `/v1/config` reports chain 84532; no container log contains a generated password, caller token or key;
6. always runs `docker compose down -v`.

### Scope: signing is proven, a market is not (open item)

The smoke installs a GasPriceOracle stub with `anvil_setCode` at the OP-stack predeploy `0x4200...000F` (runtime code `0x600160005260206000f3`: every call returns an L1 fee of 1 wei; smoke only, the signer stays in its real oracle fee mode). It then invites an agent, binds the taker wallet, claims the faucet, and waits for the mint: API queues the claim, the worker asks the signer, the signer signs, the worker dispatches, and bUSD lands on chain. That proves the worker to signer bearer-token path, key-file signing and the object volumes' ownership inside containers.

It does not run a REPLAY market through keeper finalize and the example agent's buy and redeem. The production clock guard is unchanged (`BLINK_ALLOW_TEST_CLOCK` is not extended to the worker or API), so the containers run in real time, and a market cannot be traded in real time with short windows through the normal path:

- `packages/domain/src/forecast-windows.ts:24-29` (`plannedWindows`) plans only DAILY windows at UTC midnights before `closeAt` and a PRE_CLOSE window at `closeAt - 1 h`, and only `if (now < close - 3_600_000)`. A market whose `closeAt` is under an hour away has no forecast window unless a UTC midnight falls inside it, so no snapshot is ever produced.
- `packages/application/src/rfq.ts:320` then refuses every quote with 409 `STALE_FORECAST` (`!snapshot`).
- The shortest path that satisfies it is a `closeAt` of about 61 minutes (PRE_CLOSE window at about now plus 1 minute, already open), then close, propose, the fixed 120 s challenge and keeper finalize: roughly 65 to 70 minutes of real time, not a smoke. No bypass was added.

The settlement scenarios therefore stay in `pnpm alpha:local` (in-process services, shifted clock). Open items: either a real-time market stage that waits about an hour (a nightly job, not `images:smoke`), or a decision to let the window planner accept a short horizon for REPLAY markets (a domain change that needs the controller).

Other limits: the image set is built for the local daemon's architecture only; no registry push, image signing or vulnerability scan. Input for the deployment runbook: the worker's `/health/ready` and `/health/live` listen on loopback only (fixed in `apps/worker/src/main.ts`), so an orchestrator cannot probe the worker from outside the container; the image's own healthcheck works, and readiness is checked with `docker compose exec`. The runtime stage removes npm, corepack and yarn from the filesystem (the base image's lower layer still contains them).

## Verification

Run on 2026-10-16 with Docker 28.3.2:

- `node --test tests/images.test.mjs`: 16 pass, 0 fail (4 images × 4 checks).
- `pnpm images:smoke`: `IMAGES SMOKE ok: signer, api, indexer and worker healthy, non-root and ready, faucet mint signed and landed (chain index lag 0)`; no container, volume or network left afterwards.
- `pnpm check`, `pnpm build:services && pnpm test:service-build`, `pnpm test:anvil`, `pnpm test:postgres`: `pnpm check` 619 pass; `test:service-build` 5 pass; `test:anvil` 50 pass; `test:postgres` 53 pass (all 0 failures). `pnpm build` was not needed: no web-consumed package changed.
