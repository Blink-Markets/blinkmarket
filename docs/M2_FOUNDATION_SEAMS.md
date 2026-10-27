# M2 foundation seams (Wave 0)

> Historical (v0.1): this records the v0.1 foundation. P2 retired parts of it (the v0.1 chain schema and ABI module were replaced by the protocol index in Task 5), so check the code before relying on any seam described here. See [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md).

This slice lands the shared seams that later M2/M3 workstreams build on in parallel without editing the same code paths: an API route-service registry, the chain index schema (migration 0007) with a business clock, the canonical Blink ABI module, test helpers, the new API modes and the full job-type list. It adds no business behavior: no route service is registered, nothing writes the new tables, no transaction is signed or sent, and trading stays disabled.

## What was added

| Seam | Where | Behavior |
| --- | --- | --- |
| Route-service registry | `packages/application/src/route-service.ts`, `apps/api/src/server.ts` | A `RouteService` claims exact contract paths. The server validates params and query against the contract (400 `INVALID_REQUEST`), requires a valid `Idempotency-Key` on POST, lowercases hex params, then calls `handle`. |
| Errors | `IdentityError` options | `details`, `retryable` (default: only `REQUEST_IN_PROGRESS`) and `retryAfterSeconds` (sets `Retry-After`; `REQUEST_IN_PROGRESS` without it sends `1`). Any other thrown error is a 500 `INTERNAL_ERROR` with empty `details` and is logged server-side. Existing call sites are unchanged. |
| Responses | `ServiceResponse` | Default `Cache-Control: no-store`, overridable by the service's own headers. A `Uint8Array` body is sent byte for byte with its `contentType`. Error bodies get a `requestId` if they lack one. |
| Build-time checks | `buildApi` | A path claimed twice (two services, or a service and a built-in identity/preparation/approval option) throws `DUPLICATE_ROUTE_SERVICE`. A service path that is not an `apiContracts` path throws `UNKNOWN_ROUTE_SERVICE_PATH`. `/openapi.json` marks service paths `enabled`. |
| Public read limit | `apps/api/src/rate-limit.ts`, `publicReadLimit` | In-process token bucket per `request.ip` for GET (and HEAD) contract routes whose `access` starts with `public`: 429 `RATE_LIMITED` with `Retry-After`. Idle keys are evicted least-recently-used first (`maxKeys`, default 10,000). `publicReadLimit.now` injects the clock for tests. |
| Config and stage | `buildApi({ config, stage })`, `ConfigResponse` | `/v1/config` can be supplied; stages gain `m2-markets` and `m2-trading`; `tradingEnabled` is a boolean and `deployment` is `null` or `PublicDeployment` (the manifest without `status`, `tradingEnabled`, `gitCommit`, `dependencies` and `compiler`, built from the manifest schema's own member schemas). The default response is unchanged (`false` / `null`). |
| API modes | `apps/api/src/config.ts`, `main.ts` | `scaffold < identity < preparation < approval < markets < trading`. `markets` also needs `BLINK_DEPLOYMENT_ID` (`MARKETS_CONFIGURATION_REQUIRED`); `trading` also needs `SIGNER_URL`, `SIGNER_CALLER_TOKEN` and `BASE_SEPOLIA_RPC_URL` (`TRADING_CONFIGURATION_REQUIRED`). For now both compose the approval-mode services and register no route service. |
| Chain index schema | `0007_chain_index.sql` | `blink.now()`, `chain.cursors` (fenced lease), `blocks`, `events`, and the rebuildable projections `markets`, `positions`, `maker_state`, `quote_digests`, `takers`. Only `blink_indexer` writes; events and blocks can change only their `canonical` flag. |
| Business clock | `blink.now()`, `assertProductionClock` | `blink.now()` is `clock_timestamp()` plus the optional `blink.test_clock_offset_seconds` setting for local harnesses. `assertProductionClock(pool, allowTestClock)` throws `TEST_CLOCK_FORBIDDEN` when the setting is non-empty and test clocks are not allowed. |
| ABI module | `packages/adapters/src/blink-abi.ts` | `blinkMarketAbi`, `blinkTestUsdAbi`, `blinkEventNames` / `BlinkEventName`, written with `parseAbi`. `tests/blink-abi.test.ts` compares each entry with the compiled artifact. |
| Job types | `packages/domain/src/index.ts`, `apps/worker/src/registry.ts` | `JobType` and the worker registry list the same 19 job types. |
| Test helpers | `tests/helpers/database.ts`, `tests/helpers/anvil.ts` | `createTestDatabase`, `inviteAgent`, `bindWallet` (PGlite, one serialized session); `startAnvil`, `deployBlink` (isolated local Anvil with chain ID 84532, public test mnemonic, snapshot/revert/mine/timestamp helpers). |
| Scripts and CI | `package.json`, `.github/workflows/ci.yml` | `check` runs `check:contracts` before `test` (tests read `contracts/artifacts`). `test:postgres` runs every file in `tests/postgres/`. New `test:anvil`, which CI runs after `test:contracts`. |

## Verification

Run on 2026-10-14 in the task worktree.

- `pnpm check`: exit 0. TypeScript (including the web typecheck), contract compilation, 129 Node tests (102 existing plus 27 new) and package boundaries.
- `pnpm build`: exit 0.
- `pnpm build:services && pnpm test:service-build`: exit 0, 2 bundle tests pass.
- `pnpm test:anvil`: exit 0, 1 test (Anvil start, contract deployment, manifest parsing, snapshot/revert, next-block timestamp, stop).
- `TEST_POSTGRES_ADMIN_URL=… pnpm test:postgres` against a local PostgreSQL 17: exit 0, the existing identity concurrency test passes with migrations through 0007 applied to real PostgreSQL. A throwaway script (not committed) also confirmed on that server that `blink.now()` honors a database-level offset and that `assertProductionClock` refuses it.
- New tests: `tests/api-route-services.test.ts`, `tests/api-config.test.ts`, `tests/chain-index-migration.test.ts`, `tests/blink-abi.test.ts`, `tests/job-registry.test.ts`, `tests/database-helpers.test.ts`, `tests/anvil/helper.test.ts`.
- `tests/database.test.ts` previously asserted exactly six migrations; it now counts the migration files so adding a migration no longer edits it.

## Remaining limits

- Nothing writes the 0007 tables yet; the indexer (Task 5) and later projections own that. The migration grants are tested on PGlite, with real-PostgreSQL coverage limited to the migration applying and the clock function.
- `assertProductionClock` is exported but not yet called by any service entry point. Wiring it needs a decision on the explicit local test-mode flag.
- The public read limit is in-process (one API instance) and keyed by `request.ip`; behind a proxy every client shares the proxy's address until trusted-proxy handling is configured. Many distinct addresses can evict an active client's bucket, which bounds memory at the cost of strictness. A shared limiter is an open item before horizontal scaling.
- At this foundation checkpoint, `/v1/health` still reported not-ready with `tradingEnabled: false` in every stage. Task 16a subsequently wired real health/readiness in trading mode; scaffold through markets still report not-ready. See [M5_HEALTH_METRICS.md](M5_HEALTH_METRICS.md).
- The Fastify request logger stays enabled, so route tests print request log lines.
