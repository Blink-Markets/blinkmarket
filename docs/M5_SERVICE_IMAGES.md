# M5 service images — Task A1 delivery

中文摘要：API、Worker、Indexer、Signer 各有一個固定版本、非 root、只含自己 bundle 的容器映像；本機以 Compose 啟動 PostgreSQL、Anvil 與四個映像並驗證健康與就緒。煙霧測試以容器內簽章的 faucet 鑄幣驗證簽章路徑；預設煙霧測試約 74 秒（堆疊就緒與 faucet 鑄幣），`--market` 約 34 分鐘（預測窗口與證據時間規則）並含報價與買入，`--full` 約 96 分鐘並含 keeper 結算與贖回。

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
pnpm images:smoke     # opt-in Compose smoke (below): fast stack + faucet, about 74 s
pnpm images:smoke -- --market   # adds a real-time market, quote and buy, about 34 min
pnpm images:smoke -- --full     # implies --market; adds keeper finalize and redeem, about 96 min
# neither is part of pnpm check or CI
```

`tests/images.test.mjs` builds the four images as `blink-<service>:test`, then per image checks: non-root user, the runtime layer holds exactly the bundle, no secret-shaped file or variable or private-key text, entry fails closed, and the container reports `healthy` from `/health/live` while `/health/ready` answers 503 unconfigured. Without a reachable Docker daemon every test is skipped with the reason `Docker daemon not available`. It is not in `pnpm test` or the CI `check` job.

## Local smoke (`infra/compose.alpha.yaml`, `pnpm images:smoke`)

`ALPHA_PROJECT` and `ALPHA_POSTGRES_PORT`/`ALPHA_ANVIL_PORT`/`ALPHA_API_PORT`/`ALPHA_INDEXER_PORT` override the Compose project name and host ports (defaults `blink-alpha`, 55420, 58545, 3001, 3003; the test PostgreSQL ports 55411-55415 are avoided). Compose starts PostgreSQL 17.6, Anvil with chain ID 84532 and the four images; the file holds no secret and refuses to start a service whose required value is missing. The driver `scripts/images-smoke.ts`:

1. rebuilds the four images from the working tree (`docker compose build`; an existing `blink-<service>:local` tag can come from an older commit, so it is never reused as is), starts PostgreSQL and Anvil (one block per second), migrates, creates one ordinary login per service (in exactly its own group) plus registration, identity and evidence logins that are never given to a container;
2. installs a GasPriceOracle stub at the OP-stack predeploy `0x4200...000F` with `anvil_setCode` (runtime code `0x600160005260206000f3`: every call returns an L1 fee of 1 wei; smoke only, the signer stays in its real oracle fee mode), deploys the contracts, registers and verifies the deployment (trading still off), funds the maker pool, allow-lists and funds the taker, invites the discovery, admin, three platform-forecaster and external-agent keys and registers the forecasters;
3. seeds the signer key files (mode 0600, owner `node`) and the object directories into named volumes, then starts signer, API, indexer and worker;
4. asserts all four containers are running, `healthy` and non-root, and the signer, worker and indexer ready (the default run then switches trading on and asserts the API reports `ready`);
5. faucet: the external agent binds its wallet and claims; the mint is signed by the signer container and lands on chain;
6. `--market` and `--full` only: a market, through the normal path with only the windows shortened as far as the rules allow: evidence import (host admin tool, copied into the data volume), discovery candidate, approval (spec archived by the API container), creation transaction, indexer ingest, forecast window, the three platform forecasts run by the worker container, trading switched on in the deployment row (no signer restart: since A9 the signer reads `tradingEnabled` per sign request), the API reports `{status: ready, tradingEnabled: true, reasons: []}`;
7. `--market` and `--full` only: the example agent (`examples/agent/run.ts`) quotes (the signer signs), approves exactly, fills, and the run asserts the indexer container ingested the position (`chain.positions` equals the contract's `getPosition`, 10 YES shares);
8. `--full` only: waits for the market to close, the proposer proposes, the keeper job in the worker container finalizes after the 120 s challenge (worker to signer bearer-token auth, the keeper send, one `FINALIZE_UNCHALLENGED` intent), the agent sees FINAL through the API and redeems; asserts the taker is paid 10,000,000 micro-bUSD and the maker 0, like `pnpm alpha:local`'s normal scenario;
9. no container log contains a generated password, caller token or key; always runs `docker compose down -v`.

The business clock is never shifted: the production guard (`assertProductionClock`) is unchanged and `BLINK_ALLOW_TEST_CLOCK` is not used, so everything runs in real time.

### Modes and durations

| Command | Adds | Measured |
| --- | --- | --- |
| `pnpm images:smoke` | stack healthy, non-root, ready; faucet mint signed and landed; API ready | 103 s including the image rebuild (2026-10-17, `main`) |
| `pnpm images:smoke -- --market` | a real-time REPLAY market, the platform forecasts, the example agent's quote and buy, the indexer's position | 2034 s, about 34 min (2026-10-17, `main`, fresh images, no signer restart) |
| `pnpm images:smoke -- --full` (or `IMAGES_SMOKE_FULL=1`) | implies `--market`; the market closes, propose, keeper finalize, agent redeem, balances | 5764 s, about 96 min |

The 34 minutes of `--market` are the shortest the normal path allows (no domain change):

- `packages/domain/src/forecast-windows.ts:20-29`: the earliest window ends at `closeAt - 1 h` and opens 30 minutes earlier, and only when `now < closeAt - 1 h`;
- `packages/application/src/rfq.ts:320` refuses every quote without a snapshot (409 `STALE_FORECAST`);
- `packages/adapters/src/platform-run-store.ts:86-93` and `packages/application/src/platform-forecaster.ts:143-157`: a forecaster reads only evidence observed at or before its window's opening (`NO_EVIDENCE_BEFORE_CUTOFF` otherwise), and `evidence.records.observed_at` is the import time.

So the smoke sets `closeAt` to the evidence's `observed_at` plus 5,550 s: the window opens 150 s after the import, ends about 32 minutes after it, and the first quote follows. `--full` then waits for the remaining hour to `closeAt`, and the 120 s challenge. The `--market` and `--full` durations were measured on 2026-10-17, on hardware shared with other agents (Docker 28.3.2, arm64); the final `--full` lines were:

```
IMAGES SMOKE faucet mint signed and landed
IMAGES SMOKE market 1 forecast snapshot ready
IMAGES SMOKE quote signed, fill landed, indexer ingested position: 10 YES shares
IMAGES SMOKE full: waiting 3598 s for the market to close
IMAGES SMOKE full: keeper finalized, agent redeemed 10000000 micro-bUSD, maker 0
IMAGES SMOKE ok (full): signer, api, indexer and worker healthy, non-root and ready; faucet mint signed; quote signed, market traded in the containers (chain index lag 0, 5764 s)
```

(The two long runs predate the mode split and printed a slightly different last line; their assertions are unchanged.)

An earlier `--full` run (5766 s) passed the same assertions and then failed only on collecting the logs (`spawnSync` output limit after an hour of logs); the helper now allows 512 MiB.

None of the modes is part of `pnpm check` or CI. Run the default for any image change, `--market` before merging a change to the signing, RFQ or indexer path, and `--full` as a release check.

### Notes and limits (input for the deployment runbook)

- The platform forecasters call the API through `@blink/client`, which accepts only HTTPS or a loopback host. In Compose the worker therefore shares the API container's network namespace (`network_mode: service:api`) and calls `http://127.0.0.1:3001`; a real deployment needs the worker to reach the API over HTTPS or on the same host.
- Fixed in A9: the signer used to read the deployment row only at start-up, so enabling trading needed a restart. It now reads `tradingEnabled` per sign request, and the `--market` mode no longer restarts it.
- The worker's `/health/ready` and `/health/live` listen on loopback only (fixed in `apps/worker/src/main.ts`), so an orchestrator cannot probe the worker from outside the container; the image's own healthcheck works, and the smoke checks readiness with `docker compose exec`.
- The worker's `tx.dispatch` job retried with `INTERNAL_ERROR` several times after the faucet mint before succeeding (Anvil never finalizes). Since A9 the worker records the dispatcher's own code, so the next run's `tx.dispatch` job rows show whether this is the expected `TX_PENDING`.
- The runtime stage removes npm, corepack and yarn from the filesystem (the base image's lower layer still contains them). No registry push, image signing or vulnerability scan; images are built for the local daemon's architecture only.
- Evidence and spec volumes are named volumes owned by `node`; a real deployment must provide the same ownership.

## Verification

Run on 2026-10-17 with Docker 28.3.2:

- `node --test tests/images.test.mjs`: 16 pass, 0 fail (4 images x 4 checks).
- `pnpm images:smoke` (fast default): ok in 74 s. `--market` ok in 2028 s and `--full` ok in 5764 s, measured before the mode split (not re-run after it); no container, volume or network left afterwards.
- Correction (controller, after the merge): until the smoke ran `docker compose build`, Compose reused any existing `blink-<service>:local` tag, and the tags on this machine dated from before the A1 fix rounds. The runs above therefore exercised older bundles; the Dockerfile properties themselves were verified by `tests/images.test.mjs`, which builds fresh `:test` images. A `--market` run on `main` after A9 failed with `TRADING_DISABLED` from such a stale signer image, which exposed the problem. With the rebuild in place, on `main`: fast ok in 103 s and `--market` ok in 2034 s, with no signer restart.
- `pnpm typecheck`: passes. `pnpm check` (619 pass) and `pnpm build:services && pnpm test:service-build` (5 pass) ran in round 2; round 3 changed only the smoke script and this document. Round 1 results for `test:anvil` (50 pass) and `test:postgres` (53 pass) stand. `pnpm build` was not needed: no web-consumed package changed.
