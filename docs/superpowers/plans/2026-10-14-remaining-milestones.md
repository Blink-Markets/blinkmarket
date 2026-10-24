# Remaining Milestones (M2 completion, M3, M5 tooling) Implementation Plan

_Status: historical — Tasks 1-17 closed on 2026-10-16 (e5eec28); the team-operated roles it built are replaced by the 2026-10-23 direction change (docs/ROADMAP.md). Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Complete on 2026-10-16. Tasks 1–17 are merged on `main` and each passed its task review; the whole-branch review's two Important findings (the trader's open cap, unthrottled health endpoints) and six of its Minors were fixed and re-reviewed. Everything is verified locally (`pnpm check`, `pnpm build`, the service bundles, `pnpm alpha:local`, the Anvil and PostgreSQL suites) and in CI; nothing is deployed. Parked findings moved to the Open Items of [`2026-10-15-public-alpha-readiness.md`](2026-10-15-public-alpha-readiness.md).

**Goal:** Finish the Blink v0.1 backend so the spec §2.1 vertical flow (evidence → candidate → approval → market → forecasts → RFQ → fill → index → resolution → redeem → scores) runs end to end on a local Base Sepolia–shaped stack (Anvil with chain ID 84532), with every §17.2 scenario covered by automated tests.

**Architecture:** Keep the existing modular monolith: shared `schemas → domain → ports → application`, `adapters` for PostgreSQL/viem/filesystem, `apps/*` as composition roots. A short Wave 0 lands the seams that every later task shares: an API route-service registry, the chain index schema, a business clock function and test helpers. Later tasks then run in parallel git worktrees, and each one owns its migration number, its application service and its tests. Platform agents (discovery, forecasters, baseline, internal trader) call the public API with invited keys, the same path an external agent uses.

**Tech Stack:** Node 22, TypeScript 5.9 (ESM), Fastify, PostgreSQL 17 (PGlite in unit tests), viem 2.56.8, Solidity 0.8.30 + Foundry/Anvil 1.7.1, zod 4, node:test.

**Spec:** `Blink_MVP_v0.1_Base_Sepolia_Spec.md` (binding product authority), refined by `docs/design/01–06`, `docs/adr/0002-protocol-boundaries.md`, `docs/DATA_MODEL.md`, `docs/OPERATIONS.md`. Where the design docs and the spec differ, the design docs win only where ADR 0002 records the refinement.

## Global Constraints

- Chain: only chain ID 84532. Any code path that sees 8453 must refuse with `MAINNET_REFUSED`; no environment variable bypasses this.
- Money and chain integers: `bigint` in code, decimal strings on the wire, `blink.uint256`/NUMERIC in SQL. Never floats. Probability: finite, 0..1, at most 6 decimals, SQL `NUMERIC(7,6)`; pricing uses integer millionths.
- Business time: PostgreSQL `blink.now()` (added in Task 1) for windows, budgets, faucet windows and deadlines. Quote validity uses the canonical **block timestamp**, never the API host clock.
- No paid model or data provider calls, no fetches of real external URLs in tests, no Base Sepolia transactions. Chain work runs only on a local Anvil started with `--chain-id 84532` and the public test mnemonic `test test test test test test test test test test test junk`.
- Private keys exist only in the signer process, loaded from files (mode 0600), never from the database, logs, API responses or the LLM/research worker.
- Package boundaries (`pnpm check:boundaries`): `schemas` ← `domain` ← `ports` ← `application`; `adapters` → `schemas, ports`; no `fastify|next|pg|viem|node:` imports in `schemas/domain/ports`; `schemas/domain/client` relative imports name real `.ts` files.
- Every POST: `Idempotency-Key` (1–128 printable ASCII). Scope = operator + `METHOD resolved-path`; payload hash = hash of `{keyId, normalized body}`. Same key + same payload returns the stored result (even if now expired); a different payload returns 409 `IDEMPOTENCY_CONFLICT`; in flight returns 409 `REQUEST_IN_PROGRESS` with `Retry-After`. Reuse the existing `claimRequest`/`finishRequest` store methods.
- Error envelope: `{code, message, requestId, retryable, details}`; codes from spec §10.3 plus those named in this plan. Missing and unauthorized private resources both return 404.
- DB roles: `blink_api`, `blink_worker`, `blink_indexer`, `blink_signer` get least-privilege grants in the migration that creates a table; append-only tables use the `operations.reject_mutation()` trigger; runtime startup refuses privileged logins (follow `assertIdentityRuntimeRole`).
- Migrations 0001–0006 are frozen. Each task uses only its assigned migration number (table below).
- Each task ends with `pnpm check` passing. Tasks that touch `packages/schemas`, `packages/domain` or `packages/client` also run `pnpm build`. Tasks that add service code also run `pnpm build:services && pnpm test:service-build`. Tasks with Anvil tests run `pnpm test:anvil`.
- Real-PostgreSQL concurrency tests go in `tests/postgres/<task>.test.ts` and require `TEST_POSTGRES_ADMIN_URL`; CI runs them. Local runs may skip them only when the variable is unset, and the task report must say so.
- Each task writes one delivery record, `docs/<MILESTONE>_<NAME>.md` (English with a one-line Chinese summary, like `docs/M2_CREATION_TRACKING.md`), listing scope, verification commands with results, and remaining limits. Tasks do not edit `docs/ROADMAP.md` (the controller does).
- Branch per task: `ws/t<N>-<slug>`. Commit there; do not push; do not merge.

| Migration | Owner |
| --- | --- |
| `0007_chain_index.sql` | Task 1 |
| `0008_jobs_budgets.sql` | Task 2 |
| `0009_forecasts.sql` | Task 7 |
| `0010_signing.sql` | Task 8 |
| `0011_tx_tracking.sql` | Task 6 |
| `0012_trading.sql` | Task 9 |
| `0013_execution.sql` | Task 13 |
| `0014_resolution.sql` | Task 11 |
| `0015_evaluation.sql` | Task 12 |
| `0016_evidence_fetch.sql` | Task 3 |
| `0017_discovery_runs.sql` | Task 10 |
| `0018_trader.sql` | Task 14 |

## Rulings (made while planning; the user may override)

1. **No wallet/trading/admin web UI in this plan.** The user decided that the public site is a read-only explainer. Spec §13's trading, positions and admin pages stay an open item that needs the user's decision.
2. **No Sepolia deployment, real role wallets, RPC/hosting/object-storage providers, paid model provider, real LIVE companies/sources, external user acceptance or demo video.** These need the user's authorization (AGENTS.md excludes deployment, paid services and real signing). The plan ships tooling for them plus local verification.
3. **Model access** is a `ModelGateway` port with a deterministic fixture gateway (REPLAY). No real provider adapter.
4. **Signer caller authentication** uses per-caller bearer tokens (SHA-256 hashes in config) over loopback/private HTTP. mTLS and network ACLs are deployment items.
5. **Platform agents act through the public API** with invited keys via `@blink/client`. This proves §17.2 S12 and avoids giving the worker DB write grants on candidate/forecast tables.
6. **Rate limits are in-process** (one API instance in v0.1). A shared limiter is an open item before horizontal scaling.
7. **Signed raw transactions** live in a signer-only table without app-level encryption; encryption at rest is a deployment item.
8. **LIVE approval stays rejected** until real official sources are configured (open item).
9. **Auto-fetched evidence** gets the source's reviewed `fetch_access_policy` (default `PRIVATE`), never `EXCERPT`; humans re-review before public use.

## Review Focus

1. **Clock disagreement:** the DB clock, the API host clock and the chain block timestamp disagree by seconds to minutes. Quotes must expire by block time, windows must close by DB time, and none of them may be extended by a lagging clock. Owner tests: Task 7 (window lock + DB clock), Task 9 (local clock past expiry but cursor not → reservation stays HELD).
2. **A reorg after money moved:** an indexed fill is orphaned after its reservation was ACCOUNTED. The pool must return to RECONCILE_REQUIRED, the quote gate must close until reconciled, and positions must never double count. Owner tests: Task 5 (Anvil snapshot/revert reorg), Task 9 (reorg rollback of ACCOUNTED).
3. **Retry storms with the same Idempotency-Key** while the first attempt's signer call is still in flight or timed out. They must return the same quote, never a second signature or reservation. Owner test: Task 9 (sign timeout then retry).
4. **Concurrent requests competing for one limit** (last maker collateral, daily model budget, faucet window, trader mandate). Exactly the cap is admitted. Owner tests: real-PostgreSQL races in Tasks 2, 9, 13, 14.
5. **Hostile input reaching privileged code:** a fetched document with prompt-injection text, a redirect to `169.254.169.254`, a quote body with a foreign taker, or a request carrying arbitrary calldata. None of them reaches a signer or a private network. Owner tests: Task 3 (SSRF table), Task 8 (selector/value/to allowlist), Task 10 (injection fixture).

---

## Wave plan

| Wave | Tasks | Starts when |
| --- | --- | --- |
| 0 + 1a | 1 Foundation · 2 Jobs/budgets/model gateway · 3 Evidence fetcher · 4 Deployment tooling | now (2–4 do not depend on 1) |
| 1b | 5 Chain indexer · 6 Public reads + tx tracking · 7 Forecasts · 8 Signer + dispatcher | Task 1 merged |
| 2 | 9 RFQ (after 5,7,8) · 10 Discovery/forecaster workers (after 2,3,7) · 11 Resolution (after 2,5) · 12 Evaluation/metrics (after 2,7) · 13 Keeper + faucet (after 2,5,8) | dependencies merged |
| 3 | 14 Internal trader (after 9,13) · 15 Client SDK + example agent (after 6,7,9,13) · 16 Local Alpha harness + readiness (after all) · 17 Docs and roadmap (controller) | dependencies merged |

---

### Task 1: Foundation seams

**Goal:** Land the shared seams that let Wave 1b–3 tasks work in parallel without editing the same code paths: an API route-service registry, the chain index schema, a business clock, the canonical Blink ABI module, test helpers, and the new API modes.

**Files:**
- Create: `packages/application/src/route-service.ts`, `apps/api/src/rate-limit.ts`, `packages/adapters/migrations/0007_chain_index.sql`, `packages/adapters/src/blink-abi.ts`, `packages/adapters/src/business-clock.ts`, `tests/helpers/database.ts`, `tests/helpers/anvil.ts`, `tests/api-route-services.test.ts`, `tests/chain-index-migration.test.ts`, `tests/blink-abi.test.ts`, `tests/anvil/helper.test.ts`, `docs/M2_FOUNDATION_SEAMS.md`
- Modify: `apps/api/src/server.ts`, `apps/api/src/config.ts`, `apps/api/src/main.ts`, `packages/application/src/identity.ts` (IdentityError options), `packages/application/src/index.ts`, `packages/adapters/src/index.ts`, `packages/schemas/src/http.ts` (ConfigResponse), `packages/schemas/src/deployment.ts` (PublicDeployment), `packages/domain/src/index.ts` (JobType), `apps/worker/src/registry.ts`, `package.json` (scripts), `.github/workflows/ci.yml`, `tests/indexer-config.test.ts` only if mode parsing changes break it

**Interfaces — Produces:**

```ts
// packages/application/src/route-service.ts
export interface ServiceRequest {
  method: "GET" | "POST";
  path: string; // contract path, e.g. "/v1/markets/:id"
  params: Record<string, string>; // validated + lowercased hex where the contract uses Address/Hash
  query: Record<string, unknown>; // parsed with the contract query schema (coerced)
  body: unknown; // raw; services parse with the contract body schema
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  requestId: string;
  ip: string;
}
export interface ServiceResponse {
  status: number;
  body: Record<string, unknown> | Uint8Array;
  contentType?: string; // default application/json
  headers?: Record<string, string>; // e.g. Cache-Control, ETag, Retry-After
}
export interface RouteService {
  readonly paths: readonly string[]; // exact apiContracts paths
  handle(request: ServiceRequest): Promise<ServiceResponse>;
}
```

```ts
// packages/application/src/identity.ts — IdentityError gains options (existing calls unchanged)
export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    options?: { details?: Record<string, unknown>; retryable?: boolean; retryAfterSeconds?: number },
  );
  readonly details: Record<string, unknown>; // default {}
  readonly retryable: boolean; // default code === "REQUEST_IN_PROGRESS"
  readonly retryAfterSeconds: number | undefined;
}
```

```ts
// apps/api/src/server.ts
export function buildApi(options?: {
  identity?: IdentityService;
  preparation?: PreparationService;
  approval?: ApprovalService;
  services?: RouteService[];
  stage?: "architecture" | "m2-identity" | "m2-preparation" | "m2-approval" | "m2-markets" | "m2-trading";
  config?: () => Promise<ConfigResponse>; // default: current static response
  publicReadLimit?: { capacity: number; refillPerSecond: number }; // e.g. {capacity: 60, refillPerSecond: 1}
}): FastifyInstance;
```

```ts
// apps/api/src/rate-limit.ts
export function createTokenBucket(options: { capacity: number; refillPerSecond: number; now?: () => number; maxKeys?: number }): {
  take(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
};
```

```ts
// packages/adapters/src/blink-abi.ts — the one ABI source for adapters/apps/scripts
export const blinkMarketAbi: Abi; // all functions/events/errors of IBlinkMarket + public getters used by readers
export const blinkTestUsdAbi: Abi; // ERC-20 subset + mint + minter + decimals
export type BlinkEventName = "MarketCreated" | "TradingPauseChanged" | "TakerAllowedChanged" | "MakerDeposited" | "MakerWithdrawn" | "QuoteFilled" | "QuoteCancelled" | "MakerEpochIncremented" | "OutcomeProposed" | "OutcomeChallenged" | "OutcomeFinalized" | "PositionRedeemed";
```

```ts
// packages/adapters/src/business-clock.ts
export async function assertProductionClock(pool: Pool, allowTestClock: boolean): Promise<void>; // throws TEST_CLOCK_FORBIDDEN when blink.test_clock_offset_seconds is set and !allowTestClock
```

```ts
// tests/helpers/database.ts
export async function createTestDatabase(): Promise<{
  db: PGlite; pool: Pool; // PGlite + serialized single-session pool (copy the pattern in tests/preparation.test.ts setup())
  setRole(role: string): Promise<void>; // "SET ROLE <role>" with an allowlist of blink_* roles; "RESET ROLE" for null
  close(): Promise<void>;
}>;
export async function inviteAgent(t: Awaited<ReturnType<typeof createTestDatabase>>, input: { name: string; scopes: ApiScope[] }): Promise<{ apiKey: string; keyId: string; agentId: string; operatorId: string }>;
export async function bindWallet(t: Awaited<ReturnType<typeof createTestDatabase>>, agentId: string, address: string): Promise<void>; // direct insert as owner, for tests that are not about binding
```

```ts
// tests/helpers/anvil.ts
export async function startAnvil(options?: { chainId?: number }): Promise<{
  url: string; chainId: number;
  publicClient: PublicClient;
  accounts: { admin; maker; proposer; challenger; arbiter; minter; taker; taker2; keeper; trader }; // mnemonic indexes 0..9, viem LocalAccounts
  wallet(account): WalletClient;
  snapshot(): Promise<string>; revert(id: string): Promise<void>;
  mine(blocks?: number): Promise<void>; setNextTimestamp(seconds: bigint): Promise<void>;
  stop(): Promise<void>;
}>;
export async function deployBlink(anvil): Promise<{ market: Address; token: Address; deploymentBlock: bigint; manifest: DeploymentManifest }>; // deploys from contracts/artifacts like scripts/local-replay.ts, builds a valid manifest (tradingEnabled true)
```

**Rules:**
1. `buildApi` keeps every current behavior; all existing tests pass unchanged.
2. For paths owned by a `RouteService`, the server validates params and query against the contract (400 `INVALID_REQUEST`) and, for POST, requires a valid `Idempotency-Key` header (400) before calling `handle`. Address/hash params are lowercased.
3. A path claimed twice (two services, or a service plus a legacy option) throws `DUPLICATE_ROUTE_SERVICE` at build time.
4. `IdentityError` from `handle` maps to the error envelope with `details`, `retryable`, and `Retry-After` when `retryAfterSeconds` is set. Any other error is a 500 `INTERNAL_ERROR` without details.
5. Default `Cache-Control: no-store`; a response's own headers override it. A `Uint8Array` body is sent raw with its `contentType`. Error bodies (status ≥ 400) get `requestId` if missing.
6. `/openapi.json` marks service paths `enabled`.
7. `publicReadLimit` applies to GET contract routes whose `access` starts with `public`, keyed by `request.ip`; when exceeded it returns 429 `RATE_LIMITED` with `Retry-After`. Other routes are unaffected. The bucket map evicts idle keys (`maxKeys` default 10,000).
8. `apiConfig`: modes `scaffold < identity < preparation < approval < markets < trading`. `markets` and `trading` require everything `approval` needs plus `BLINK_DEPLOYMENT_ID` (`MARKETS_CONFIGURATION_REQUIRED`). `trading` additionally requires `SIGNER_URL`, `SIGNER_CALLER_TOKEN`, `BASE_SEPOLIA_RPC_URL` (`TRADING_CONFIGURATION_REQUIRED`). Return them as `deploymentId`, `signerUrl`, `signerToken`, `rpcUrl`. In `main.ts` the new modes compose identity+preparation+approval for now and pass `services: []` and the stage (`m2-markets`/`m2-trading`); later tasks add services.
9. `ConfigResponse`: stage enum gains `m2-markets` and `m2-trading`; `tradingEnabled: z.boolean()`; `deployment: z.union([z.null(), PublicDeployment])`. `PublicDeployment` = `DeploymentManifest` minus `status`/`tradingEnabled`/`artifacts.gitCommit`/`artifacts.dependencies`/`artifacts.compiler`, keeping `deploymentId, chainId, deploymentBlock, contracts, artifacts.abiHashes, artifacts.bytecodeHashes, roles, parameters`. The default server response is unchanged (`false`/`null`).
10. `JobType` becomes exactly: `"evidence.fetch" | "discovery.scan" | "candidate.validate" | "market.deploy" | "forecast.schedule" | "forecast.dispatch" | "forecast.run" | "baseline.run" | "budget.reconcile" | "quote.reconcile" | "chain.reconcile" | "tx.dispatch" | "tx.track" | "resolution.parse" | "resolution.alerts" | "keeper.finalize" | "faucet.mint" | "trader.evaluate" | "evaluation.score"`. `apps/worker/src/registry.ts` lists the same set.
11. `package.json`: `"check"` runs `check:contracts` **before** `test` (tests read `contracts/artifacts`). Add `"test:anvil": "node --import tsx --test tests/anvil/*.test.ts"` and change `"test:postgres"` to `node --import tsx --test tests/postgres/*.test.ts`. CI `check` job runs `pnpm test:anvil` after `pnpm test:contracts`.
12. `blink-abi.ts` uses `parseAbi` human-readable signatures. `tests/blink-abi.test.ts` asserts that every event/function/error signature in it equals the compiled artifact ABI (`contracts/artifacts/BlinkMarket.json`, `BlinkTestUSD.json`) for the same names.
13. Every new SQL in later tasks uses `blink.now()` for business time.

**0007_chain_index.sql (verbatim):**

```sql
-- Business clock. The offset setting exists only for local harnesses; services refuse to
-- start with it set unless explicitly in a local test mode (assertProductionClock).
CREATE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
  SELECT clock_timestamp() + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds', true), ''), '0')::double precision)
$$;
GRANT EXECUTE ON FUNCTION blink.now() TO blink_api, blink_worker, blink_indexer, blink_signer;

-- Per-deployment canonical cursor with a fenced lease. Projections below are rebuildable folds of canonical events.
CREATE TABLE chain.cursors (
  deployment_id TEXT PRIMARY KEY REFERENCES markets.deployments(id),
  block_number blink.uint256 NOT NULL,
  block_hash blink.hash NOT NULL,
  block_timestamp blink.uint256 NOT NULL,
  head_number blink.uint256 NOT NULL,
  finalized_number blink.uint256,
  synced_at TIMESTAMPTZ NOT NULL,
  gate_reason TEXT CHECK (gate_reason IN ('REORG_IN_PROGRESS','PROJECTION_MISMATCH','FINALIZED_CONFLICT')),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  lease_token BIGINT NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (head_number >= block_number)
);
CREATE TABLE chain.blocks (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  number blink.uint256 NOT NULL,
  hash blink.hash NOT NULL,
  parent_hash blink.hash NOT NULL,
  timestamp blink.uint256 NOT NULL,
  canonical BOOLEAN NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (deployment_id, hash)
);
CREATE UNIQUE INDEX blocks_canonical_height ON chain.blocks (deployment_id, number) WHERE canonical;
CREATE TABLE chain.events (
  deployment_id TEXT NOT NULL,
  block_hash blink.hash NOT NULL,
  block_number blink.uint256 NOT NULL,
  tx_hash blink.hash NOT NULL,
  tx_index INTEGER NOT NULL CHECK (tx_index >= 0),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  name TEXT NOT NULL CHECK (name IN ('MarketCreated','TradingPauseChanged','TakerAllowedChanged','MakerDeposited','MakerWithdrawn','QuoteFilled','QuoteCancelled','MakerEpochIncremented','OutcomeProposed','OutcomeChallenged','OutcomeFinalized','PositionRedeemed')),
  args JSONB NOT NULL CHECK (jsonb_typeof(args) = 'object'),
  canonical BOOLEAN NOT NULL,
  PRIMARY KEY (deployment_id, block_hash, tx_hash, log_index),
  FOREIGN KEY (deployment_id, block_hash) REFERENCES chain.blocks (deployment_id, hash)
);
CREATE INDEX events_canonical_order ON chain.events (deployment_id, block_number, tx_index, log_index) WHERE canonical;
CREATE TABLE chain.markets (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  market_id blink.uint256 NOT NULL CHECK (market_id > 0),
  spec_hash blink.hash NOT NULL,
  spec_uri TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('LIVE','REPLAY')),
  close_at blink.uint256 NOT NULL,
  proposal_deadline blink.uint256 NOT NULL,
  hard_deadline blink.uint256 NOT NULL,
  challenge_seconds INTEGER NOT NULL CHECK (challenge_seconds > 0),
  max_pairs blink.uint256 NOT NULL,
  max_taker_shares blink.uint256 NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','PROPOSED','DISPUTED','FINAL')),
  paused BOOLEAN NOT NULL DEFAULT false,
  proposed_outcome TEXT CHECK (proposed_outcome IN ('YES','NO','INVALID')),
  proposed_at blink.uint256,
  proposal_evidence_hash blink.hash,
  challenge_evidence_hash blink.hash,
  final_outcome TEXT CHECK (final_outcome IN ('YES','NO','INVALID')),
  final_reason TEXT CHECK (final_reason IN ('UNCHALLENGED','ARBITRATED','TIMEOUT')),
  final_evidence_hash blink.hash,
  total_pairs blink.uint256 NOT NULL DEFAULT 0,
  escrow_micros blink.uint256 NOT NULL DEFAULT 0,
  created_block_number blink.uint256 NOT NULL,
  created_tx_hash blink.hash NOT NULL,
  as_of_block_hash blink.hash NOT NULL,
  PRIMARY KEY (deployment_id, market_id),
  UNIQUE (deployment_id, spec_hash)
);
CREATE TABLE chain.positions (
  deployment_id TEXT NOT NULL,
  market_id blink.uint256 NOT NULL,
  account blink.address NOT NULL,
  yes_shares blink.uint256 NOT NULL DEFAULT 0,
  no_shares blink.uint256 NOT NULL DEFAULT 0,
  taker_bought_shares blink.uint256 NOT NULL DEFAULT 0,
  redeemed_payout_micros blink.uint256 NOT NULL DEFAULT 0,
  as_of_block_hash blink.hash NOT NULL,
  PRIMARY KEY (deployment_id, market_id, account)
);
CREATE TABLE chain.maker_state (
  deployment_id TEXT PRIMARY KEY REFERENCES markets.deployments(id),
  free_balance_micros blink.uint256 NOT NULL DEFAULT 0,
  epoch blink.uint256 NOT NULL DEFAULT 0,
  global_paused BOOLEAN NOT NULL DEFAULT false,
  as_of_block_hash blink.hash NOT NULL
);
CREATE TABLE chain.quote_digests (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  digest blink.hash NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('FILLED','CANCELLED')),
  market_id blink.uint256,
  taker blink.address,
  side TEXT CHECK (side IN ('YES','NO')),
  quantity blink.uint256,
  price_bps INTEGER CHECK (price_bps BETWEEN 1 AND 9999),
  taker_cost_micros blink.uint256,
  maker_cost_micros blink.uint256,
  block_number blink.uint256 NOT NULL,
  block_hash blink.hash NOT NULL,
  tx_hash blink.hash NOT NULL,
  PRIMARY KEY (deployment_id, digest),
  CHECK ((state = 'FILLED') = (market_id IS NOT NULL AND taker IS NOT NULL))
);
CREATE TABLE chain.takers (
  deployment_id TEXT NOT NULL REFERENCES markets.deployments(id),
  account blink.address NOT NULL,
  allowed BOOLEAN NOT NULL,
  as_of_block_hash blink.hash NOT NULL,
  PRIMARY KEY (deployment_id, account)
);
GRANT USAGE ON SCHEMA chain TO blink_worker, blink_signer;
GRANT SELECT ON chain.cursors, chain.blocks, chain.events, chain.markets, chain.positions, chain.maker_state, chain.quote_digests, chain.takers TO blink_api, blink_worker;
GRANT SELECT ON chain.cursors, chain.markets, chain.maker_state, chain.quote_digests, chain.takers TO blink_signer;
GRANT SELECT, INSERT, UPDATE ON chain.cursors TO blink_indexer;
GRANT SELECT, INSERT ON chain.blocks, chain.events TO blink_indexer;
GRANT UPDATE (canonical) ON chain.blocks, chain.events TO blink_indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON chain.markets, chain.positions, chain.maker_state, chain.quote_digests, chain.takers TO blink_indexer;
```

**Tests (must exist and pass):**
- `tests/api-route-services.test.ts`: (a) a fake service returns its status/body on `GET /v1/markets`; (b) duplicate path → `DUPLICATE_ROUTE_SERVICE`; (c) `GET /v1/markets/abc?deploymentId=x` → 400 and `handle` not called; (d) POST without `Idempotency-Key` → 400; (e) `IdentityError(409,"NO_QUOTE",{details:{reason:"STALE_FORECAST"},retryAfterSeconds:2})` → 409 envelope with details and `Retry-After: 2`; (f) `Uint8Array` body with `application/json` is returned byte for byte; (g) with `publicReadLimit {capacity: 60, refillPerSecond: 1}` and an injected clock, the 61st public GET from one IP → 429 `RATE_LIMITED` with `Retry-After`, while another IP and a non-public route still succeed; (h) `/openapi.json` marks the service's paths `enabled`; (i) a thrown plain `Error` → 500 without details; (j) Address params are lowercased before `handle`.
- `tests/chain-index-migration.test.ts`: migrate on PGlite; `blink.now()` ≈ `clock_timestamp()`; with `SET blink.test_clock_offset_seconds = '3600'` it is ~1 h ahead; `blink_indexer` can insert/update/delete `chain.markets` and update `canonical` on events; `blink_api` gets permission denied inserting into `chain.markets`; `blink_indexer` cannot update `chain.events.args`; two canonical blocks at the same height violate `blocks_canonical_height`; a negative `free_balance_micros` is rejected.
- `tests/blink-abi.test.ts`: ABI parity (Rule 12).
- `tests/anvil/helper.test.ts`: `startAnvil` + `deployBlink` produce a manifest that `DeploymentManifest.parse` accepts and whose addresses have code; snapshot/revert round-trips; `stop()` kills the process.
- Existing `tests/*.test.ts` unchanged and passing; config tests for the new modes (missing `BLINK_DEPLOYMENT_ID` → `MARKETS_CONFIGURATION_REQUIRED`; trading without signer → `TRADING_CONFIGURATION_REQUIRED`).

**Steps:**
- [ ] Write the failing tests above.
- [ ] Run `pnpm test` → the new tests fail (missing modules).
- [ ] Implement route-service types, server registry, rate limiter, config modes, IdentityError options, ConfigResponse/PublicDeployment schema, JobType list, migration 0007, `blink-abi.ts`, `business-clock.ts`, helpers and scripts.
- [ ] Run `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`, `pnpm test:anvil` → all pass.
- [ ] Write `docs/M2_FOUNDATION_SEAMS.md`; commit `feat: shared seams for M2/M3 workstreams` on `ws/t1-foundation`.

---

### Task 2: Jobs, outbox dispatch, budgets and model gateway

**Goal:** A durable job runtime (lease, heartbeat, fencing, retry, dead-letter), an outbox dispatcher, the USD research budget ledger (spec §12.5, design 05), and a budgeted model-call use case behind a `ModelGateway` port with a deterministic fixture gateway.

**Depends on:** nothing (runs parallel to Task 1). Use existing job types (`"evidence.fetch"` etc.) in tests.

**Files:**
- Create: `packages/adapters/migrations/0008_jobs_budgets.sql`, `packages/ports/src/jobs.ts`, `packages/ports/src/budgets.ts`, `packages/domain/src/jobs.ts`, `packages/domain/src/costs.ts`, `packages/application/src/worker-runtime.ts`, `packages/application/src/budgeted-model.ts`, `packages/adapters/src/job-queue.ts`, `packages/adapters/src/outbox-dispatcher.ts`, `packages/adapters/src/budget-ledger.ts`, `packages/adapters/src/fixture-model-gateway.ts`, `apps/worker/src/config.ts`, `apps/worker/src/handlers.ts`, `tests/job-queue.test.ts`, `tests/budget-ledger.test.ts`, `tests/budgeted-model.test.ts`, `tests/worker-runtime.test.ts`, `tests/postgres/jobs-budgets.test.ts`, `docs/M3_JOBS_BUDGETS.md`
- Modify: `packages/ports/src/index.ts` (remove the draft `JobQueue`/`ModelGateway`; re-export from the new files), `packages/domain/src/index.ts` (export `./jobs.ts`, `./costs.ts`), `packages/application/src/index.ts`, `packages/adapters/src/index.ts`, `apps/worker/src/main.ts`, `apps/worker/package.json` (add `@blink/adapters`, `@blink/application`, `pg`), `scripts/build-services.mjs` if the worker bundle needs new externals

**Interfaces — Produces:**

```ts
// packages/ports/src/jobs.ts
export interface JobSpec { type: JobType; dedupeKey: string; payload: Record<string, unknown>; runAt?: Date; maxAttempts?: number }
export interface LeasedJob { id: string; type: JobType; payload: Record<string, unknown>; attempt: number; maxAttempts: number; leaseToken: string; workerId: string }
export interface JobQueue {
  enqueue(spec: JobSpec): Promise<{ jobId: string; created: boolean }>;
  lease(workerId: string, types: readonly JobType[], leaseMs: number): Promise<LeasedJob | null>;
  heartbeat(job: LeasedJob, leaseMs: number): Promise<boolean>;
  complete(job: LeasedJob): Promise<boolean>;
  fail(job: LeasedJob, error: { code: string; retryable: boolean }): Promise<"RETRY" | "DEAD" | "STALE">;
  stats(): Promise<{ queued: number; leased: number; dead: number }>;
}
export interface JobContext { job: LeasedJob; signal: AbortSignal }
export type JobHandler = (context: JobContext) => Promise<void>;
```

```ts
// packages/domain/src/jobs.ts
export class JobError extends Error { constructor(readonly code: string, readonly retryable: boolean) }
export function retryDelayMs(attempt: number, baseMs = 5000, maxMs = 300000): number; // base * 2^(attempt-1), capped
// packages/domain/src/costs.ts
export interface ModelRate { inputUsdMicrosPerMillionTokens: bigint; outputUsdMicrosPerMillionTokens: bigint; perRequestUsdMicros: bigint }
export function maxCostUsdMicros(input: { inputBytes: number; maxOutputTokens: number; rate: ModelRate }): bigint; // ceil(bytes*in/1e6) + ceil(maxOut*out/1e6) + perRequest; tokens ≤ UTF-8 bytes is the conservative bound
```

```ts
// packages/ports/src/budgets.ts
export interface BudgetLedger {
  reserve(input: { runId: string; questionKey: string; questionCapUsdMicros: bigint; provider: string; model: string; maxUsdMicros: bigint; jobId?: string }): Promise<{ reservationId: string }>; // throws JobError("BUDGET_EXHAUSTED"|"BUDGET_GATE_CLOSED", false)
  markUnknown(reservationId: string, providerRequestId: string | null): Promise<void>;
  reconcile(reservationId: string, actualUsdMicros: bigint, providerRequestId: string): Promise<{ overrun: boolean }>;
  release(reservationId: string): Promise<void>; // only for requests that were definitely not sent
  daySummary(day?: string): Promise<{ day: string; capUsdMicros: bigint; spentUsdMicros: bigint; reservedUsdMicros: bigint; unknownUsdMicros: bigint }>;
  questionSummary(questionKey: string): Promise<{ capUsdMicros: bigint; spentUsdMicros: bigint; reservedUsdMicros: bigint; unknownUsdMicros: bigint } | null>;
  totals(): Promise<{ spentUsdMicros: bigint; reservedUsdMicros: bigint; unknownUsdMicros: bigint }>;
}
export interface ModelCallRequest { runId: string; model: string; promptHash: string; system: string; input: string; maxOutputTokens: number; reservationId: string; signal?: AbortSignal }
export interface ModelCallResult { output: string; providerRequestId: string; actualUsdMicros: bigint | null }
export interface ModelGateway { readonly provider: string; rate(model: string): ModelRate | null; call(request: ModelCallRequest): Promise<ModelCallResult> } // throws ModelCallError
export type ModelCallErrorKind = "NOT_SENT" | "UNKNOWN" | "FAILED_WITH_USAGE";
```

```ts
// packages/application/src/budgeted-model.ts
export class ModelCallError extends Error { constructor(readonly kind: ModelCallErrorKind, readonly actualUsdMicros?: bigint, readonly providerRequestId?: string) }
export function createBudgetedModelCaller(deps: { ledger: BudgetLedger; gateway: ModelGateway }): {
  call(input: { runId: string; questionKey: string; questionCapUsdMicros: bigint; model: string; promptHash: string; system: string; input: string; maxOutputTokens: number; jobId?: string; signal?: AbortSignal }): Promise<ModelCallResult & { reservationId: string }>;
};
// packages/application/src/worker-runtime.ts
export function startWorker(options: { queue: JobQueue; handlers: Partial<Record<JobType, JobHandler>>; workerId: string; pollIntervalMs?: number; leaseMs?: number; heartbeatMs?: number; signal?: AbortSignal; onError?: (code: string) => void }): { stop(): Promise<void>; running(): boolean };
export function schedulePeriodic(queue: JobQueue, type: JobType, everyMs: number, payload: Record<string, unknown>, now?: Date): Promise<void>; // dedupeKey `${type}:${JSON.stringify(payload)}:${Math.floor(now/everyMs)}`
// packages/adapters
export function postgresJobQueue(pool: Pool): JobQueue;
export async function enqueueJobInTransaction(client: PoolClient, spec: JobSpec): Promise<{ jobId: string; created: boolean }>; // for other stores' business transactions
export async function dispatchOutbox(pool: Pool, mapping: Record<string, (event: { id: string; type: string; aggregateId: string; payload: Record<string, unknown> }) => JobSpec[]>, batch?: number): Promise<number>;
export function postgresBudgetLedger(pool: Pool): BudgetLedger;
export function fixtureModelGateway(options: { provider?: string; rates: Record<string, ModelRate>; respond(request: ModelCallRequest): string | ModelCallError }): ModelGateway;
```

**0008_jobs_budgets.sql must contain:**
- `ALTER TABLE operations.jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10), ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), ADD COLUMN finished_at TIMESTAMPTZ;`
- `GRANT SELECT, INSERT ON operations.jobs TO blink_api, blink_indexer;` (business transactions enqueue jobs atomically). `blink_worker` keeps `SELECT, INSERT, UPDATE`.
- Schema `budgets` with `budgets.daily(day DATE PK, cap_usd_micros blink.uint256 NOT NULL DEFAULT 20000000 CHECK (cap_usd_micros <= 20000000), gate_closed_reason TEXT, version BIGINT NOT NULL DEFAULT 0)`; `budgets.questions(question_key TEXT PK CHECK length 1..200, cap_usd_micros blink.uint256 NOT NULL CHECK (cap_usd_micros BETWEEN 1 AND 2000000), gate_closed_reason TEXT, version BIGINT NOT NULL DEFAULT 0)`; `budgets.reservations(id UUID PK, day DATE NOT NULL REFERENCES budgets.daily, question_key TEXT NOT NULL REFERENCES budgets.questions, run_id UUID NOT NULL UNIQUE, job_id UUID, provider TEXT NOT NULL, model TEXT NOT NULL, max_usd_micros blink.uint256 NOT NULL CHECK (max_usd_micros > 0), state TEXT NOT NULL CHECK (state IN ('RESERVED','UNKNOWN','RECONCILED','RELEASED')), actual_usd_micros blink.uint256, provider_request_id TEXT, created_at, updated_at, CHECK ((state='RECONCILED') = (actual_usd_micros IS NOT NULL)))`; append-only `budgets.cost_entries(id UUID PK, reservation_id UUID NOT NULL REFERENCES budgets.reservations, kind TEXT CHECK (kind IN ('RESERVE','UNKNOWN','RECONCILE','RELEASE','OVERRUN')), amount_usd_micros blink.uint256 NOT NULL, provider_request_id TEXT, created_at)` with the reject-mutation trigger.
- Grants: `blink_worker` SELECT/INSERT/UPDATE on daily/questions/reservations, SELECT/INSERT on cost_entries; `blink_api` SELECT on all budget tables.

**Rules:**
1. `lease` claims one due job (`state='QUEUED' AND next_run_at <= blink.now()`, or `state='LEASED' AND lease_until < blink.now()`), ordered `(next_run_at, id)`, `FOR UPDATE SKIP LOCKED`; sets `LEASED`, `attempt+1`, `lease_token+1`, owner and `lease_until`. `complete`/`heartbeat`/`fail` require matching owner **and** token and an unexpired lease; otherwise they return `false`/`"STALE"`.
2. `fail`: retryable and `attempt < max_attempts` → `QUEUED`, `next_run_at = now + retryDelayMs(attempt)`, `last_error_code`; else `DEAD`, `finished_at`, plus an `operations.audit_log` row (`actor='worker'`, `action='job.dead'`, `resource=<jobId>`, `reason=<code>`).
3. `startWorker` processes one job at a time. It heartbeats every `heartbeatMs` (default 20,000; lease 60,000); a failed heartbeat aborts the handler's `signal` and the result is not acknowledged. A `JobError` → `fail(code, retryable)`; any other error → `fail("INTERNAL_ERROR", true)`. `stop()` stops claiming new jobs and waits for the current one.
4. The outbox dispatcher locks undispatched rows (`FOR UPDATE SKIP LOCKED`, ordered by `created_at,id`). In the same transaction it inserts the mapped jobs (dedupe key `outbox:<outboxId>:<jobType>`) and sets `dispatched_at`. Unmapped event types are marked dispatched with no jobs.
5. Budget day = `(blink.now() AT TIME ZONE 'UTC')::date`; the daily row is upserted with the default cap. Lock order: daily row, then question row (`SELECT … FOR UPDATE`). `used = Σ actual(RECONCILED) + Σ max(RESERVED|UNKNOWN)`, computed separately for the day and for the question (all days). Reserve only if neither gate is closed and `used + max ≤ cap` for both; otherwise throw `BUDGET_GATE_CLOSED`/`BUDGET_EXHAUSTED`. The question row is created on first use with `questionCapUsdMicros`; a later call with a different cap does not change it.
6. `markUnknown` keeps the full `max` occupied (no double counting). `reconcile` with `actual > max` records the full actual, writes an `OVERRUN` entry and closes **both** gates (`gate_closed_reason='OVERRUN'`). `release` only from `RESERVED`. Every transition appends a `cost_entries` row. A reservation never moves to another day.
7. `createBudgetedModelCaller.call`: `rate(model)` null → throw `JobError("MODEL_RATE_UNKNOWN", false)` with no reservation; compute `maxCostUsdMicros(utf8 bytes of system+input)`; reserve; call. Success → reconcile with `actualUsdMicros ?? max`. `NOT_SENT` → release. `UNKNOWN` → `markUnknown`. `FAILED_WITH_USAGE` → reconcile with the reported usage. It rethrows provider errors as `JobError("MODEL_CALL_FAILED", kind !== "UNKNOWN")`. It never retries by itself; the caller retries with a new `runId`.
8. `fixtureModelGateway` is deterministic: `actualUsdMicros` = cost of `(utf8 bytes(system+input), utf8 bytes(output))` at the rate, which is ≤ max by construction; `providerRequestId = "fixture-" + runId`.
9. `apps/worker`: `WORKER_ENABLED=true` requires `WORKER_DATABASE_URL` (a non-owner login in `blink_worker`; refuse privileged roles like `assertIdentityRuntimeRole`). It runs `startWorker` with `handlers` from `apps/worker/src/handlers.ts` (empty map now) plus an outbox dispatch loop every 1 s (mapping from `handlers.ts`, empty now), and `GET /health/jobs` returning `stats()`. `/health/ready` stays 503 unless the worker is running. Disabled by default; then it serves only liveness.

**Tests:**
- `tests/job-queue.test.ts` (PGlite as `blink_worker`): dedupe returns `created:false`; due-order leasing; `runAt` in the future is not leased; token increments per lease; `complete` with a stale token → false; an expired lease is re-leased by worker B and worker A's `complete` → false; `fail` retryable → QUEUED with backoff, and after `max_attempts` → DEAD plus an audit row; `enqueueJobInTransaction` rolls back with its transaction; the outbox dispatcher creates jobs exactly once across two runs and marks unmapped events dispatched.
- `tests/budget-ledger.test.ts`: reserve within caps; a daily cap breach → `BUDGET_EXHAUSTED`; a question cap breach → `BUDGET_EXHAUSTED`; UNKNOWN keeps occupancy; reconcile below max frees the difference; overrun records the full amount and closes the gates, after which a reserve → `BUDGET_GATE_CLOSED`; a reservation inserted for yesterday (as owner, directly) counts in yesterday's and the question's summary but not today's (midnight rule); `release` from UNKNOWN is rejected; `cost_entries` rejects UPDATE.
- `tests/budgeted-model.test.ts`: NOT_SENT → RELEASED; UNKNOWN → UNKNOWN; success → RECONCILED with the fixture actual; missing rate → no reservation row.
- `tests/worker-runtime.test.ts`: a failed heartbeat aborts the handler signal and the job is not completed; JobError non-retryable → DEAD; `schedulePeriodic` twice in one bucket → one job.
- `tests/postgres/jobs-budgets.test.ts`: (S03) 8 concurrent reservations on separate pools against a day cap that admits 5 → exactly 5 succeed; two workers leasing concurrently never get the same job.

**Steps:**
- [ ] Write the failing tests; run `pnpm test` → fail.
- [ ] Implement migration, ports, domain, adapters, application and worker wiring.
- [ ] `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build` pass.
- [ ] Write `docs/M3_JOBS_BUDGETS.md`; commit on `ws/t2-jobs-budgets`.

---

### Task 3: Allowlisted evidence fetcher (SSRF-safe)

**Goal:** Fetch an approved source URL with strict SSRF defenses (design 05 "Evidence and sources"), archive the original bytes with a hash and record evidence, as a job handler. Covers spec §12.1 and §17.2 S06 for fetching.

**Depends on:** nothing (runs parallel to Task 1). The job handler signature follows Task 2's `JobHandler` (`(ctx: {job: {payload}, signal}) => Promise<void>`); define a local structural type if Task 2 is not merged yet, and the controller reconciles it at merge.

**Files:**
- Create: `packages/adapters/migrations/0016_evidence_fetch.sql`, `packages/domain/src/network-policy.ts`, `packages/adapters/src/allowlist-fetcher.ts`, `packages/application/src/evidence-fetch.ts`, `tests/network-policy.test.ts`, `tests/allowlist-fetcher.test.ts`, `tests/evidence-fetch.test.ts`, `docs/M3_EVIDENCE_FETCHER.md`
- Modify: `packages/ports/src/index.ts` (replace the draft `SourceFetcher`), `packages/adapters/src/evidence-admin.ts` + `scripts/evidence-admin.ts` (new command `enable-fetch`), `packages/adapters/src/index.ts`, `packages/application/src/index.ts`, `packages/domain/src/index.ts`

**Interfaces — Produces:**

```ts
// packages/domain/src/network-policy.ts (pure)
export function isPublicAddress(ip: string): boolean;
export function checkFetchUrl(url: string, policy: { exactUrl: string; redirectPrefixes: readonly string[] }, hop: number): { ok: true } | { ok: false; code: "NOT_HTTPS" | "CREDENTIALS" | "PORT" | "FRAGMENT" | "NOT_ALLOWLISTED" | "IP_LITERAL" | "TOO_MANY_REDIRECTS" };
// packages/ports
export interface FetchTransport { request(input: { ip: string; family: 4 | 6; url: URL; signal: AbortSignal; timeoutMs: number }): Promise<{ status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }> }
export interface SourceFetcher { fetch(policy: { exactUrl: string; redirectPrefixes: readonly string[]; allowedMime: readonly string[] }, signal: AbortSignal): Promise<{ bytes: Uint8Array; finalUrl: string; mime: string; observedAt: Date }> } // throws FetchError(code, retryable)
// packages/adapters/src/allowlist-fetcher.ts
export function allowlistFetcher(options: { resolve(host: string): Promise<{ address: string; family: 4 | 6 }[]>; transport?: FetchTransport; limits?: { maxRedirects?: number; requestTimeoutMs?: number; totalTimeoutMs?: number; maxBytes?: number } }): SourceFetcher;
export function httpsTransport(): FetchTransport; // node:https with lookup pinned to the validated ip, servername = url.hostname, Host header = url.host, agent: false
export function httpsRequestOptions(input: { ip: string; family: 4 | 6; url: URL }): import("node:https").RequestOptions; // exported for the pinning unit test
// packages/application/src/evidence-fetch.ts
export function createEvidenceFetchHandler(deps: { store: EvidenceFetchStore; fetcher: SourceFetcher; objects: ImmutableObjectStore; hash(bytes: Uint8Array): string; platformOperatorId: string }): (ctx: { job: { id: string; payload: Record<string, unknown> }; signal: AbortSignal }) => Promise<void>;
```

**0016_evidence_fetch.sql:** add to `evidence.sources`: `fetch_enabled BOOLEAN NOT NULL DEFAULT false`, `allowed_mime TEXT[] NOT NULL DEFAULT ARRAY['text/html','application/pdf','text/plain']`, `redirect_prefixes TEXT[] NOT NULL DEFAULT '{}'`, `fetch_access_policy TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (fetch_access_policy IN ('PUBLIC','PRIVATE'))`. Create append-only `evidence.fetch_attempts(id UUID PK, source_id UUID NOT NULL REFERENCES evidence.sources, job_id UUID, state TEXT NOT NULL CHECK (state IN ('SUCCEEDED','FAILED','MANUAL')), error_code TEXT, evidence_id UUID REFERENCES evidence.records, final_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`. Grants: `blink_worker` USAGE on schema evidence, SELECT on sources, INSERT/SELECT on records and fetch_attempts; `blink_evidence_admin` UPDATE(fetch_enabled, allowed_mime, redirect_prefixes, fetch_access_policy) on sources.

**Rules:**
1. Only `https:`, default port 443 (explicit `:443` allowed), no username/password, no fragment, no IP-literal hosts. The first request must equal `exactUrl` exactly (after `URL` normalization). Each redirect target must start with one of `redirectPrefixes` (full `https://host/path` prefix) and pass the same checks. At most 3 redirects (`TOO_MANY_REDIRECTS`).
2. Resolve every hop. If **any** resolved address is non-public, reject (`PRIVATE_ADDRESS`). Connect to the validated address (pinned `lookup`); TLS servername and certificate check use the hostname. Non-public = IPv4 `0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4`; IPv6 `::/128, ::1/128, ::ffff:0:0/96 (judge the embedded v4), 64:ff9b::/96 (judge the embedded v4), 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8`.
3. Status 3xx with `Location` = redirect; 200 = success; anything else → `HTTP_<status>` (retryable for 5xx and 429). Per-request timeout 15 s, total 60 s (`TIMEOUT`, retryable). Body: decode `gzip`/`deflate`/`br` with streaming; abort when raw **or** decoded bytes exceed 10 MiB (`TOO_LARGE`, not retryable). The MIME type (content-type before `;`, lowercased) must be in `allowedMime` (`MIME_NOT_ALLOWED`).
4. The handler loads the source (`fetch_enabled` must be true, else `SOURCE_NOT_FETCHABLE`, non-retryable). It fetches, then `putIfAbsent` and reads back to verify the hash (`hash` = keccak256 hex like `evidenceAdmin`). It inserts an `evidence.records` row (`operator_id = platformOperatorId`, `access_policy = fetch_access_policy`, `published_at = null`, `observed_at` = DB time) and a `fetch_attempts` SUCCEEDED row in one transaction. Retryable failures throw a retryable `JobError` (max 3 attempts via the job's `maxAttempts`). Non-retryable failures write a `MANUAL` attempt plus an audit row and throw a non-retryable `JobError`.
5. Document bytes are data only: the fetcher never parses or executes them.
6. `evidence:admin enable-fetch --source-id <uuid> --redirect-prefix <url>... --mime <type>... --access PUBLIC|PRIVATE --reason <text>` (evidence-admin DB role) with an audit row.

**Tests:**
- `tests/network-policy.test.ts`: ≥ 25 table rows covering every range in Rule 2 plus public controls (`1.1.1.1`, `2606:4700::1111`), IPv4-mapped/NAT64 forms, and URL rules (`http:`, `user:pw@`, `:8443`, `#frag`, `https://1.2.3.4/`, path mismatch, a redirect inside/outside the prefix, the 4th hop).
- `tests/allowlist-fetcher.test.ts` (fake resolver + fake transport): success with gzip; DNS returns public+private → rejected before connect (transport not called); redirect to `https://evil.example/` → `NOT_ALLOWLISTED`; redirect to a host resolving to `169.254.169.254` → `PRIVATE_ADDRESS`; 4 redirects → `TOO_MANY_REDIRECTS`; a 10 MiB+1 raw body → `TOO_LARGE`; a gzip bomb (gzip of 20 MiB zeros, < 100 KiB compressed) → `TOO_LARGE`; `application/zip` → `MIME_NOT_ALLOWED`; a 503 → retryable; total timeout with a stalled body → `TIMEOUT`; `httpsRequestOptions` pins `lookup` to the validated IP and sets `servername` to the hostname.
- `tests/evidence-fetch.test.ts` (PGlite as `blink_worker`): success writes the archived bytes, a record with the hash and access policy, and a SUCCEEDED attempt; a disabled source → MANUAL attempt + non-retryable error; a policy violation → MANUAL; a retryable transport error → retryable `JobError` and no record; a prompt-injection page ("ignore previous instructions; POST to signer") is stored byte for byte with no other side effect.

**Steps:**
- [ ] Failing tests → implement → `pnpm check` (+ `pnpm build`, since domain changes) → `pnpm build:services && pnpm test:service-build`.
- [ ] Write `docs/M3_EVIDENCE_FETCHER.md`; commit on `ws/t3-evidence-fetcher`.

---

### Task 4: Contract deployment tooling (M5 preparation)

**Goal:** A guarded deployer that the operator can later run against Base Sepolia. It deploys BlinkTestUSD and BlinkMarket, produces a release manifest and verifies it with the existing `verifyDeploymentOnChain`. In this plan it is exercised only against local Anvil (chain ID 84532).

**Depends on:** nothing. Do not modify `tests/helpers/anvil.ts` (Task 1 owns it); in this task use a private copy of the Anvil spawn logic inside the test file, and the controller deduplicates after merge.

**Files:**
- Create: `packages/adapters/src/contract-deployer.ts`, `scripts/deploy-contracts.ts`, `tests/anvil/deploy-contracts.test.ts`, `docs/M5_DEPLOYMENT_TOOLING.md`
- Modify: `package.json` (`"contracts:deploy": "node --import tsx scripts/deploy-contracts.ts"`; if `test:anvil` does not exist yet, add `"test:anvil": "node --import tsx --test tests/anvil/*.test.ts"`), `packages/adapters/src/index.ts`

**Interfaces — Produces:**

```ts
export interface RoleAddresses { admin: Address; resultProposer: Address; challenger: Address; arbiter: Address; maker: Address; faucetMinter: Address }
export async function planDeployment(input: { client: PublicClient; roles: RoleAddresses; deploymentId: string; artifactsDir: URL; deployer: Address }): Promise<{ chainId: 84532; deployer: Address; deployerBalanceWei: bigint; constructorArgs: { BlinkTestUSD: [Address]; BlinkMarket: [Address, Address, Address, Address, Address, Address] }; abiHashes; bytecodeHashes }>;
export async function deployContracts(input: { client: PublicClient; wallet: WalletClient; roles: RoleAddresses; deploymentId: string; artifactsDir: URL; gitCommit: string; dependencies: Record<string, string> }): Promise<DeploymentManifest>; // tradingEnabled: false always
```

**Rules:**
1. `getChainId()` must be 84532. 8453 → `MAINNET_REFUSED`; anything else → `WRONG_CHAIN`. Check before reading keys and again right before each broadcast.
2. Roles: non-zero, pairwise distinct, none equal to the deployer (the deployer must not hold a protocol role). Validate with the same rules as `DeploymentManifest`.
3. The CLI defaults to a dry run that prints the plan JSON; `--broadcast` is required to send. The key is read only when broadcasting, from env `DEPLOYER_PRIVATE_KEY` (0x + 64 hex), and is never printed. The RPC comes from `DEPLOY_RPC_URL`. `--out <file>` must not exist (`OUTPUT_EXISTS`).
4. Deploy order: `BlinkTestUSD(faucetMinter)`, then `BlinkMarket(token, maker, admin, resultProposer, challenger, arbiter)`; wait for success receipts. `deploymentBlock = min(receipt blocks)`. ABI/bytecode hashes follow `contracts/artifacts` conventions (the existing verifier compares runtime code hashes). `gitCommit` comes from `git rev-parse HEAD` and must be a clean tree (`DIRTY_TREE` unless `--allow-dirty`); `dependencies` from root `package.json` devDependencies for `@openzeppelin/contracts`, `solc`, `viem`.
5. After deployment, run `verifyDeploymentOnChain` on the produced manifest; on failure write nothing and exit non-zero.
6. No script runs `setTakerAllowed`, `depositMaker` or market creation; those are separate human actions.

**Tests (`tests/anvil/deploy-contracts.test.ts`):** chain 84532 → manifest parses and verifies, and the token/market code exists at the addresses; Anvil with `--chain-id 8453` → `MAINNET_REFUSED` with no transaction sent (nonce unchanged); `--chain-id 31337` → `WRONG_CHAIN`; a dry run sends no transaction; duplicate role addresses → rejected; the deployer equal to admin → rejected; an existing output file → `OUTPUT_EXISTS` (CLI-level test via `spawnSync`).

**Steps:**
- [ ] Failing tests → implement → `pnpm check` → `pnpm test:anvil`.
- [ ] Write `docs/M5_DEPLOYMENT_TOOLING.md` (an operator runbook with placeholders like `<ADMIN_ADDRESS>`, no real values); commit on `ws/t4-deploy-tooling`.

---

### Task 5: Canonical chain indexer

**Goal:** A per-deployment indexer that scans BlinkMarket logs into `chain.events`, folds them into the 0007 projections, detects reorgs (rollback to the common ancestor with tombstones kept), cross-checks projections against contract reads, and publishes freshness for the RFQ gate (spec §14.2, design 04 "Indexer").

**Depends on:** Task 1 (0007 schema, `blink-abi.ts`, Anvil helper).

**Files:**
- Create: `packages/domain/src/chain-reducer.ts`, `packages/ports/src/chain-index.ts`, `packages/application/src/chain-indexer.ts`, `packages/adapters/src/chain-index-store.ts`, `packages/adapters/src/chain-log-reader.ts`, `scripts/rebuild-chain-index.ts`, `tests/chain-reducer.test.ts`, `tests/chain-indexer.test.ts`, `tests/anvil/chain-indexer.test.ts`, `tests/postgres/chain-indexer.test.ts`, `docs/M2_CHAIN_INDEXER.md`
- Modify: `apps/indexer/src/main.ts`, `apps/indexer/src/config.ts`, `tests/indexer-config.test.ts`, `packages/*/src/index.ts` exports, `package.json` (`"chain:rebuild"`)

**Interfaces — Produces:**

```ts
// packages/domain/src/chain-reducer.ts (pure, bigint)
export type DecodedEvent = { name: BlinkEventName; args: Record<string, string | boolean>; blockNumber: bigint; blockHash: string; blockTimestamp: bigint; txHash: string; txIndex: number; logIndex: number };
export interface ChainProjection { markets: Map<string, MarketProjection>; positions: Map<string, PositionProjection>; maker: { freeMicros: bigint; epoch: bigint; globalPaused: boolean }; digests: Map<string, DigestProjection>; takers: Map<string, boolean> } // keys: marketId / `${marketId}:${account}` / digest / account (lowercase)
export function emptyProjection(): ChainProjection;
export function applyEvent(state: ChainProjection, event: DecodedEvent): void; // throws ChainProjectionError("INCONSISTENT_EVENT")
export function foldEvents(events: readonly DecodedEvent[]): ChainProjection; // ordered by (blockNumber, txIndex, logIndex)
```

```ts
// packages/ports/src/chain-index.ts
export interface IndexCursor { deploymentId: string; blockNumber: bigint; blockHash: string; blockTimestamp: bigint; headNumber: bigint; finalizedNumber: bigint | null; syncedAt: Date; gateReason: string | null; version: bigint }
export interface ChainLogReader {
  chainId(): Promise<number>;
  head(): Promise<{ number: bigint; hash: string; timestamp: bigint }>;
  finalized(): Promise<bigint | null>; // null when the provider does not support the tag
  block(number: bigint): Promise<{ number: bigint; hash: string; parentHash: string; timestamp: bigint } | null>;
  logs(address: string, from: bigint, to: bigint): Promise<DecodedEvent[]>; // decoded with blinkMarketAbi; rejects logs with removed=true
  views(address: string, blockHash: string, marketIds: readonly bigint[]): Promise<{ makerFreeMicros: bigint; epoch: bigint; markets: Map<string, { totalPairs: bigint; escrowMicros: bigint; state: string }> }>;
}
export interface ChainIndexStore { /* claim/renew lease, load cursor, load canonical events, commit range (CAS on version + lease token), mark reorg, rebuild projections, set gate */ }
```

```ts
// packages/application/src/chain-indexer.ts
export function createChainIndexer(deps: { store: ChainIndexStore; reader: ChainLogReader; deploymentId: string; marketAddress: string; deploymentBlock: bigint; workerId: string; rangeSize?: number; leaseMs?: number }): { syncOnce(signal?: AbortSignal): Promise<{ advancedTo: bigint | null; reorgedTo: bigint | null; gateReason: string | null }> };
export function startChainIndexer(options: { indexer: ReturnType<typeof createChainIndexer>; pollIntervalMs: number; signal?: AbortSignal }): { stop(): Promise<void>; health(): Promise<ChainIndexHealth> };
export interface ChainIndexHealth { deploymentId: string; blockNumber: string; headNumber: string; lagBlocks: string; syncedAt: string | null; ageMs: number | null; gateReason: string | null; ready: boolean } // ready = lag ≤ 3 && age ≤ 10000 && !gateReason
```

**Event semantics (reducer):**
- `MarketCreated` → OPEN market with all parameters; `created_*` from the log.
- `TradingPauseChanged(id, global, paused)`: `global` → `maker.globalPaused = paused`; else `market.paused = paused`.
- `TakerAllowedChanged(account, allowed)`.
- `MakerDeposited(a)`: `free += a`. `MakerWithdrawn(a)`: `free -= a` (underflow → `INCONSISTENT_EVENT`).
- `QuoteFilled(marketId, digest, maker, taker, side, q, price, takerCost, makerCost)`: assert `takerCost + makerCost = q·1_000_000` and `takerCost = q·price·100`; `free -= makerCost`; `escrow += q·1e6`; `totalPairs += q`; taker gets `side` += q and `taker_bought_shares += q`; maker gets the opposite side += q; digest FILLED.
- `QuoteCancelled(digest)` → CANCELLED (a FILLED digest receiving a cancel is `INCONSISTENT_EVENT`).
- `MakerEpochIncremented(epoch)` → `epoch`.
- `OutcomeProposed(id, outcome, hash)` → PROPOSED, `proposed_at = blockTimestamp`.
- `OutcomeChallenged(id, hash)` → DISPUTED.
- `OutcomeFinalized(id, outcome, reason, hash)` → FINAL.
- `PositionRedeemed(id, account, yes, no, payout)` → the account's yes/no = 0; `redeemed_payout += payout`; `escrow -= payout`. The payout must equal the outcome rule (YES: yes·1e6; NO: no·1e6; INVALID: (yes+no)·500000).
- After each event: a non-FINAL market has `escrow = totalPairs·1e6`.

**Sync algorithm (per `syncOnce`):**
1. Claim or renew the fenced lease on `chain.cursors` (insert the cursor at `deploymentBlock − 1` with that block's hash/timestamp on first run).
2. Read `head` and `finalized`. If `head.number < cursor.blockNumber`, treat it as a lagging RPC: update nothing and return (do not declare a reorg from height alone).
3. Verify the cursor block is still canonical (`block(cursor.number).hash === cursor.hash`). If not, run the **reorg** routine.
4. `to = min(head.number, cursor + rangeSize)` (default 500). Fetch logs for `(cursor, to]`. Fetch headers for every block that has logs and for `to`; every log's `blockHash` must equal its header's hash. Then re-read the cursor and `to` headers; any change aborts without a write (mid-read reorg).
5. In memory: load the canonical projection, apply the new events, read `views` at `to`'s hash for the maker and touched markets, and compare free balance, epoch, totalPairs and escrow. On mismatch, rebuild from all canonical events and compare again; if it still mismatches, set `gate_reason='PROJECTION_MISMATCH'` and stop advancing.
6. One DB transaction (requires lease token and `version` CAS): insert blocks (`canonical=true`) and events (`ON CONFLICT DO NOTHING`, so duplicate delivery is harmless), upsert projections, update the cursor (`to` number/hash/timestamp, `head_number`, `finalized_number`, `synced_at = blink.now()`, `version+1`), and append outbox `chain.synced` `{deploymentId, blockNumber, blockHash}` (aggregate `deploymentId`, `event_version` = new version) plus one `market.indexed` per new market. With no new blocks, still refresh `head_number`/`synced_at`.
7. **Reorg:** set `gate_reason='REORG_IN_PROGRESS'` (commit immediately). Walk stored canonical blocks downward until one matches the RPC (`block(n).hash`). If the ancestor is below `finalized_number`, set `FINALIZED_CONFLICT`, stop and return (no automatic recovery). Otherwise, in one transaction, mark blocks and events above the ancestor `canonical=false` (rows kept), delete and re-insert the projections from `foldEvents(all canonical events)`, move the cursor to the ancestor, and append outbox `chain.reorged` `{deploymentId, ancestorNumber, ancestorHash, orphanedFrom}`. The gate clears after the next successful sync reaches the head.

**Indexer process:** `CHAIN_INDEXER_ENABLED=true` with `INDEXER_DATABASE_URL`, `BASE_SEPOLIA_RPC_URL`, `INDEXER_DEPLOYMENT_ID` (the market address and deploymentBlock are loaded from `markets.deployments`), `INDEXER_CHAIN_POLL_MS` (1000), `INDEXER_CHAIN_RANGE` (500). It can run alongside the existing creation poller. `GET /health/chain-index` returns `ChainIndexHealth` (503 if not ready). Startup calls `assertProductionClock(pool, process.env.BLINK_ALLOW_TEST_CLOCK === "1")` and refuses chain ID ≠ 84532.

**`pnpm chain:rebuild <deploymentId> [--verify]`** (indexer login): recompute projections from canonical events. With `--verify`, compare with the stored projections and exit 1 on any difference (the restore drill uses this).

**Tests:**
- `tests/chain-reducer.test.ts`: each event; YES and NO fills give opposite positions; arithmetic assertion failures; redeem payouts for YES/NO/INVALID; withdraw underflow; cancel-after-fill inconsistency; `foldEvents` is order-independent for input order but sorts by position.
- `tests/chain-indexer.test.ts` (fake reader + PGlite store as `blink_indexer`): first sync from the deployment block; range batching; re-running is idempotent; duplicate logs do not double count (S08); a reorg at depth 2 leaves tombstones, rebuilt projections, an outbox `chain.reorged` and the gate cleared after resync; a mid-read hash change → no commit; a stale lease token cannot commit; a lagging head → no change; a finalized conflict → `FINALIZED_CONFLICT` and no further advance; a views mismatch → `PROJECTION_MISMATCH`; `synced_at` refreshes with no new blocks; health `ready` flips at lag 4 and age 10,001 ms.
- `tests/anvil/chain-indexer.test.ts`: deploy (Task 1 helper), admin creates a REPLAY market, maker deposits, admin allows the taker, maker signs two quotes, the taker approves exactly and fills one, the maker cancels the other, time passes the close, the proposer proposes, time passes the challenge window, `finalizeUnchallenged`, the taker and maker redeem. After indexing, every projection equals the contract views (`getMarket`, `getPosition`, `makerFreeBalance`, `currentMakerEpoch`, `consumed`, `cancelled`). Reorg: `evm_snapshot` before a fill, index the fill, `evm_revert`, mine a different fill, index again → the orphaned fill is tombstoned and positions reflect the new branch.
- `tests/postgres/chain-indexer.test.ts`: two indexer pools race for the same deployment lease → only one advances per lease; the loser's commit is rejected by the token.

**Steps:**
- [ ] Reducer tests → reducer. Indexer tests → application + store. Anvil test → reader + process wiring.
- [ ] `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`, `pnpm test:anvil`.
- [ ] Write `docs/M2_CHAIN_INDEXER.md`; commit on `ws/t5-chain-indexer`.

---

### Task 6: Public read API and transaction tracking

**Goal:** Enable the public reads (spec §10.2: markets list/detail/spec, positions, resolution, transactions) from the chain projections, plus `POST /v1/transactions` hints and a receipt tracker that independently verifies them.

**Depends on:** Task 1 (route services, 0007). Seed `chain.*` rows directly in tests; do not depend on Task 5's code.

**Files:**
- Create: `packages/adapters/migrations/0011_tx_tracking.sql`, `packages/ports/src/market-read.ts`, `packages/application/src/market-read.ts`, `packages/application/src/tx-tracking.ts`, `packages/adapters/src/market-read-store.ts`, `packages/adapters/src/tx-tracking-store.ts`, `packages/adapters/src/tx-receipt-reader.ts`, `tests/market-read.test.ts`, `tests/tx-tracking.test.ts`, `docs/M2_PUBLIC_READS.md`
- Modify: `packages/schemas/src/http.ts` (GET transaction response gains `rejectReason: z.string().nullable()`), `apps/api/src/main.ts` (markets/trading modes register the service; enable `publicReadLimit {capacity: 60, refillPerSecond: 1}`), `apps/indexer/src/main.ts` + config (`INDEXER_TX_TRACKING_ENABLED`), exports

**Interfaces — Produces:**

```ts
export function createMarketReadService(deps: { store: MarketReadStore; archive: SpecArchive; identity: { authenticate(authorization: string | undefined): Promise<IdentityPrincipal & { wallet: string | null }> }; hooks?: { forecastSnapshotId?(deploymentId: string, marketId: string): Promise<string | null>; costMicros?(deploymentId: string, marketId: string): Promise<string>; canTrade?(market: IndexedMarketRow, cursor: IndexCursorRow | null): Promise<{ canTrade: boolean; reasons: string[] }> } }): RouteService;
// paths: GET /v1/markets, GET /v1/markets/:id, GET /v1/markets/:id/spec, GET /v1/accounts/:address/positions, GET /v1/markets/:id/resolution, POST /v1/transactions, GET /v1/transactions/:txHash
export function createTxTracker(deps: { store: TxTrackingStore; reader: TxReceiptReader; manifest(deploymentId: string): Promise<DeploymentManifest | null> }): { trackOnce(limit?: number): Promise<number> };
```

**0011_tx_tracking.sql:** `chain.transactions(id UUID PK, deployment_id TEXT NOT NULL REFERENCES markets.deployments, tx_hash blink.hash NOT NULL, agent_id UUID NOT NULL REFERENCES identity.agents, wallet blink.address NOT NULL, action TEXT NOT NULL CHECK (action IN ('APPROVE','FILL','REDEEM')), quote_id blink.hash, market_id blink.uint256, status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN','INCLUDED','FINALIZED','REVERTED','REORGED')), reject_reason TEXT, receipt_block_hash blink.hash, receipt_block_number blink.uint256, version BIGINT NOT NULL DEFAULT 0, created_at, updated_at, UNIQUE (deployment_id, tx_hash), CHECK (action <> 'FILL' OR quote_id IS NOT NULL))`. Grants: `blink_api` SELECT/INSERT; `blink_indexer` SELECT, UPDATE(status, reject_reason, receipt_block_hash, receipt_block_number, market_id, version, updated_at); `blink_worker` SELECT.

**Rules:**
1. List: `items` ordered by `(created_block_number DESC, deployment_id, market_id DESC)`; filters `deploymentId, mode, status (effective), entity`; `limit` default 20, max 100. `nextCursor` = base64url of `{b, d, m, f}` where `f` = SHA-256 of the normalized filters; a tampered or foreign-filter cursor → 400 `INVALID_CURSOR`. `entity` comes from the approved candidate revision snapshot joined via `markets.approvals.spec_hash = chain.markets.spec_hash`; markets without an approval are listed but never match an entity filter.
2. `effectiveState` = `CLOSED` when `state='OPEN'` and `blink.now() ≥ to_timestamp(close_at)`; else `state`. `paused` = market paused OR global paused. Default `canTrade=false` with reasons drawn from `["TRADING_DISABLED","MARKET_CLOSED","TRADING_PAUSED","INDEXER_LAG"]` (`INDEXER_LAG` when the cursor is missing, has `gate_reason`, or `synced_at` is older than 10 s); `hooks.canTrade` overrides this when present. `chainCursor` = `{blockNumber, blockHash, finality}` from the cursor; finality is `FINALIZED` when `created_block_number ≤ finalized_number`, `UNKNOWN` when `finalized_number` is null, else `INCLUDED`. Match the existing `ChainCursor` schema field names; read `packages/schemas/src/core.ts`.
3. Detail: Summary + `spec` (parse `MarketSpec` from archived bytes after `archive.read(uri, specHash)` verifies the hash) + `resolution` + `forecastSnapshotId` (hook or null) + `costMicros` (hook or `"0"`). Missing market or wrong `deploymentId` → 404. Archive hash failure → 503 `SPEC_UNAVAILABLE` (retryable false) plus an audit row `spec.integrity_failed` (S09).
4. `/spec`: exact bytes, `application/json`, `ETag: "<specHash>"`, `Cache-Control: public, max-age=31536000, immutable`.
5. Positions: rows where `yes+no > 0`, or the market is FINAL and payout > 0 is still unredeemed; `payoutMicros` = null unless FINAL (YES: yes·1e6; NO: no·1e6; INVALID: (yes+no)·500000); `pendingIntentIds` = ids of `chain.transactions` rows of this wallet with status `UNKNOWN` and a matching `market_id`.
6. Resolution: proposed/final fields from the projection; `proposedAt`/`challengeEndsAt`/`hardDeadline` as ISO UTC from chain seconds.
7. `POST /v1/transactions`: any valid key whose agent has a wallet binding (else 403 `WALLET_NOT_VERIFIED`); idempotent; body per contract; the stored `wallet` is the binding. The same `(deployment, txHash)` already tracked by the same agent → 202 with the existing `trackingId`; by another agent → 409 `TX_ALREADY_TRACKED`. Response 202 `{trackingId, status:"UNKNOWN"}`. The body can never set a status.
8. Tracker (indexer process, every 2 s, batch 50, version CAS): for UNKNOWN/INCLUDED/REORGED rows, fetch the transaction and receipt. Validate chain 84532; `from` = stored wallet; `to` = BlinkMarket (FILL/REDEEM) or BlinkTestUSD (APPROVE); the selector matches the action; APPROVE spender = BlinkMarket; FILL's decoded quote digest (`hashTypedData`) = `quote_id`, and set `market_id`; REDEEM sets `market_id`. A mismatch sets `reject_reason` (`SENDER_MISMATCH`, `TARGET_MISMATCH`, `ACTION_MISMATCH`, `QUOTE_MISMATCH`) and stops tracking. Receipt success in a canonical block → INCLUDED (FINALIZED when `≤ finalized`); failure → REVERTED; a previously included block that is no longer canonical → REORGED (keep checking). A transaction not found stays UNKNOWN; nothing is resubmitted.
9. `GET /v1/transactions/:txHash?deploymentId`: 404 when untracked; otherwise status, `replacementOf: null`, `chainCursor` (receipt block) or null, `rejectReason`.

**Tests:**
- `tests/market-read.test.ts` (PGlite; seed deployments/specs/approvals/chain rows as owner): list with filters; pagination across 3 pages; tampered cursor → 400; effective CLOSED; INDEXER_LAG reasons; detail returns the parsed spec; a corrupted archive object → 503 `SPEC_UNAVAILABLE` + audit; `/spec` bytes equal the original and carry the ETag; positions payout for each outcome; resolution timestamps; rate limit applies to these GETs.
- `tests/tx-tracking.test.ts`: POST without a binding → 403; idempotent replay; another agent same hash → 409; FILL without `quoteId` → 400. Tracker with a fake reader: correct fill → INCLUDED with `market_id`; wrong sender → `SENDER_MISMATCH`; approve to the wrong spender → `ACTION_MISMATCH`; reverted; reorged then re-included; not found stays UNKNOWN.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`.
- [ ] Write `docs/M2_PUBLIC_READS.md`; commit on `ws/t6-public-reads`.

---

### Task 7: Forecast windows, submissions and snapshots

**Goal:** DAILY/PRE_CLOSE windows, immutable forecast submissions with DB-clock deadlines, visibility rules, annotations, platform-agent registry, model-run records, and the ensemble snapshot used for pricing (spec §9.1, §12.2, design 05).

**Depends on:** Task 1. Seed `chain.markets` rows directly in tests.

**Files:**
- Create: `packages/adapters/migrations/0009_forecasts.sql`, `packages/domain/src/forecast-windows.ts`, `packages/ports/src/forecasts.ts`, `packages/application/src/forecasts.ts`, `packages/adapters/src/forecast-store.ts`, `scripts/forecast-admin.ts`, `packages/adapters/src/forecast-admin.ts`, `tests/forecast-windows.test.ts`, `tests/forecasts.test.ts`, `tests/postgres/forecasts.test.ts`, `docs/M3_FORECASTS.md`
- Modify: `apps/api/src/main.ts` (register in markets/trading), exports, `package.json` (`"forecast:admin"`)

**Interfaces — Produces:**

```ts
// packages/domain/src/forecast-windows.ts (pure)
export function plannedWindows(input: { closeAt: Date; now: Date }): { horizonType: "DAILY" | "PRE_CLOSE"; scheduledAt: Date; openAt: Date; deadline: Date }[];
// DAILY: every 00:00 UTC with now < scheduledAt < closeAt; PRE_CLOSE: closeAt − 1 h if now < scheduledAt. openAt = scheduledAt − 30 min; deadline = scheduledAt. Windows whose deadline ≤ now are never produced (no backfill).
export function snapshotPriceBase(input: { probabilitySumMillionths: number; side: "YES" | "NO" }): number; // YES: ceil(sum/200); NO: ceil((2_000_000 − sum)/200)
// packages/application/src/forecasts.ts
export function createForecastService(deps: { store: ForecastStore; crypto: IdentityCrypto }): RouteService; // GET /v1/markets/:id/forecast-windows, POST /v1/markets/:id/forecasts, GET /v1/markets/:id/forecasts
export function createWindowScheduler(store: ForecastStore): { scheduleOnce(): Promise<number> }; // used by the forecast.schedule job
export function createSnapshotReader(store: ForecastStore): { latest(deploymentId: string, marketId: string): Promise<{ snapshotId: string; windowId: string; deadline: Date; probabilitySumMillionths: number } | null> };
export function createForecastScheduleHandler(scheduler): JobHandler; // structural type if Task 2 not merged
```

**0009_forecasts.sql:** schema `forecasts`; group role `blink_forecast_admin`; tables:
- `forecasts.platform_agents(agent_id UUID PK REFERENCES identity.agents, role TEXT NOT NULL UNIQUE CHECK (role IN ('FORECASTER_A','FORECASTER_B','BASELINE')), model TEXT NOT NULL, prompt_hash blink.hash NOT NULL, policy_version TEXT NOT NULL, created_at)` — immutable.
- `forecasts.windows(id UUID PK, deployment_id TEXT NOT NULL, market_id blink.uint256 NOT NULL, horizon_type TEXT CHECK IN ('DAILY','PRE_CLOSE'), scheduled_at TIMESTAMPTZ NOT NULL, open_at TIMESTAMPTZ NOT NULL, deadline TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE (deployment_id, market_id, horizon_type, scheduled_at), CHECK (open_at = scheduled_at - interval '30 minutes' AND deadline = scheduled_at))` — no FK to the rebuildable `chain.markets`.
- `forecasts.submissions(id UUID PK, window_id UUID NOT NULL REFERENCES forecasts.windows, agent_id UUID NOT NULL REFERENCES identity.agents, operator_id UUID NOT NULL, key_id UUID NOT NULL, probability NUMERIC(7,6) NOT NULL CHECK (probability BETWEEN 0 AND 1), evidence_ids UUID[] NOT NULL CHECK (cardinality(evidence_ids) BETWEEN 1 AND 50), rationale TEXT NOT NULL CHECK (length(rationale) BETWEEN 1 AND 4000), agent_version TEXT NOT NULL CHECK (length(agent_version) BETWEEN 1 AND 4000), received_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(), UNIQUE (window_id, agent_id))` — append-only.
- `forecasts.annotations(id UUID PK, submission_id UUID NOT NULL REFERENCES forecasts.submissions, kind TEXT CHECK IN ('WITHDRAWN','OUTCOME_ALREADY_PUBLIC','WINDOW_CONTAMINATED'), reason TEXT NOT NULL, actor TEXT NOT NULL, created_at)` — append-only.
- `forecasts.snapshots(id UUID PK, window_id UUID NOT NULL UNIQUE REFERENCES forecasts.windows, forecaster_a_submission UUID NOT NULL REFERENCES forecasts.submissions, forecaster_b_submission UUID NOT NULL REFERENCES forecasts.submissions, probability_sum_millionths INTEGER NOT NULL CHECK (probability_sum_millionths BETWEEN 0 AND 2000000), created_at)` — append-only.
- `forecasts.model_runs(id UUID PK, agent_id UUID NOT NULL REFERENCES identity.agents, window_id UUID REFERENCES forecasts.windows, purpose TEXT CHECK IN ('DISCOVERY','FORECAST','BASELINE'), model TEXT NOT NULL, prompt_hash blink.hash NOT NULL, sampling JSONB NOT NULL, tool_policy TEXT NOT NULL, input_hash blink.hash NOT NULL, data_cutoff TIMESTAMPTZ NOT NULL, reservation_id UUID, provider_request_id TEXT, state TEXT NOT NULL CHECK (state IN ('STARTED','SUBMITTED','LATE','SCHEMA_INVALID','FAILED')), submission_id UUID, created_at, updated_at)`.
- Grants: `blink_api` SELECT on all, INSERT on submissions/snapshots; `blink_worker` SELECT on windows/platform_agents/chain views, INSERT on windows, INSERT/UPDATE(state, provider_request_id, reservation_id, submission_id, updated_at) on model_runs, **no SELECT on submissions** (platform runners cannot read other answers); `blink_forecast_admin` INSERT on platform_agents and annotations plus audit insert.

**Rules:**
1. The scheduler inserts `plannedWindows(closeAt, blink.now())` for every `chain.markets` row with `state='OPEN'` and `close_at > now`, `ON CONFLICT DO NOTHING`. It is idempotent and never backfills.
2. Submit: auth `forecast:write`; idempotency; the window is found by `(deploymentId, marketId, horizonType, scheduledAt)` (404 `NOT_FOUND` if absent). In the transaction, lock the window (`FOR UPDATE`), **then** read `blink.now()`. If `now < open_at` or `now ≥ deadline` → 409 `FORECAST_WINDOW_CLOSED` (`details.reason` `NOT_OPEN`/`CLOSED`). The market must exist and be OPEN with `now < close_at` (409 `MARKET_CLOSED`). Every evidence ID must exist and be PUBLIC/EXCERPT, or PRIVATE owned by the caller's operator (409 `EVIDENCE_NOT_ALLOWED`). Duplicate `(window, agent)`, even with a new key → 409 `FORECAST_ALREADY_SUBMITTED`. Insert, audit (`forecast.submitted`), store the idempotent result 201 `{submissionId, receivedAt, windowId}`. `received_at` is DB time, not the body's.
3. Window list: `status` = UPCOMING (`now < open_at`), OPEN, CLOSED (`now ≥ deadline`); paginated by `scheduled_at` then `horizon_type`.
4. Forecast list (`windowId` required): if the window is CLOSED, all submissions with `withdrawnAt` (from a WITHDRAWN annotation) and `contaminated` (any OUTCOME_ALREADY_PUBLIC/WINDOW_CONTAMINATED annotation). Otherwise anonymous callers get `items: []`, and an authenticated caller gets only their own agent's submission. A malformed or invalid Authorization header → 401.
5. Snapshot: take the most recent window with `deadline ≤ now` and `now − deadline ≤ 24 h` where both FORECASTER_A and FORECASTER_B have submissions without WITHDRAWN/contamination annotations. Insert or reuse the snapshot (`ON CONFLICT (window_id) DO NOTHING`, then select); `probability_sum_millionths = round6(pA)·1e6 + round6(pB)·1e6` as integers (probabilities already have ≤ 6 decimals). Otherwise null (ensemble missing; baseline never substitutes).
6. `forecast:admin register-platform-agent --agent-id --role --model --prompt-hash --policy-version --reason` and `annotate --submission-id --kind --reason`, with audit rows (forecast-admin DB role).

**Tests:**
- `tests/forecast-windows.test.ts`: windows for a close 3 days ahead; PRE_CLOSE coinciding with 00:00 gives two windows of different types; created 10 min before a deadline → that window is included; created after a deadline → excluded; `snapshotPriceBase` vectors (sum 1,200,000 → YES 6000/NO 4000; 1,200,001 → YES 6001/NO 4000; 0 → YES 0/NO 10000; 2,000,000 → YES 10000/NO 0).
- `tests/forecasts.test.ts` (PGlite + `SET blink.test_clock_offset_seconds` to move time): submit inside a window → 201; before open → `NOT_OPEN`; at exactly the deadline → `CLOSED`; a second submission with a new key → 409; idempotent replay; another operator's PRIVATE evidence → 409; visibility (anonymous empty before the deadline, own only when authenticated, all after the deadline with flags); snapshot with both agents; snapshot missing B → null; contamination annotation excludes; > 24 h old → null; the scheduler is idempotent; `blink_worker` SELECT on submissions → permission denied.
- `tests/postgres/forecasts.test.ts`: a submission racing the deadline on two connections cannot land after the deadline (one submits at deadline − ε while the window lock is held; the other attempts after) — assert no row has `received_at ≥ deadline`.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`.
- [ ] Write `docs/M3_FORECASTS.md`; commit on `ws/t7-forecasts`.

---

### Task 8: Restricted signer, nonce manager and transaction dispatcher

**Goal:** Implement the private signer process (design 04 "Signer internal protocol", ADR 0002 §4): persisted sign requests, role-scoped policies, deterministic idempotent signing of EIP-712 maker quotes and of keeper/faucet/trader transactions, nonce allocation that never re-nonces unknown transactions, gas caps, and a dispatcher that broadcasts only persisted artifacts and tracks receipts, replacements and reorgs.

**Depends on:** Task 1 (0007, `blink-abi.ts`, Anvil helper). It uses Task 2's job queue only through a structural `JobHandler` type for `tx.dispatch`.

**Files:**
- Create: `packages/adapters/migrations/0010_signing.sql`, `packages/domain/src/signing-policy.ts`, `packages/ports/src/signing.ts`, `packages/application/src/signer.ts`, `packages/application/src/tx-dispatcher.ts`, `packages/adapters/src/signing-store.ts`, `packages/adapters/src/signer-client.ts`, `packages/adapters/src/key-file.ts`, `packages/adapters/src/gas-oracle.ts`, `apps/signer/src/config.ts`, `tests/signing-policy.test.ts`, `tests/signer.test.ts`, `tests/anvil/signer-dispatch.test.ts`, `tests/postgres/signing.test.ts`, `docs/M2_SIGNER.md`
- Modify: `apps/signer/src/main.ts`, `apps/signer/package.json`, `packages/domain/src/execution.ts` (replace the draft `SignRequest`/`SignResult`), `packages/ports/src/index.ts` (replace `RestrictedSigner`), exports, `scripts/build-services.mjs` if needed

**Interfaces — Produces:**

```ts
// packages/ports/src/signing.ts
export type SignRole = "maker" | "trader" | "keeper" | "faucet";
export type IntentKind = "MAKER_QUOTE" | "APPROVE" | "FILL" | "REDEEM" | "MINT" | "FINALIZE_UNCHALLENGED" | "FINALIZE_TIMEOUT";
export interface SignResult { state: "SIGNED"; artifactId: string; artifactHash: string; signature?: string; txHash?: string } | { state: "REJECTED"; code: string } | { state: "UNKNOWN"; code: string };
export interface RestrictedSigner { sign(input: { signRequestId: string; expectedRequestHash: string }): Promise<SignResult> }
export interface SigningIntentWriter { // used inside other stores' business transactions (worker/API)
  createIntent(client, input: { deploymentId: string; kind: IntentKind; role: SignRole; dedupeKey: string; payload: Record<string, unknown>; createdBy: string }): Promise<{ intentId: string; created: boolean }>;
  createSignRequest(client, input: { intentId: string; role: SignRole; unsignedPayload: Record<string, unknown>; requestHash: string; policyVersion: string; artifactVersion?: number }): Promise<{ signRequestId: string }>;
}
// adapters
export function signerClient(options: { url: string; token: string; timeoutMs?: number }): RestrictedSigner; // timeout/network error → { state: "UNKNOWN", code: "SIGNER_TIMEOUT" }
export function signingIntentWriter(): SigningIntentWriter;
export async function readKeyFile(path: string): Promise<`0x${string}`>; // refuses a mode broader than 0600 (KEY_FILE_PERMISSIONS)
// application
export function createSignerService(deps: { store: SignerStore; keys: Partial<Record<SignRole, LocalAccount>>; rpc: SignerRpc; deployment: DeploymentManifest; callers: { name: string; tokenSha256: string; roles: SignRole[] }[]; policy: { l1FeeMode: "oracle" | "local-none"; perTxCapWei: bigint; dailyCapWei: bigint }; quoteCheck?: (input: { signRequest; intent; client }) => Promise<void> }): { handle(token: string | undefined, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> };
export function createTxDispatcher(deps: { store: DispatchStore; rpc: DispatchRpc; signer: RestrictedSigner; replaceAfterMs?: number }): { dispatch(intentId: string, signal?: AbortSignal): Promise<"SUBMITTED" | "INCLUDED" | "FINALIZED" | "REVERTED" | "UNKNOWN" | "PENDING"> };
```

**0010_signing.sql:** schema `signing` with:
- `economic_intents(id UUID PK, deployment_id TEXT NOT NULL REFERENCES markets.deployments, kind TEXT CHECK IN (the IntentKind values), role TEXT CHECK IN ('maker','trader','keeper','faucet'), dedupe_key TEXT NOT NULL UNIQUE, payload JSONB NOT NULL, payload_hash blink.hash NOT NULL, state TEXT NOT NULL CHECK (state IN ('PREPARED','SIGNED','SUBMITTED','UNKNOWN','INCLUDED','FINALIZED','FAILED','CANCELLED')), created_by TEXT NOT NULL, created_at, updated_at, version BIGINT NOT NULL DEFAULT 0)`
- `sign_requests(id UUID PK, intent_id UUID NOT NULL REFERENCES economic_intents, artifact_version INTEGER NOT NULL DEFAULT 1 CHECK (artifact_version > 0), role TEXT NOT NULL, request_hash blink.hash NOT NULL, unsigned_payload JSONB NOT NULL, policy_version TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('REQUESTED','SIGNED','REJECTED')), reject_code TEXT, created_at, updated_at, UNIQUE (role, intent_id, artifact_version))`
- `artifacts(id UUID PK, sign_request_id UUID NOT NULL UNIQUE REFERENCES sign_requests, artifact_hash blink.hash NOT NULL, signature TEXT, raw_transaction TEXT, created_at)` — append-only.
- `nonce_allocations(chain_id INTEGER NOT NULL CHECK (chain_id = 84532), sender blink.address NOT NULL, nonce blink.uint256 NOT NULL, intent_id UUID NOT NULL UNIQUE REFERENCES economic_intents, created_at, PRIMARY KEY (chain_id, sender, nonce))`
- `sender_guards(chain_id INTEGER NOT NULL, sender blink.address NOT NULL, PRIMARY KEY (chain_id, sender))`
- `tx_attempts(id UUID PK, intent_id UUID NOT NULL REFERENCES economic_intents, artifact_id UUID NOT NULL UNIQUE REFERENCES artifacts, tx_hash blink.hash NOT NULL UNIQUE, nonce blink.uint256 NOT NULL, replacement_of UUID REFERENCES tx_attempts, gas_limit blink.uint256 NOT NULL, max_fee_per_gas blink.uint256 NOT NULL, max_priority_fee_per_gas blink.uint256 NOT NULL, max_cost_wei blink.uint256 NOT NULL, status TEXT NOT NULL CHECK (status IN ('SIGNED','SUBMITTED','INCLUDED','FINALIZED','REVERTED','REPLACED','UNKNOWN','REORGED')), receipt_block_hash blink.hash, receipt_block_number blink.uint256, gas_spent_wei blink.uint256, submitted_at TIMESTAMPTZ, created_at, updated_at, version BIGINT NOT NULL DEFAULT 0)`
- `gas_spend(role TEXT NOT NULL, day DATE NOT NULL, reserved_wei blink.uint256 NOT NULL DEFAULT 0, spent_wei blink.uint256 NOT NULL DEFAULT 0, PRIMARY KEY (role, day))`
- Grants: `blink_signer` SELECT on intents/sign_requests/sender_guards/nonce_allocations/gas_spend/artifacts, UPDATE(state, reject_code, updated_at) on sign_requests, UPDATE(state, updated_at, version) on intents, INSERT on artifacts/nonce_allocations/sender_guards, INSERT/UPDATE on gas_spend, SELECT on `markets.deployments`. `blink_api`: INSERT/SELECT on intents (MAKER_QUOTE only, enforced by a CHECK trigger or by the application; prefer a `BEFORE INSERT` trigger that rejects non-MAKER_QUOTE when `current_user` is a member of `blink_api`), INSERT/SELECT on sign_requests, `SELECT (id, sign_request_id, artifact_hash, signature, created_at)` on artifacts — **never** `raw_transaction`. `blink_worker`: INSERT/SELECT on intents/sign_requests, SELECT on artifacts (including raw), INSERT/SELECT/UPDATE on tx_attempts, UPDATE(state, updated_at, version) on intents, UPDATE(spent_wei) on gas_spend.

**Rules (signer):**
1. HTTP `POST /internal/sign` on `SIGNER_HOST` (default `127.0.0.1`) / `SIGNER_PORT` (3004). `Authorization: Bearer <token>`; SHA-256 of the token matched in constant time against `SIGNER_CALLERS` (JSON `[{name, tokenSha256, roles}]`). Unknown token → 401. A role not allowed for the caller → 403 `ROLE_DENIED`. Body `{signRequestId, expectedRequestHash}` strict.
2. Keys: `SIGNER_MAKER_KEY_FILE`, `SIGNER_KEEPER_KEY_FILE`, `SIGNER_FAUCET_KEY_FILE`, `SIGNER_TRADER_KEY_FILE`, each optional (a missing file disables that role). Startup: the maker key address = `manifest.roles.maker`; the faucet key = `manifest.roles.faucetMinter`; keeper and trader addresses must not equal any manifest role or contract; RPC chain = 84532 (8453 → `MAINNET_REFUSED`); the deployment is loaded from `markets.deployments` by `SIGNER_DEPLOYMENT_ID` and must be enabled.
3. Sign flow, in one DB transaction: lock the sign request; if SIGNED, return the existing artifact (idempotent); if REJECTED, return the rejection; `request_hash` must equal `expectedRequestHash` (else REJECTED `REQUEST_HASH_MISMATCH`); validate the role policy; sign; persist the artifact; set the sign request SIGNED and the intent SIGNED; commit; respond. Signing is deterministic (RFC 6979), so a crash after signing and before commit is recovered by re-signing the same payload with the same allocation.
4. MAKER_QUOTE policy (`unsigned_payload` = the Quote message with decimal strings): the deployment is enabled and `manifest.tradingEnabled`; `maker` = the maker key; domain = `{name:"Blink RFQ", version:"0.1", chainId:84532, verifyingContract: manifest BlinkMarket}`; `1 ≤ expiresAt − validAfter ≤ 60`; the signer clock is `< expiresAt − 2 s`; the market exists in `chain.markets`, is OPEN, has `expiresAt ≤ close_at` and `specHash = spec_hash`; `epoch = chain.maker_state.epoch`; quantity 1..100; priceBps 1..9999; `request_hash` = `hashTypedData` of the message. The optional `quoteCheck` hook runs last (Task 9 adds the reservation check). The artifact stores `artifact_hash = digest` and `signature`.
5. Transaction policies (`unsigned_payload = {to, functionName, args}`; the signer encodes calldata itself from `blink-abi.ts`; value is always 0): keeper → BlinkMarket `finalizeUnchallenged(id)`/`finalizeTimeout(id)`; faucet → BlinkTestUSD `mint(to, amount)` with `amount ≤ 1_000_000_000`; trader → BlinkTestUSD `approve(BlinkMarket, amount)` with `0 < amount ≤ 100_000_000` (never unlimited), BlinkMarket `fillQuote(q, sig)` with `q.taker` = the trader key and `q.maker` = the manifest maker, or BlinkMarket `redeem(id)`. Anything else → REJECTED (`SELECTOR_NOT_ALLOWED`, `TARGET_NOT_ALLOWED`, `AMOUNT_NOT_ALLOWED`, `TAKER_NOT_ALLOWED`).
6. Gas: `estimateGas` (failure → REJECTED `GAS_ESTIMATE_FAILED`); `gasLimit = estimate·12/10`; EIP-1559 fees with `maxFee = 2·baseFee + priority`; L1 fee via the Base GasPriceOracle `0x420000000000000000000000000000000000000F.getL1Fee(bytes)` when `l1FeeMode='oracle'`. `local-none` is allowed only when the RPC URL host is loopback, else startup fails. `maxCost = gasLimit·maxFee + l1Fee ≤ 200_000_000_000_000 wei` (0.0002 ETH) else `GAS_CAP_EXCEEDED`; `gas_spend(role, UTC day).reserved + spent + maxCost ≤ 2_000_000_000_000_000` (0.002 ETH) else `GAS_DAILY_CAP_EXCEEDED`; reserve on success.
7. Nonce: lock `sender_guards(84532, sender)` (insert if missing); `rpcPending = getTransactionCount(sender, "pending")`; `dbNext = max(allocated)+1` (or `rpcPending` if none). If `rpcPending > dbNext`, an unknown occupant used the nonce: REJECTED `NONCE_UNKNOWN_OCCUPANT` plus an audit alert (never skip ahead). Else allocate `dbNext`. A replacement (`artifact_version > 1`) reuses the intent's allocation and may change only the fee fields (≥ +12.5 % on both), never the calldata.

**Rules (dispatcher, job `tx.dispatch` payload `{intentId}`):**
8. Only persisted artifacts are broadcast. A new artifact with no attempt → insert an attempt SIGNED, then `eth_sendRawTransaction`, then SUBMITTED. "already known" and "nonce too low" are not failures: mark UNKNOWN and look up the receipt by hash.
9. Receipt in a canonical block → INCLUDED (FINALIZED when `≤ finalized`); revert → REVERTED (intent FAILED); record `gas_spent_wei` and move it into `gas_spend.spent`. Receipt block no longer canonical → REORGED, then rebroadcast the same raw bytes. Not found after `replaceAfterMs` (default 60 s) and gas policy allows → request a replacement version from the signer; when any version is included, the others are REPLACED. Never allocate a new nonce for the same intent.
10. Returns `PENDING` while waiting; the handler re-enqueues itself with a delay (via `JobError("TX_PENDING", true)`, or by Task 2's runAt when available).

**Tests:**
- `tests/signing-policy.test.ts`: every rejection code in Rules 4–5 plus accepted cases; replacement fee bump below 12.5 % → rejected.
- `tests/signer.test.ts` (PGlite + fake RPC): unknown token 401; wrong role 403; request hash mismatch; idempotent re-sign returns the identical artifact; maker quote signature recovers to the maker; gas cap per transaction and per day; `NONCE_UNKNOWN_OCCUPANT`; key file 0644 → `KEY_FILE_PERMISSIONS`; startup with a maker key ≠ manifest maker → refuses; `blink_api` selecting `raw_transaction` → permission denied; `blink_api` inserting a MINT intent → rejected.
- `tests/anvil/signer-dispatch.test.ts`: a faucet MINT intent is signed, dispatched and INCLUDED, and the balance is +1000 bUSD; a crash simulation (sign, roll back the persistence, sign again) gives the same tx hash; a replacement with the same nonce and higher fees, where only one version is included and the others are REPLACED; a reorg (snapshot, include, revert) → REORGED, rebroadcast, then INCLUDED again.
- `tests/postgres/signing.test.ts`: two signer pools allocate for the same sender concurrently → distinct consecutive nonces; S07: dispatcher restart while UNKNOWN → no new nonce or intent is created.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`, `pnpm test:anvil`.
- [ ] Write `docs/M2_SIGNER.md`; commit on `ws/t8-signer`.

---

### Task 9: RFQ, quotes and collateral reservations

**Goal:** `POST /v1/rfqs` and `GET /v1/quotes/:quoteId` per spec §8 and design 04: deterministic pricing from the ensemble snapshot, freshness and pause gates, the maker collateral pool with reservations under a row lock, signing through the restricted signer, idempotent retries, and reconciliation of reservations against canonical chain state (including reorgs). Enables `trading` mode and a truthful `/v1/config`.

**Depends on:** Tasks 5, 7, 8 merged.

**Files:**
- Create: `packages/adapters/migrations/0012_trading.sql`, `packages/domain/src/pricing.ts`, `packages/ports/src/trading.ts`, `packages/application/src/rfq.ts`, `packages/application/src/quote-reconcile.ts`, `packages/adapters/src/trading-store.ts`, `packages/adapters/src/chain-snapshot-reader.ts`, `scripts/trading-admin.ts`, `tests/pricing.test.ts`, `tests/rfq.test.ts`, `tests/quote-reconcile.test.ts`, `tests/anvil/rfq.test.ts`, `tests/postgres/rfq.test.ts`, `docs/M2_RFQ.md`
- Modify: `packages/application/src/signer.ts` (wire the `quoteCheck` reservation hook in signer composition), `apps/signer/src/main.ts`, `apps/api/src/main.ts` (trading mode: RFQ service, `config` callback, market read `canTrade` hook), `apps/worker/src/handlers.ts` (`quote.reconcile` + outbox mapping `chain.synced`/`chain.reorged` → `quote.reconcile`), exports, `package.json` (`"trading:admin"`)

**Interfaces — Produces:**

```ts
// packages/domain/src/pricing.ts
export function askPriceBps(input: { probabilitySumMillionths: number; side: "YES" | "NO"; spreadBps: number }): number; // clamp(snapshotPriceBase + spread, 1, 9999)
export function quoteCosts(quantity: bigint, priceBps: number): { takerCostMicros: bigint; makerCostMicros: bigint }; // taker = q·price·100; maker = q·1e6 − taker
// packages/application/src/rfq.ts
export function createRfqService(deps: { store: TradingStore; crypto: IdentityCrypto; signer: RestrictedSigner; chain: ChainSnapshotReader; snapshots: { latest(deploymentId: string, marketId: string): Promise<{ snapshotId: string; probabilitySumMillionths: number; deadline: Date } | null> }; deploymentId: string; random(): bigint; limiter: { take(key: string) } }): RouteService; // POST /v1/rfqs, GET /v1/quotes/:quoteId
export function createQuoteReconciler(store: TradingStore): { reconcileOnce(deploymentId: string): Promise<{ accounted: number; released: number; reopened: number }> };
```

**0012_trading.sql:** schema `trading`:
- `maker_pools(deployment_id TEXT PK REFERENCES markets.deployments, gate_reason TEXT CHECK (gate_reason IN ('OVERCOMMITTED')), version BIGINT NOT NULL DEFAULT 0)`
- `quote_gates(id UUID PK, deployment_id TEXT NOT NULL, market_id blink.uint256 NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('OUTCOME_KNOWN','ANNOUNCEMENT_EARLY','OPERATOR_PAUSE','SPEC_INTEGRITY')), actor TEXT NOT NULL, note TEXT NOT NULL, closed_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(), reopened_at TIMESTAMPTZ, reopened_by TEXT)`, with a partial unique index on `(deployment_id, market_id, reason) WHERE reopened_at IS NULL`
- `quotes(id UUID PK, digest blink.hash NOT NULL UNIQUE, deployment_id TEXT NOT NULL, market_id blink.uint256 NOT NULL, agent_id UUID NOT NULL, key_id UUID NOT NULL, taker blink.address NOT NULL, side TEXT CHECK IN ('YES','NO'), quantity blink.uint256 NOT NULL, price_bps INTEGER NOT NULL, taker_cost_micros blink.uint256 NOT NULL, maker_cost_micros blink.uint256 NOT NULL, max_cost_micros blink.uint256 NOT NULL, valid_after blink.uint256 NOT NULL, expires_at blink.uint256 NOT NULL, nonce blink.uint256 NOT NULL, epoch blink.uint256 NOT NULL, spec_hash blink.hash NOT NULL, forecast_snapshot_id UUID NOT NULL REFERENCES forecasts.snapshots, intent_id UUID NOT NULL UNIQUE REFERENCES signing.economic_intents, sign_request_id UUID NOT NULL UNIQUE REFERENCES signing.sign_requests, snapshot_block_number blink.uint256 NOT NULL, snapshot_block_hash blink.hash NOT NULL, status TEXT NOT NULL CHECK (status IN ('SIGN_REQUESTED','SIGNED','SIGN_UNKNOWN','SIGN_REJECTED','EXPIRED','CANCELLED','CONSUMED')), status_block_hash blink.hash, envelope JSONB, created_at, signed_at, updated_at, version BIGINT NOT NULL DEFAULT 0)`
- `collateral_reservations(id UUID PK, quote_id UUID NOT NULL UNIQUE REFERENCES quotes, deployment_id TEXT NOT NULL, amount_micros blink.uint256 NOT NULL CHECK (amount_micros > 0), state TEXT NOT NULL CHECK (state IN ('HELD','RECONCILE_REQUIRED','ACCOUNTED','RELEASED')), state_block_number blink.uint256, state_block_hash blink.hash, created_at, updated_at, version BIGINT NOT NULL DEFAULT 0)`
- append-only `reservation_events(id UUID PK, reservation_id UUID NOT NULL REFERENCES collateral_reservations, from_state TEXT, to_state TEXT NOT NULL, block_hash blink.hash, reason TEXT NOT NULL, created_at)`
- Group role `blink_trading_admin` (gates). Grants: `blink_api` SELECT/INSERT/UPDATE on maker_pools/quotes/collateral_reservations, INSERT on reservation_events, SELECT on quote_gates; `blink_worker` the same for reconciliation; `blink_signer` SELECT on quotes and collateral_reservations; `blink_trading_admin` INSERT/UPDATE(reopened_at, reopened_by) on quote_gates plus audit insert.

**Rules — `POST /v1/rfqs`:**
1. Parse `RfqRequest` and the Idempotency-Key. Auth `trade:quote`; the agent must have a wallet binding (403 `WALLET_NOT_VERIFIED`); `taker` = the binding. Per-key limiter capacity 5, refill 2/s → 429 `RATE_LIMITED`.
2. Idempotency scope `POST /v1/rfqs`; completed → return the stored response (even if the quote has expired); in progress for an existing quote with `SIGN_UNKNOWN` → go to the **resume** path (Rule 9).
3. `body.deploymentId ≠ BLINK_DEPLOYMENT_ID` → 409 `DEPLOYMENT_MISMATCH`. Deployment disabled or `manifest.tradingEnabled=false` → 503 `SERVICE_NOT_READY` (`details.reason: TRADING_DISABLED`). Market missing → 404.
4. Freshness: `head = chain.head()` (RPC). `cursor.blockNumber ≥ head.number − 3`, `blink.now() − synced_at ≤ 10 s`, no `gate_reason`, and `head.number ≥ cursor.blockNumber` (else `CHAIN_UNAVAILABLE`); otherwise 503 `INDEXER_LAG`. Maker pool `gate_reason` set → 503 `SERVICE_NOT_READY`.
5. Chain reads at `head.hash`: `getMarket`, `globalTradingPaused`, `makerFreeBalance`, `currentMakerEpoch`, `takerAllowed(taker)`, `cumulativeTakerShares(market, taker)`. Paused → 409 `TRADING_PAUSED`; not OPEN or `head.timestamp ≥ closeAt` → 409 `MARKET_CLOSED`; taker not allowed → 409 `NO_QUOTE` (`TAKER_NOT_ALLOWED`); `totalMintedPairs + q > maxPairs` or `cumulative + q > maxTakerShares` → 409 `NO_QUOTE` (`CAP_EXCEEDED`). An open quote gate → 409 `NO_QUOTE` (`details.reason` = the gate reason).
6. `snapshots.latest` null → 409 `STALE_FORECAST`. `price = askPriceBps(sum, side, manifest.parameters.makerSpreadBps)`; costs; `takerCost > maxCostMicros` → 409 `PRICE_LIMIT_EXCEEDED` (`details: {priceBps, takerCostMicros}`). `validAfter = head.timestamp`; `expiresAt = min(validAfter + 30, closeAt)`; `expiresAt − validAfter < 5` → 409 `NO_QUOTE` (`TOO_CLOSE_TO_CLOSE`). `nonce = random()` (256-bit); message → `digest = hashTypedData`.
7. Transaction A, in lock order: claim idempotency → lock `maker_pools` row (`FOR UPDATE`, insert if missing) → re-check quote gates and the outstanding count (quotes of this taker in SIGN_REQUESTED/SIGNED/SIGN_UNKNOWN with `expires_at > cursor.block_timestamp`) `< 5`, else 409 `NO_QUOTE` (`OUTSTANDING_QUOTE_LIMIT`) → `available = makerFree@head − Σ amount(HELD, RECONCILE_REQUIRED)`; `makerCost > available` → 409 `INSUFFICIENT_MAKER_BALANCE` → insert the intent (MAKER_QUOTE, dedupe `quote:<digest>`), the sign request (`request_hash = digest`), the quote (SIGN_REQUESTED) and the reservation (HELD); bump the pool version. Business rejections in steps 3–7 are stored as terminal idempotent results.
8. `signer.sign`. SIGNED → transaction B: quote SIGNED with the envelope and `signed_at`, finish idempotency 200 with the envelope. REJECTED → quote SIGN_REJECTED, reservation RELEASED (never signed, so safe), terminal 409 `NO_QUOTE` (`details.reason: SIGNER_REJECTED`, `details.signerCode`). UNKNOWN → quote SIGN_UNKNOWN, reservation stays HELD, response 503 `SERVICE_NOT_READY` retryable with `Retry-After: 1`; idempotency stays in progress.
9. Resume (same key, quote in SIGN_UNKNOWN): call `signer.sign` with the **same** sign request (the signer is idempotent) and continue at Rule 8. Never create a new quote, nonce or reservation.
10. Envelope = `SignedQuoteResponse`: `quoteId = digest`, `types = quoteTypes`, `message` with decimal strings and side `"0"|"1"`, `calldata = encodeFunctionData(fillQuote, [message, signature])`, `forecastSnapshotId`, `chainCursor` = `{head number, head hash, finality}`.
11. Signer `quoteCheck` hook: a quote row with this digest exists in SIGN_REQUESTED or SIGN_UNKNOWN; its reservation is HELD with `amount = makerCost` computed from the message; else REJECTED `RESERVATION_MISSING`.

**Rules — `GET /v1/quotes/:quoteId`:**
12. Visible to the quote's agent (any key of that agent) or an admin key; otherwise 404. `status`: CONSUMED if `chain.quote_digests` FILLED; CANCELLED if CANCELLED or `chain.maker_state.epoch > quote.epoch`; EXPIRED if `cursor.block_timestamp ≥ expires_at`; SIGN_UNKNOWN; else SIGNED. `chainCursor` from the indexer cursor. It never extends anything.

**Rules — reconciliation (`quote.reconcile`, triggered by `chain.synced`/`chain.reorged` and every 5 s):**
13. Lock the maker pool. Use the cursor C = (number, hash, timestamp). For each HELD/RECONCILE_REQUIRED reservation: digest FILLED with `block_number ≤ C` → ACCOUNTED (state block = fill block), quote CONSUMED; CANCELLED or epoch moved → RELEASED, quote CANCELLED; `C.timestamp ≥ expires_at` and not filled → RELEASED, quote EXPIRED. A local clock past expiry while C is not past it → no change. Append `reservation_events` for every change.
14. On `chain.reorged`: every ACCOUNTED/RELEASED reservation with `state_block_number > ancestorNumber` → RECONCILE_REQUIRED (quote back to SIGNED), then run Rule 13 against the new cursor. Afterwards, if `Σ HELD+RECONCILE_REQUIRED > chain.maker_state.free_balance_micros`, set `maker_pools.gate_reason='OVERCOMMITTED'` (no new quotes) until a later reconciliation clears it.
15. `/v1/config` in trading mode: `tradingEnabled = manifest.tradingEnabled && enabled && indexer fresh (Rule 4) && !pool gate`; `deployment` = `PublicDeployment`; stage `m2-trading`. Market reads use a `canTrade` hook with the same gates plus snapshot availability (`NO_FORECAST`).
16. `trading:admin close-gate|reopen-gate --deployment --market --reason <enum> --note <text>` with audit.

**Tests:**
- `tests/pricing.test.ts`: spec §10.2 vector (sum 1,200,000, YES, q=10 → 6200 bps, taker 6,200,000, maker 3,800,000); odd sum 1,200,001 → 6201; p=1 YES → 9999, NO → 200; p=0 YES → 200, NO → 9999; costs with q=100 at 9999.
- `tests/rfq.test.ts` (PGlite + fake chain + fake signer + seeded chain/forecast rows): happy path, where the envelope's signature recovers to the maker and the calldata decodes to `fillQuote(message, signature)`; idempotent replay after expiry returns the identical envelope; same key with a different payload → 409; each rejection code from Rules 3–7; sign timeout → 503 with SIGN_UNKNOWN and HELD, then a retry with the same key after the signer recovers → the same digest and exactly one reservation; signer rejection → RELEASED; rate limit (6 rapid requests → one 429); outstanding limit; quote visibility (another agent 404, admin OK).
- `tests/quote-reconcile.test.ts`: fill → ACCOUNTED/CONSUMED; block-time expiry → RELEASED; local time past expiry but cursor not → HELD; cancel → RELEASED; epoch bump → RELEASED; reorg rollback → RECONCILE_REQUIRED then re-evaluated; overcommitted gate set and cleared.
- `tests/anvil/rfq.test.ts`: full chain + indexer + signer process (in-process service with a key file in a temp dir, mode 0600) + API: platform forecasts seeded into a closed window → RFQ → the taker verifies, approves exactly and fills → indexer sync → reconcile ACCOUNTED → `GET /v1/quotes/:id` CONSUMED → positions show the shares.
- `tests/postgres/rfq.test.ts`: two RFQs competing for the last maker collateral on separate pools → exactly one succeeds, the other gets `INSUFFICIENT_MAKER_BALANCE`.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`, `pnpm test:anvil`.
- [ ] Write `docs/M2_RFQ.md`; commit on `ws/t9-rfq`.

---

### Task 10: Discovery, forecaster and baseline workers

**Goal:** Worker jobs that turn allowlisted documents into candidates and produce platform forecasts and the baseline under budget, using the fixture model gateway and the public API as platform agents (spec §12.1–12.2, design 05).

**Depends on:** Tasks 2, 3, 7 merged.

**Files:**
- Create: `packages/adapters/migrations/0017_discovery_runs.sql`, `packages/domain/src/prompts.ts`, `packages/application/src/discovery.ts`, `packages/application/src/platform-forecaster.ts`, `packages/adapters/src/discovery-store.ts`, `packages/adapters/src/platform-run-store.ts`, `fixtures/replay/models/README.md`, `fixtures/replay/models/gm-replay.json`, `tests/discovery.test.ts`, `tests/platform-forecaster.test.ts`, `docs/M3_RESEARCH_WORKERS.md`
- Modify: `apps/worker/src/handlers.ts`, `apps/worker/src/config.ts` (platform agent keys: `WORKER_DISCOVERY_API_KEY`, `WORKER_FORECASTER_A_API_KEY`, `WORKER_FORECASTER_B_API_KEY`, `WORKER_BASELINE_API_KEY`, `WORKER_API_URL`, `WORKER_MODEL_FIXTURES`), `packages/client/src/index.ts` (add `createCandidate` if missing, `submitForecast`, `getMarket`, `listForecastWindows`), exports

**0017_discovery_runs.sql:** `discovery.scan_runs(id UUID PK, source_id UUID NOT NULL REFERENCES evidence.sources, day DATE NOT NULL, slot SMALLINT NOT NULL CHECK (slot IN (0,1)), state TEXT NOT NULL CHECK (state IN ('STARTED','CANDIDATE_CREATED','NO_CANDIDATE','MANUAL_REVIEW','FAILED','SKIPPED_DAILY_CAP')), evidence_id UUID REFERENCES evidence.records, candidate_id UUID, attempts SMALLINT NOT NULL DEFAULT 0, error_code TEXT, created_at, updated_at, UNIQUE (source_id, day, slot))`; `discovery.daily_counters(day DATE PK, candidates INTEGER NOT NULL DEFAULT 0 CHECK (candidates BETWEEN 0 AND 10))`. Grants to `blink_worker`.

**Rules:**
1. `discovery.scan` (payload `{sourceId, day, slot}`; scheduled with `schedulePeriodic` at most twice per UTC day per fetch-enabled source): create the run (UNIQUE makes reruns idempotent); fetch evidence (reuse Task 3's handler logic as a function) or use the newest evidence for the source from the same UTC day; build the prompt with `discoveryPrompt(documentText)`, where the document goes between fixed delimiters with an instruction that it is untrusted data; call the budgeted model with question key `scan:<runId>`, cap 2,000,000, `maxOutputTokens` 800; parse with a strict zod schema `{entityId, fiscalPeriod, thresholdBps (0..10000 int), thesis (≤ 1000 chars)}`. Invalid → **one** retry with a new runId and a new reservation; still invalid → MANUAL_REVIEW + audit. Valid → lock `daily_counters` (> 10 → SKIPPED_DAILY_CAP) → `client.createCandidate({templateId:"GM_LT_V1", entityId, fiscalPeriod, thresholdBps, evidenceIds:[evidenceId], thesis})` with the discovery key and Idempotency-Key = runId → CANDIDATE_CREATED. Evidence IDs never come from model output.
2. `forecast.dispatch` (every 60 s): for OPEN windows of OPEN markets, enqueue `forecast.run` for FORECASTER_A and FORECASTER_B and `baseline.run` for BASELINE (dedupe `forecast.run:<windowId>:<role>`).
3. `forecast.run`/`baseline.run` (payload `{windowId, role}`): load the platform agent (`model`, `prompt_hash`); load the market (`client.getMarket`) and its spec evidence; `data_cutoff = window.open_at`; only evidence with `observed_at ≤ data_cutoff` is included. Build the prompt with `forecastPrompt(role, spec, evidenceTexts)`; `promptHash` must equal the registered `prompt_hash` (else `PROMPT_MISMATCH`, non-retryable). Create the `model_runs` row; budgeted call with question key `candidate:<candidateId>` (from the approval matching the spec hash), cap = `approval.budget_micros`. Parse `{probability (≤ 6 decimals), rationale, evidenceIds ⊆ allowed}`; one retry on schema error; submit with the role's API key and Idempotency-Key = runId. 409 `FORECAST_WINDOW_CLOSED` → run state LATE (no retry). `BUDGET_EXHAUSTED` → FAILED, non-retryable. The runner never reads `forecasts.submissions` (the DB grant denies it).
4. Prompts are versioned constants in `packages/domain/src/prompts.ts` (`DISCOVERY_PROMPT_V1`, `FORECAST_PROMPT_A_V1`, `FORECAST_PROMPT_B_V1`, `BASELINE_PROMPT_V1`), and `promptHash = keccak256(utf8(prompt template))`.
5. The fixture gateway reads `WORKER_MODEL_FIXTURES` (JSON file mapping `{model, promptHash, inputHash} → output`, or a default output per model); `gm-replay.json` supplies outputs for the REPLAY E2E (Task 16).

**Tests:**
- `tests/discovery.test.ts`: valid output → candidate created via a fake client with Idempotency-Key = runId; schema invalid twice → MANUAL_REVIEW with two reservations recorded; budget exhausted → no model call; the 11th candidate of the day → SKIPPED_DAILY_CAP; an injection document whose model output tries to cite a foreign evidence ID or URL → the created candidate cites only the fetched evidence ID; rerunning the same `(source, day, slot)` → no second run.
- `tests/platform-forecaster.test.ts`: A and B submit with their own keys; evidence after the cutoff is excluded from the prompt; a late submission → LATE; prompt hash mismatch → non-retryable; the baseline submits under the BASELINE agent; `blink_worker` cannot select submissions.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`.
- [ ] Write `docs/M3_RESEARCH_WORKERS.md`; commit on `ws/t10-research-workers`.

---

### Task 11: Resolution reports, parser suggestions and role drafts

**Goal:** Spec §12.4 and §13.1: external resolution reports into an auditor queue, a deterministic parser that suggests outcomes for GM_LT_V1, deadline alerts, and unsigned drafts for the human RESULT_PROPOSER/CHALLENGER/ARBITER wallets.

**Depends on:** Tasks 2 and 5 merged.

**Files:**
- Create: `packages/adapters/migrations/0014_resolution.sql`, `packages/domain/src/gm-parser.ts`, `packages/application/src/resolution.ts`, `packages/adapters/src/resolution-store.ts`, `scripts/resolution-draft.ts`, `tests/gm-parser.test.ts`, `tests/resolution.test.ts`, `docs/M3_RESOLUTION.md`
- Modify: `packages/schemas/src/http.ts` (add admin contracts: `GET /v1/admin/resolution-reports` (query `deploymentId`, optional `marketId`, `state`, list), `POST /v1/admin/resolution-reports/:id/triage` (body `{state: "TRIAGED"|"DISMISSED"|"ACTIONED", reason}`, admin)), `apps/api/src/routes.ts` (matching route metadata), `apps/api/src/main.ts`, `apps/worker/src/handlers.ts`, `package.json` (`"resolution:draft"`), exports

**0014_resolution.sql:** schema `resolution`: `reports(id UUID PK, deployment_id, market_id blink.uint256, agent_id UUID REFERENCES identity.agents, operator_id UUID, outcome TEXT CHECK IN ('YES','NO','INVALID'), evidence_ids UUID[] NOT NULL CHECK (cardinality(evidence_ids) BETWEEN 1 AND 50), reason TEXT NOT NULL, created_at)` (append-only); `report_events(id, report_id, state CHECK IN ('RECEIVED','TRIAGED','DISMISSED','ACTIONED'), actor, reason, created_at)` (append-only; the current state = the latest event); `suggestions(id UUID PK, deployment_id, market_id, evidence_id UUID, value_bps INTEGER, outcome TEXT, locator JSONB NOT NULL, parser_version TEXT NOT NULL, created_at, UNIQUE (deployment_id, market_id, evidence_id, parser_version))`; `alerts_sent(deployment_id, market_id, kind, threshold_seconds, PRIMARY KEY (...))`. Grants: api INSERT/SELECT reports and report_events, SELECT suggestions; worker INSERT/SELECT suggestions and alerts_sent, SELECT evidence.

**Rules:**
1. `POST /v1/markets/:id/resolution-reports` (`report:write`, idempotent): the market exists in `chain.markets`; evidence must be visible to the reporter (same rule as forecasts); insert the report + a RECEIVED event + audit → 202 `{reportId, state:"RECEIVED"}`. It never changes chain state.
2. Admin list and triage (admin scope, idempotent triage) append events with a reason.
3. `parseGrossMargin(text: string): {valueBps: number; locator: {start: number; end: number; excerpt: string}} | {ambiguous: true; reason: "NONE" | "MULTIPLE_VALUES" | "PRECISION" | "NON_GAAP_ONLY"}` — a pure function. It accepts "GAAP gross margin" phrases followed within 80 characters by a percentage with ≤ 2 decimals. Distinct values → `MULTIPLE_VALUES`; more decimals → `PRECISION`; only "non-GAAP" phrases → `NON_GAAP_ONLY`. Outcome suggestion: `valueBps < thresholdBps` → YES else NO.
4. `resolution.parse` job (after close, for markets with an approval): run the parser over evidence records for the market's entity observed after `close_at`; store suggestions. Ambiguous → no suggestion, plus an audit row `resolution.manual_required`.
5. `resolution.alerts` (every 60 s): emit `alert.deadline` outbox events (once per `alerts_sent` key) at 24 h/1 h/10 min before the challenge end and the hard deadline for LIVE (86,400 s challenge), and at 60 s/30 s/10 s for REPLAY (120 s challenge).
6. `pnpm resolution:draft --deployment <id> --market <id> --action propose|challenge|arbitrate --outcome YES|NO|INVALID --evidence-hash 0x…` prints `{chainId:84532, to, requiredSender (manifest role), data, value:"0", warnings[]}`, where warnings flag timing violations against the projection (for example propose before `close_at`). It reads only; it never signs.

**Tests:** parser vectors (≥ 12: plain, two equal values, two different values, "61.25%", "61.255%", non-GAAP only, GAAP far away (> 80 chars), "gross margin of 61.2 percent", Unicode percent, etc.); report POST (permissions, private evidence 409, idempotency, unknown market 404); triage events; alert thresholds fire once each; the draft CLI encodes the correct selectors and required senders and warns on early propose.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`.
- [ ] Write `docs/M3_RESOLUTION.md`; commit on `ws/t11-resolution`.

---

### Task 12: Evaluation scores and public metrics

**Goal:** Spec §15 quality metrics: Brier per event/horizon for the platform ensemble, baseline and external agents, with LIVE/REPLAY separated, INVALID/missing/contaminated reported separately, and `GET /v1/metrics`.

**Depends on:** Tasks 2 and 7 merged (reads `chain.markets` from 0007).

**Files:**
- Create: `packages/adapters/migrations/0015_evaluation.sql`, `packages/domain/src/brier.ts`, `packages/application/src/evaluation.ts`, `packages/adapters/src/evaluation-store.ts`, `tests/brier.test.ts`, `tests/evaluation.test.ts`, `docs/M3_EVALUATION.md`
- Modify: `apps/api/src/main.ts`, `apps/worker/src/handlers.ts`, exports

**0015_evaluation.sql:** schema `analytics`: `score_entries(id UUID PK, deployment_id, market_id, window_id UUID REFERENCES forecasts.windows, mode TEXT CHECK IN ('LIVE','REPLAY'), scorer TEXT CHECK IN ('ENSEMBLE','BASELINE','AGENT'), agent_id UUID, probability_millionths INTEGER, outcome TEXT CHECK IN ('YES','NO','INVALID'), brier NUMERIC, missing BOOLEAN NOT NULL, contaminated BOOLEAN NOT NULL, evaluation_version TEXT NOT NULL, created_at, UNIQUE (window_id, scorer, agent_id, evaluation_version))` (NULLS NOT DISTINCT for `agent_id`, or use a sentinel UUID for ENSEMBLE/BASELINE); append-only. Grants: worker INSERT/SELECT; api SELECT.

**Rules:**
1. `brierExact(probabilityMillionthsTimes2: bigint, outcome: 0 | 1): string` returns the exact decimal string of `((x − 2·y·1e6)²) / 4e12` (finite decimal), computed with bigint only. Use it for the ensemble (`x = mA + mB`) and for single forecasts (`x = 2m`).
2. `evaluation.score` (on `market.indexed` when FINAL and every 10 min, idempotent per `evaluation_version='v1'`): for each window of each FINAL market, write ENSEMBLE (missing if A or B is absent/withdrawn; contaminated if either is annotated), BASELINE, and one AGENT row per external submission. INVALID outcome → rows with `outcome='INVALID'`, `brier=null`.
3. `GET /v1/metrics?mode=`: `eventCount` = FINAL YES/NO markets in the mode with ≥ 1 non-missing, non-contaminated ENSEMBLE row; `missingCount` = ENSEMBLE rows with `missing`; `invalidCount` = INVALID markets; `brier` = the mean over events of (the mean ENSEMBLE Brier across that event's windows), as a JSON number rounded to 6 decimals, or null if `eventCount = 0`. `spent/reserved/unknownUsdMicros` = budget `totals()` (platform-wide; the docs say they are not split by mode). The response is cacheable for 60 s. This follows spec §15: different windows are not counted as independent events.

**Tests:** Brier exact vectors (p=0.7,y=1 → "0.09"; ensemble 0.6/0.7, y=0 → "0.4225"; p=0.123457 exact); scoring with missing B, contamination, INVALID, REPLAY isolated from LIVE, idempotent rerun; the metrics aggregation example with 2 events × 3 windows.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`.
- [ ] Write `docs/M3_EVALUATION.md`; commit on `ws/t12-evaluation`.

---

### Task 13: Keeper finalization and test-asset faucet

**Goal:** Spec §9.1 faucet (1,000 bUSD per approved address per rolling 24 h) and §12.4 keeper (permissionless finalize at the right times), both as signed intents through the restricted signer and the dispatcher.

**Depends on:** Tasks 2, 5, 8 merged.

**Files:**
- Create: `packages/adapters/migrations/0013_execution.sql`, `packages/domain/src/keeper.ts`, `packages/application/src/faucet.ts`, `packages/application/src/keeper.ts`, `packages/adapters/src/faucet-store.ts`, `packages/adapters/src/keeper-store.ts`, `tests/keeper-decisions.test.ts`, `tests/faucet.test.ts`, `tests/keeper.test.ts`, `tests/anvil/keeper-faucet.test.ts`, `tests/postgres/faucet.test.ts`, `docs/M3_KEEPER_FAUCET.md`
- Modify: `apps/api/src/main.ts` (trading mode registers the faucet), `apps/worker/src/handlers.ts` (`faucet.mint`, `keeper.finalize`, `tx.dispatch`, the periodic keeper schedule every 15 s), exports

**0013_execution.sql:** schema `faucet`: `claims(id UUID PK, deployment_id, agent_id UUID REFERENCES identity.agents, address blink.address NOT NULL, amount_micros blink.uint256 NOT NULL CHECK (amount_micros = 1000000000), intent_id UUID NOT NULL UNIQUE REFERENCES signing.economic_intents, state TEXT NOT NULL CHECK (state IN ('QUEUED','SUBMITTED','SUCCEEDED','FAILED','UNKNOWN')), succeeded_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT blink.now(), updated_at)`; `address_guards(deployment_id TEXT, address blink.address, PRIMARY KEY (deployment_id, address))`. Grants: api INSERT/SELECT claims and guards; worker SELECT/UPDATE(state, succeeded_at, updated_at) claims.

**Rules:**
1. `POST /v1/faucet/claims` (scope `faucet:claim`, idempotent): the agent must have a wallet binding (403 `WALLET_NOT_VERIFIED`); the address must be allowed in `chain.takers` (409 `NO_QUOTE`-style code `FAUCET_NOT_ALLOWED`); `deploymentId` = the configured one (409 `DEPLOYMENT_MISMATCH`). Lock the address guard (insert + `FOR UPDATE`). A claim in QUEUED/SUBMITTED/UNKNOWN → 409 `FAUCET_PENDING`. A SUCCEEDED claim with `succeeded_at > blink.now() − 24 h` → 429 `RATE_LIMITED` with `Retry-After` = seconds until `succeeded_at + 24 h`. Else, in one transaction: MINT intent (faucet role, dedupe `faucet:<claimId>`, payload `{to, amount:"1000000000"}`), sign request (`unsigned_payload {to: token, functionName:"mint", args:[to, amount]}`, `request_hash = keccak256(canonical JSON)`), the claim QUEUED, enqueue job `faucet.mint` `{claimId}` → 202 `{claimId, intentId, state:"QUEUED"}`. A different API key for the same wallet hits the same guard (design case 11).
2. `faucet.mint`: `signer.sign` (faucet caller) → SIGNED → enqueue `tx.dispatch` → claim SUBMITTED. REJECTED → claim FAILED. UNKNOWN → claim UNKNOWN (retry the same sign request; never a new intent). Dispatcher INCLUDED → claim SUCCEEDED with `succeeded_at` = the receipt block timestamp; REVERTED → FAILED.
3. `keeperDecision(market, nowChain: bigint): "FINALIZE_UNCHALLENGED" | "FINALIZE_TIMEOUT" | null` (pure): PROPOSED and `proposedAt + challenge ≤ now < hardDeadline` → UNCHALLENGED; not FINAL and `now ≥ hardDeadline` → TIMEOUT; else null. `nowChain` = the indexer cursor block timestamp.
4. `keeper.finalize` (every 15 s): for each decision, create the intent with dedupe `finalize:<deployment>:<market>:<kind>` (an existing intent, including UNKNOWN, is never duplicated), sign as keeper, and dispatch. Before signing, re-read `getMarket` at the latest block; FINAL → cancel the intent. An UNCHALLENGED intent still pending after `hardDeadline` → mark it FAILED once its receipt reverts, and a TIMEOUT intent is created by the normal decision. Gas estimate failure → audit `keeper.manual_required` (anyone can still call the contract directly).

**Tests:** decision boundaries (at `proposedAt + challenge` exactly → UNCHALLENGED; at `hardDeadline` exactly → TIMEOUT; DISPUTED before the hard deadline → null; FINAL → null); faucet rolling window with the test clock (claim, pending → 409, success at T, then T + 23:59:59 → 429 with the correct Retry-After, T + 24 h → 202); two keys for the same wallet; not allowlisted; idempotent replay; keeper dedupe and no duplicates while UNKNOWN; Anvil: propose → time jump → the keeper finalizes → the indexer sees FINAL; Anvil: a faucet claim mints 1,000 bUSD; real PostgreSQL: 5 concurrent claims for one address → exactly one 202.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`, `pnpm test:anvil`.
- [ ] Write `docs/M3_KEEPER_FAUCET.md`; commit on `ws/t13-keeper-faucet`.

---

### Task 14: Internal trader under a mandate

**Goal:** Spec §9.3 and §12.3: a deterministic internal trader with its own small EOA that buys only when its own probability beats the ask by more than 500 bps (spec §12.3 "exceeds"; strictly greater), within mandate limits, through the restricted signer.

**Depends on:** Tasks 9 and 13 merged.

**Files:**
- Create: `packages/adapters/migrations/0018_trader.sql`, `packages/domain/src/trader-rule.ts`, `packages/application/src/trader.ts`, `packages/adapters/src/trader-store.ts`, `tests/trader-rule.test.ts`, `tests/trader.test.ts`, `tests/anvil/trader.test.ts`, `tests/postgres/trader.test.ts`, `docs/M3_INTERNAL_TRADER.md`
- Modify: `apps/worker/src/handlers.ts`, `apps/worker/src/config.ts` (`WORKER_TRADER_API_KEY`, `WORKER_TRADER_FORECASTER_ROLE`), exports

**0018_trader.sql:** `trading.mandates(agent_id UUID PK REFERENCES identity.agents, wallet blink.address NOT NULL UNIQUE, forecaster_role TEXT NOT NULL CHECK (forecaster_role IN ('FORECASTER_A','FORECASTER_B')), daily_notional_cap_micros blink.uint256 NOT NULL DEFAULT 100000000, open_notional_cap_micros blink.uint256 NOT NULL DEFAULT 500000000, max_fill_shares INTEGER NOT NULL DEFAULT 20, shares_per_trade INTEGER NOT NULL DEFAULT 10, edge_threshold_bps INTEGER NOT NULL DEFAULT 500, enabled BOOLEAN NOT NULL DEFAULT true, policy_version TEXT NOT NULL)`; `trading.risk_reservations(id UUID PK, agent_id, intent_id UUID UNIQUE, day DATE NOT NULL, notional_micros blink.uint256 NOT NULL, state TEXT CHECK IN ('HELD','ACCOUNTED','RELEASED'), created_at, updated_at)`. Grants to worker.

**Rules:**
1. `traderDecision({ownProbabilityMillionths, askYesBps, askNoBps, thresholdBps}): {side: "YES" | "NO"} | null`: YES if `ownP·10000/1e6 − askYes > threshold` (compare in integers: `ownP − askYes·100 > threshold·100`); NO if `(1e6 − ownP) − askNo·100 > threshold·100`; otherwise null. When both qualify, pick the larger edge (YES on a tie).
2. `trader.evaluate` (after each window closes and every 5 min): stop if the market is not OPEN, close is reached, a quote gate is open, the snapshot is missing/stale, or the indexer is not fresh. `ownProbability` = the mandate's linked forecaster submission in the snapshot's window; the asks come from `askPriceBps` on the snapshot. On a decision: lock the mandate; `notional = shares·1e6`; `daily(HELD+ACCOUNTED) + notional ≤ dailyCap`, `open(HELD) + notional ≤ openCap`, `shares ≤ max_fill_shares`, else skip with an audit row. Reserve risk HELD → RFQ through the API with the trader key → verify the envelope (same checks as the client SDK; implement locally if Task 15 is not merged) → APPROVE intent (exact taker cost) → dispatch until INCLUDED → FILL intent → dispatch. Pending transactions count as occupied; RELEASED only on a definitive failure (REVERTED, or expiry by block time without fill). After the market is FINAL with a position, create a REDEEM intent.
3. LLM output never reaches calldata; the trader uses only numbers from DB/API.

**Tests:** decision vectors (edge exactly at the threshold → null; 1 bps above → buy); mandate caps; stop conditions; real PostgreSQL: two concurrent evaluations cannot exceed the daily cap; Anvil: approve exact → fill → redeem through the signer.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build:services && pnpm test:service-build`, `pnpm test:anvil`.
- [ ] Write `docs/M3_INTERNAL_TRADER.md`; commit on `ws/t14-trader`.

---

### Task 15: Client SDK and external agent example

**Goal:** Spec §17.3 "external client example" and §14.3: a typed client for every enabled endpoint with mandatory quote verification, and an example agent that runs the external flow on the local stack.

**Depends on:** Tasks 6, 7, 9, 13 merged.

**Files:**
- Create: `packages/client/src/verify-quote.ts`, `examples/agent/run.ts`, `examples/agent/README.md`, `tests/client-verify-quote.test.ts`, `tests/client.test.ts`, `docs/M5_CLIENT_SDK.md`
- Modify: `packages/client/src/index.ts`, `packages/client/package.json` (add the `viem` dependency if absent), `apps/web/content/docs/client.md` (SDK method names; respect `tests/web-docs-content.test.ts` rules: no `pnpm`/`curl`/`git clone`/loopback hosts)

**Rules:**
1. Methods: `getConfig, listMarkets, getMarket, getMarketSpec (verifies keccak256(bytes) = specHash), getEvidence, listForecastWindows, submitForecast, listForecasts, requestQuote, getQuote, trackTransaction, getTransaction, getPositions, submitResolutionReport, getResolution, claimFaucet, getMetrics`, plus the existing identity helpers. POSTs generate an Idempotency-Key with `crypto.randomUUID()` unless one is passed; retries reuse the same key.
2. `verifySignedQuote(envelope, ctx: {config: ConfigResponse (deployment non-null), wallet: Address, request: RfqRequest, nowSeconds: bigint}): void` throws `QuoteVerificationError(code)` on the first failure: `DEPLOYMENT_MISMATCH`, `DOMAIN_MISMATCH` (name/version/chain/verifyingContract), `MAKER_MISMATCH`, `SIGNATURE_INVALID` (recover ≠ maker), `DIGEST_MISMATCH` (`hashTypedData` ≠ quoteId), `TAKER_MISMATCH`, `TERMS_MISMATCH` (market/side/quantity), `COST_MISMATCH` (recompute taker/maker cost), `MAX_COST_EXCEEDED`, `EXPIRED` (`nowSeconds ≥ expiresAt`), `CALLDATA_MISMATCH` (≠ `encodeFunctionData(fillQuote, [message, signature])`).
3. The example (`node --import tsx examples/agent/run.ts`, env `BLINK_API_URL`, `BLINK_API_KEY`, `AGENT_PRIVATE_KEY` (refuses unless `RPC_URL` is loopback), `RPC_URL`): bind the wallet → list markets → submit a forecast in an open window → claim the faucet → RFQ → verify → approve the **exact** taker cost → before sending the fill, check `consumed(digest)` → `fillQuote` → `trackTransaction` → poll the transaction and positions → wait for FINAL → redeem. It never retries a fill without the consumed check, and on `QUOTE_EXPIRED` it re-quotes with a new key.

**Tests:** each verification code with a tampered envelope (signed with an Anvil key offline); the client sets and reuses Idempotency-Keys; `getMarketSpec` rejects altered bytes; the example runs in Task 16's harness.

**Steps:**
- [ ] Failing tests → implement → `pnpm check`, `pnpm build` (the client is web-consumed).
- [ ] Write `docs/M5_CLIENT_SDK.md`; commit on `ws/t15-client-sdk`.

---

### Task 16: Local Alpha harness, readiness and restore drill

**Goal:** One command runs the spec §2.1 flow for the three REPLAY scenarios (normal, dispute, timeout) through the real services on Anvil and PostgreSQL. It adds the health/readiness and admin execution metrics needed by spec §17.3, plus a projection rebuild drill. This is the §17.2/§17.3 acceptance evidence in CI.

**Depends on:** all previous tasks merged.

**Files:**
- Create: `scripts/local-alpha.ts`, `tests/alpha/local-alpha.test.ts`, `packages/application/src/health.ts`, `docs/M5_LOCAL_ALPHA.md`, `docs/ACCEPTANCE_MATRIX.md`
- Modify: `apps/api/src/server.ts` and `main.ts` (`GET /v1/health`: public `{status, tradingEnabled, reasons[]}`; with an admin key, `details` = queue stats, the chain index health, signer reachability, budget gates, pool gate), add the `GET /v1/admin/metrics` contract (admin: RFQ latency p50/p95 from `quotes.created_at → signed_at`, tx submit→included p50/p95 from `tx_attempts`, counts by status and error code, gas spent per role/day), `.github/workflows/ci.yml` (run `pnpm alpha:local` in the `check` job with the PostgreSQL service), `package.json` (`"alpha:local"`)

**Rules:**
1. The harness starts Anvil (84532), deploys with Task 4's deployer, creates the DB (`TEST_POSTGRES_ADMIN_URL` → a random database with separate logins per role; refuses to run without it), runs migrations, registers the deployment, starts the API (trading mode), indexer, worker and signer in-process with their own pools and roles, and sets `blink.test_clock_offset_seconds` on all logins (`ALTER ROLE … SET`) in lockstep with Anvil time jumps. `BLINK_ALLOW_TEST_CLOCK=1` is passed only here.
2. Scenario flow: evidence import (CLI) → discovery (fixture model) or a direct candidate → admin approval → the admin wallet sends `createMarket` (test key) → `creation:reconcile` → the indexer → windows → platform forecasts (fixture model) → the window closes → snapshot → `setTakerAllowed` (admin wallet) → the example agent (Task 15) runs faucet, RFQ, verify, approve, fill and tracking → the proposer proposes → [dispute: the challenger challenges, the arbiter arbitrates NO] / [timeout: no proposal, keeper `finalizeTimeout` INVALID] / [normal: keeper `finalizeUnchallenged` YES] → taker and maker redeem → evaluation → metrics.
3. Assertions per scenario: projections equal contract views; no reservation left in HELD/RECONCILE_REQUIRED; payouts match the outcome rule; `GET /v1/metrics?mode=REPLAY` counts the event; no LIVE rows. Afterwards, `chain:rebuild --verify` passes (the restore drill on canonical events), and dropping and re-indexing the chain tables from the deployment block reproduces identical projections.
4. `docs/ACCEPTANCE_MATRIX.md` maps each spec §17.1 C01–C15 and §17.2 S01–S12 case to the test file and command that covers it, and lists what remains manual (§17.3 deployment items).

**Steps:**
- [ ] Implement the harness and readiness, run `pnpm alpha:local` locally (needs `TEST_POSTGRES_ADMIN_URL`; if unavailable, rely on the CI run and say so), plus `pnpm check`, `pnpm build`, `pnpm build:services && pnpm test:service-build`.
- [ ] Write the docs; commit on `ws/t16-local-alpha`.

---

### Task 17: Documentation and roadmap (controller)

**Goal:** Keep the public explanation truthful after the backend lands: `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` status lines, `docs/design/*` "not yet implemented" notes, and the docs-site pages (`apps/web/content/docs/*.md`: the API reference is generated from `apiContracts`; joining/roles/forecaster/trader pages change "as designed" to "implemented, not yet deployed"). The site keeps saying that nothing is deployed and nothing trades on it.

**Steps:**
- [ ] After each merge, the controller updates `docs/ROADMAP.md` (scope, commits, CI run, limits).
- [ ] After Task 16, one docs pass (agent) over ARCHITECTURE/design notes, the web docs, README.md (feature/status summary and doc links) and the site's non-docs pages (home, how-it-works, markets, llms.txt) wherever they describe what exists. Copy only; a visual change needs an approved mockup first.
- [ ] Verify: `pnpm check`, `pnpm build`, `pnpm build:pages && node scripts/check-pages-export.mjs`, `pnpm test:browsers`.

---

## Open Items (deferred; not done by this plan)

1. **Functional web UI** (trading, positions, admin; spec §13): pending the user's decision; the public site stays read-only.
2. **Sepolia Alpha deployment** (spec §17.3): real role wallets, deployer key, RPC primary/backup, hosting, managed PostgreSQL, S3-compatible object storage with versioning/retention, TLS ingress, secret manager, network ACL and mTLS for the signer, signer key at-rest encryption, backups and a real restore drill.
3. **Paid model provider** for the forecasters/baseline/discovery: provider choice, model IDs, rate cards and keys (spec appendix A).
4. **LIVE markets**: first companies, official IR sources, schedule verification, LIVE approval policy (currently rejected).
5. **External acceptance**: a non-team operator onboarding, usability check, feedback channel, 3-minute demo video, public link (spec §17.3, §19).
6. **Shared rate limiter / multi-instance API** before horizontal scaling.
7. **Alert delivery channel** (outbox `alert.*` events exist; no pager/email integration).
8. **Smart-account (ERC-1271) wallets** are out of v0.1 scope (ADR 0002 §7).
9. **Cost metrics per mode**: budgets are platform-wide; split by LIVE/REPLAY if needed.
10. Items already listed in `docs/M4_WEB_SHOWCASE_DELIVERY.md` (site search, real Safari devices, CSP inline styles, etc.).
