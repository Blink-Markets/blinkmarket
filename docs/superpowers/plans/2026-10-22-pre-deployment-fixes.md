# Pre-deployment Fixes Implementation Plan

_Status: completed — all four tasks merged to `main` on 2026-10-22 (a2e4971, 0c5e5a1, 4dc562a, f05118a, 9a0d530; plan closed in 0a239ad). The `alpha-2` deployment these fixes target is deferred by the 2026-10-23 direction change (docs/ROADMAP.md)._

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four problems that must be fixed before Blink's services run against the live `alpha-2` deployment on Base Sepolia: the `tx.dispatch` retry budget is shorter than Base Sepolia's finality lag; the per-IP limiter sees only the TLS proxy; `operations.jobs` and `operations.outbox` grow without bound and lack indexes for the recovery lookups; and no check stops a deployment from giving the API or the worker the wrong signer roles.

**Status:** Done on 2026-10-22. All four tasks are merged to `main`:

- Task 1: `a2e4971`.
- Task 3: `0c5e5a1`.
- Task 2: `4dc562a`, plus the review fix `f05118a`. The fix makes preflight refuse a trusted-proxy range that is not wholly inside a loopback or private block.
- Task 4: `9a0d530`.

Each task passed its review and CI, which includes `test:postgres` and `alpha:local`. Parked minor findings are listed in Open Item 7.

**Architecture:** Each fix stays inside the layer that owns it.

- Retry budget: a domain constant plus one migration.
- Proxy trust: an API configuration value handed to Fastify.
- Retention: one adapter function run by a new hourly worker job, plus one migration for its indexes and grant.
- Caller tokens: a deploy-preflight check, and a local Alpha harness that uses separate tokens.

**Tech Stack:** TypeScript, pnpm workspaces, Fastify, PostgreSQL (PGlite in `pnpm test`), `node:test`.

**Spec:** No separate spec. The requirements are the parked items in `docs/superpowers/plans/2026-10-15-public-alpha-readiness.md` (Open Items 6 and 9, entry A1) and the measurement below.

**Finality measurement (2026-10-21, public RPC `https://sepolia.base.org`):** the gap between the `latest` and `finalized` block timestamps was sampled every 30 s: 90 samples over about 100 minutes of wall-clock time, with one gap while the laptop slept.

- Lag ranged from 836 s to 1968 s (14 to 33 minutes) in a sawtooth pattern.
- Today's `tx.dispatch` budget is 10 attempts with backoff of 5 s doubling to 300 s, which totals 1215 s (about 20 minutes). That is shorter than most of the lags observed.
- When the budget runs out, the job is dead-lettered and raises a `jobs_dead` alert, even though the transaction is fine. The worker's recovery sweep then re-enqueues it.

## Global Constraints

- Applied migrations are immutable. Add new files only. This plan owns `0023_tx_dispatch_attempts.sql` (Task 1) and `0024_operations_retention.sql` (Task 3).
- `packages/domain` is consumed by the web app. A task that changes it runs `pnpm build` and `node --test tests/service-build.test.mjs` as well as `pnpm check`.
- Every SQL time comparison uses `blink.now()`, never `now()` or `clock_timestamp()`, so test clocks keep working.
- Never read `~/.blink-keys/**`, and never print tokens or keys. Tests use fixture tokens only.
- Match the surrounding code: naming, comment density, and error codes as `UPPER_SNAKE` strings thrown as `new Error(CODE)`.
- Run Prettier on every file you touch: `pnpm exec prettier --write <files>`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Finality stalls past the new budget.** If Sepolia L1 finality stalls for more than about 70 minutes, `tx.dispatch` still goes DEAD and alerts. The sweep must then re-enqueue it with the new attempt budget, not with 10 (Task 1, Step 1c).
2. **Proxy over IPv4-mapped IPv6.** When the proxy connects as `::ffff:127.0.0.1` and the trusted list says `127.0.0.1`, the API must still trust it and key the limiter by the forwarded client address (Task 2 test).
3. **Forged `X-Forwarded-For` from an untrusted client.** The limiter must key such a request by the client's socket address, so the header cannot buy fresh buckets (Task 2 test).
4. **Retention deletes something still needed.** Pruning must never delete:
   - QUEUED or LEASED jobs;
   - undispatched outbox rows;
   - outbox rows a job still references;
   - the newest outbox row per `(aggregate_id, event_type)`, which a restore reads to continue the `chain.synced` version sequence (Task 3 tests).
5. **Over-broad signer roles.** A deployment env must not give the worker the `maker` role or give the API more than `maker`. Preflight must refuse it (Task 4 tests).

**Ruling (dedupe keys after retention):** deleting a finished job frees its `dedupe_key`. Every enqueue site was audited on 2026-10-22, and none can re-enqueue a deleted key in a harmful way:

- `tx.dispatch:<intent>`: enqueued at signing, and by the sweep only for non-final intents. A rerun on a final intent returns immediately.
- `faucet.mint:<claim>`: enqueued at claim time, and by the sweep only for open claims.
- `forecast.run:<window>:<role>`: enqueued only for open windows.
- `trader.evaluate:window:<id>`: enqueued only for windows closed within the last 10 minutes.
- `outbox:<id>:<type>`: dispatched once per outbox row.
- Periodic jobs: their keys carry a time bucket.

The 7-day window is far longer than any of these windows.

---

### Task 1: `tx.dispatch` survives Base Sepolia finality

**Files:**

- Modify: `packages/domain/src/jobs.ts`
- Create: `packages/adapters/migrations/0023_tx_dispatch_attempts.sql`
- Modify: `packages/adapters/src/keeper-store.ts` (two `maxAttempts: 10` for `tx.dispatch`)
- Modify: `packages/adapters/src/faucet-store.ts` (one `tx.dispatch` site)
- Modify: `apps/worker/src/trader.ts` (the `track` enqueue)
- Modify: `apps/worker/src/execution.ts` (the recovery sweep in `tick()`)
- Modify: `docs/M2_SIGNER.md` (line 79) and `docs/M5_SERVICE_IMAGES.md` (the `tx.dispatch` note near line 100)
- Test: `tests/job-queue.test.ts`, `tests/anvil/keeper-faucet.test.ts`

**Interfaces:**

- Produces: `export const TX_DISPATCH_MAX_ATTEMPTS = 20` in `packages/domain/src/jobs.ts`, exported from `@blink/domain` the same way `retryDelayMs` is.

- [ ] **Step 1: Write the failing tests**

  a. In `tests/job-queue.test.ts`:

  ```ts
  test("tx.dispatch backoff outlasts the measured Base Sepolia finality lag", () => {
    assert.equal(TX_DISPATCH_MAX_ATTEMPTS, 20);
    let total = 0;
    for (let a = 1; a < TX_DISPATCH_MAX_ATTEMPTS; a++) total += retryDelayMs(a);
    assert.equal(total, 4_215_000); // about 70 minutes; the measured lag peaked at 1968 s
  });
  ```

  b. In `tests/job-queue.test.ts`, add a migration test:
  - Inserting a job with `maxAttempts: 20` through `enqueueJobInTransaction` succeeds.
  - Inserting with `maxAttempts: 21` rejects with a check violation (`code === "23514"`).

  c. In `tests/anvil/keeper-faucet.test.ts`, extend the test that marks a `tx.dispatch` job DEAD and then calls `execution.tick()` (around line 319):
  - The re-enqueued `tx.dispatch` row has `max_attempts = 20`.
  - Any re-enqueued `faucet.mint` row keeps `max_attempts = 10`.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `node --import tsx --test tests/job-queue.test.ts`
  Expected: FAIL, because `TX_DISPATCH_MAX_ATTEMPTS` is not exported and `max_attempts 20` violates the check.

- [ ] **Step 3: Implement the fix**
  - Add the constant. Its comment states the budget (attempts 1–19 back off 5 s doubling to a 300 s cap, totalling 4215 s) and the 2026-10-21 measurement (836–1968 s).
  - Migration `0023`:
    ```sql
    ALTER TABLE operations.jobs DROP CONSTRAINT jobs_max_attempts_check,
      ADD CONSTRAINT jobs_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 20);
    ```
    Confirm the existing constraint name in PGlite before writing the file.
  - Replace `maxAttempts: 10` with `TX_DISPATCH_MAX_ATTEMPTS` at the four `tx.dispatch` enqueue sites.
  - In the sweep, pass `TX_DISPATCH_MAX_ATTEMPTS` for `tx.dispatch` rows and keep `10` for `faucet.mint` rows.

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `node --import tsx --test tests/job-queue.test.ts`, `pnpm test:anvil`, `pnpm check`, `pnpm build`, `node --test tests/service-build.test.mjs`
  Expected: all pass.

- [ ] **Step 5: Update the two docs**
  - `docs/M2_SIGNER.md`: say `tx.dispatch` jobs get 20 attempts (about 70 minutes) because Base Sepolia's finalized head trailed by 14–33 minutes on 2026-10-21.
  - `docs/M5_SERVICE_IMAGES.md`: mark its "must be checked before deployment" note as resolved by this change.

- [ ] **Step 6: Commit** with message `fix(worker): give tx.dispatch 20 attempts so Base Sepolia finality does not dead-letter it`

---

### Task 2: The per-IP limiter sees the client behind the TLS proxy

**Files:**

- Modify: `packages/runtime/src/index.ts` (`createService`)
- Modify: `apps/api/src/config.ts`, `apps/api/src/server.ts` (`buildApi` options), `apps/api/src/main.ts`
- Modify: `scripts/deploy-preflight.ts`, `deployments/base-sepolia/env.example`, `docs/DEPLOYMENT_RUNBOOK.md`
- Test: `tests/api-config.test.ts`, create `tests/api-trusted-proxy.test.ts`, `tests/deploy-preflight.test.ts`

**Interfaces:**

- Produces:
  - `createService(name, stage?, ready?, options: { trustProxy?: readonly string[] } = {})`. An empty or missing list means `trustProxy: false`.
  - `buildApi({ ..., trustedProxies?: readonly string[] })`.
  - `apiConfig(env).trustedProxies: string[]`.
  - `export function parseTrustedProxies(raw: string | undefined): string[]` in `apps/api/src/config.ts`.

- [ ] **Step 1: Write the failing tests**

  a. In `tests/api-config.test.ts`, test `parseTrustedProxies`:
  - `undefined` and `""` give `[]`.
  - `" 127.0.0.1, ::1,10.0.0.0/8 "` gives `["127.0.0.1","::1","10.0.0.0/8"]`.
  - Each of `"true"`, `"*"`, `"0.0.0.0/0"`, `"::/0"`, `"10.0.0.0/33"`, `"fe80::/129"`, `"proxy.internal"` and `"127.0.0.1,,::1"` throws `INVALID_API_TRUSTED_PROXIES`.

  b. In `tests/api-trusted-proxy.test.ts`, build the API with `buildApi({ publicReadLimit: { capacity: 1, refillPerSecond: 1, now: () => 0 }, trustedProxies })` and send `GET /health/ready` through `app.inject({ remoteAddress, headers: { "x-forwarded-for": ... } })`. Only the 429 status matters: the route answers 503 when it is not rate-limited.
  - Trusted proxy `["127.0.0.1"]`, remote `127.0.0.1`:
    - forwarded `198.51.100.1`, then `198.51.100.1` again: not 429, then 429;
    - forwarded `198.51.100.2`: not 429.
  - Same, but remote `::ffff:127.0.0.1`: the forwarded address is still used.
  - No trusted proxies, remote `127.0.0.1`: forwarded `198.51.100.1`, then forwarded `198.51.100.2`: the second request is 429.
  - Trusted `["127.0.0.1"]`, remote `203.0.113.9` (untrusted): forwarded `198.51.100.3`, then forwarded `198.51.100.4`: the second request is 429.

  c. In `tests/deploy-preflight.test.ts`, check `API_TRUSTED_PROXIES`:
  - Missing or empty: fails with `PREFLIGHT_API_TRUSTED_PROXIES`.
  - `203.0.113.9`: fails, because a public address cannot be the private proxy.
  - `127.0.0.1,::1`: passes.
  - `10.0.0.0/8`: passes.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `node --import tsx --test tests/api-config.test.ts tests/api-trusted-proxy.test.ts tests/deploy-preflight.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement the change**
  - **`parseTrustedProxies`:** split on commas and trim each entry. Each entry is either an address that passes `isIP`, or `address/prefix` where the prefix is an integer from 1 to 32 for IPv4 or 1 to 128 for IPv6. Anything else throws.
  - **`createService`:** forward the list to `Fastify({ trustProxy })`.
  - **`main.ts`:** pass `config.trustedProxies` to `buildApi` in both branches.
  - **Preflight:** the variable is required. Each entry's address part must pass the file's existing loopback-or-private helpers.
  - **`env.example`:** after `API_PORT`, add `API_TRUSTED_PROXIES=<TO BE PROVIDED: the TLS proxy's address as the API sees it, e.g. 127.0.0.1>`.
  - **Runbook:** add the variable to the API row of the env table. In the API start step, add one check: after starting behind the proxy, request through it and confirm that the API log's `remoteAddress` is the client's address, not the proxy's.

- [ ] **Step 4: Run the tests and confirm they pass**

  Run the same three files, then `pnpm check`.
  Expected: PASS.

- [ ] **Step 5: Commit** with message `fix(api): trust only the configured TLS proxy so the per-IP limiter keys real clients`

---

### Task 3: Retention for jobs and outbox, and indexes for the recovery lookups

**Files:**

- Create: `packages/adapters/migrations/0024_operations_retention.sql`
- Create: `packages/adapters/src/operations-retention.ts` (export it from `packages/adapters/src/index.ts`)
- Modify:
  - `packages/domain/src/index.ts` (add `"operations.prune"` to `JobType`)
  - `apps/worker/src/registry.ts`
  - `apps/worker/src/handlers.ts`
  - `apps/worker/src/main.ts`
  - `docs/DEPLOYMENT_RUNBOOK.md`
- Test: create `tests/operations-retention.test.ts`; update `tests/job-registry.test.ts`

**Interfaces:**

- Produces:
  - `export async function pruneOperations(pool: Pool, options?: { batch?: number; maxBatches?: number }): Promise<{ jobs: number; outbox: number }>`. Defaults are `batch` 1000 and `maxBatches` 20, applied per table per call.
  - `export function registerOperationsPrune(pool: Pool): void` and `export async function scheduleOperationsPrune(pool: Pool): Promise<void>` in `apps/worker/src/handlers.ts`, with the same shape as `registerEvaluationHandler` and `scheduleEvaluation`. The job runs hourly (`3_600_000` ms).

- [ ] **Step 1: Write the failing tests** in `tests/operations-retention.test.ts`

  Use `migratedPglite()` and run the prune as `blink_worker` (`SET ROLE`, as in `tests/database.test.ts`).

  a. `"prune deletes succeeded jobs after 7 days and dead jobs after 30, never active ones"`:
  - Deleted: SUCCEEDED finished 8 days ago; DEAD finished 31 days ago.
  - Kept: SUCCEEDED finished 6 days ago; DEAD finished 29 days ago; QUEUED created 60 days ago; LEASED created 60 days ago.
  - The return value has `jobs === 2`.

  b. `"prune keeps undispatched outbox rows, rows a job references, and the newest event per aggregate and type"`:
  - Deleted: version 1 of `(agg-a, chain.synced)`, dispatched 31 days ago, when version 2 exists.
  - Kept:
    - version 2 of the same aggregate, dispatched 31 days ago;
    - a row dispatched 31 days ago that a remaining job still references through `outbox_id`;
    - an undispatched row created 60 days ago;
    - a row dispatched 29 days ago.
  - The return value has `outbox === 1`.

  c. `"prune works in bounded batches"`: with 5 eligible SUCCEEDED jobs, `{ batch: 2, maxBatches: 2 }` deletes 4 and returns `jobs === 4`.

  d. `"the worker's recovery lookups can use the active-job indexes"`:
  - Run `SET enable_seqscan = off`.
  - `EXPLAIN` the two `NOT EXISTS` subqueries from `apps/worker/src/execution.ts`, with a literal UUID in place of the outer column.
  - The plans name `jobs_active_intent` and `jobs_active_claim`.

  e. In `tests/job-registry.test.ts`, append `"operations.prune"` to `expected`.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `node --import tsx --test tests/operations-retention.test.ts tests/job-registry.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Write migration `0024`**

  ```sql
  CREATE INDEX jobs_finished ON operations.jobs (finished_at) WHERE state IN ('SUCCEEDED','DEAD');
  CREATE INDEX jobs_outbox ON operations.jobs (outbox_id) WHERE outbox_id IS NOT NULL;
  CREATE INDEX outbox_dispatched ON operations.outbox (dispatched_at) WHERE dispatched_at IS NOT NULL;
  CREATE INDEX jobs_active_intent ON operations.jobs ((payload->>'intentId')) WHERE type='tx.dispatch' AND state IN ('QUEUED','LEASED');
  CREATE INDEX jobs_active_claim ON operations.jobs ((payload->>'claimId')) WHERE type='faucet.mint' AND state IN ('QUEUED','LEASED');
  GRANT DELETE ON operations.jobs, operations.outbox TO blink_worker;
  ```

- [ ] **Step 4: Implement `pruneOperations`**
  - Delete jobs first, then outbox rows.
  - Each batch is `DELETE … WHERE id IN (SELECT id … LIMIT $batch)`.
  - Stop a table early when a batch deletes fewer than `batch` rows.
  - Eligible jobs: `state='SUCCEEDED' AND finished_at < blink.now() - interval '7 days'`, or `state='DEAD' AND finished_at < blink.now() - interval '30 days'`.
  - Eligible outbox rows meet all three conditions:
    - `dispatched_at < blink.now() - interval '30 days'`;
    - no job has `outbox_id = o.id`;
    - a newer row exists with the same `aggregate_id` and `event_type` and a higher `event_version`.

- [ ] **Step 5: Wire the worker job**
  - Add `"operations.prune"` to `JobType` and to `jobs` in `registry.ts`.
  - The handler calls `pruneOperations(pool)`.
  - `main.ts` registers the handler next to `registerEvaluationHandler` and adds `scheduleOperationsPrune(database)` to the periodic `Promise.allSettled` list.

- [ ] **Step 6: Document retention in the runbook**

  Add one paragraph to the operations section of `docs/DEPLOYMENT_RUNBOOK.md`. It names the windows: SUCCEEDED jobs 7 days, DEAD jobs 30 days, dispatched outbox rows 30 days, the newest row per aggregate and type kept. It notes that DEAD counts in `ops:status` therefore cover the last 30 days.

- [ ] **Step 7: Run the tests and confirm they pass**

  Run: the two test files, then `pnpm check`, `pnpm test:postgres`, `pnpm build`, `node --test tests/service-build.test.mjs`
  Expected: all pass.

- [ ] **Step 8: Commit** with message `feat(worker): prune finished jobs and old outbox rows hourly; index the recovery lookups`

---

### Task 4: Signer caller tokens are split by service

**Files:**

- Modify: `scripts/deploy-preflight.ts`, `deployments/base-sepolia/env.example`, `docs/DEPLOYMENT_RUNBOOK.md`
- Modify: `scripts/local-alpha.ts` (currently one token with roles `["maker","keeper","faucet"]`)
- Test: `tests/deploy-preflight.test.ts`

**Interfaces:**

- Consumes: the caller list (`name`, `tokenSha256`, `roles`) that `signerConfig(env)` from `apps/signer/src/config.ts` already parses. The preflight already imports it.

- [ ] **Step 1: Write the failing tests** in `tests/deploy-preflight.test.ts`

  Every failure below exits with `PREFLIGHT_SIGNER_CALLERS` and names the variable shown.

  | Case                                                                                                    | Expected                           |
  | ------------------------------------------------------------------------------------------------------- | ---------------------------------- |
  | API caller roles `["maker"]`, worker caller `["keeper","faucet","trader"]`, `WORKER_TRADER_API_KEY` set | pass                               |
  | API caller `["maker","keeper"]`                                                                         | fail, `SIGNER_CALLER_TOKEN`        |
  | Worker caller includes `"maker"`                                                                        | fail, `WORKER_SIGNER_CALLER_TOKEN` |
  | `WORKER_TRADER_API_KEY` set but worker caller lacks `"trader"`                                          | fail, `WORKER_SIGNER_CALLER_TOKEN` |
  | `WORKER_TRADER_API_KEY` empty but worker caller has `"trader"`                                          | fail, `WORKER_SIGNER_CALLER_TOKEN` |
  | `SIGNER_CALLER_TOKEN` hash matches no caller                                                            | fail, `SIGNER_CALLER_TOKEN`        |
  | Both services use the same token                                                                        | fail, `WORKER_SIGNER_CALLER_TOKEN` |

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `node --import tsx --test tests/deploy-preflight.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement the check**
  - Compare the SHA-256 hex of each token with the callers' `tokenSha256`.
  - The API's matching caller must have exactly the roles `["maker"]`.
  - The worker's matching caller must have exactly `keeper` and `faucet`, plus `trader` only when `WORKER_TRADER_API_KEY` is non-empty.
  - The two tokens must differ.
  - The check runs only when `SIGNER_CALLERS` and that service's token are both present in the file.
  - Error messages never print values.
  - Update the `SIGNER_CALLERS` placeholder in `env.example` to say which caller gets which roles. Add the same rule as one sentence in the runbook.

- [ ] **Step 4: Split the local Alpha tokens**

  In `scripts/local-alpha.ts`, replace `TOKEN` with two fixture tokens:
  - an `api` caller with roles `["maker"]`, used by `tradingServices`;
  - a `worker` caller with roles `["keeper","faucet"]`, used by `buildExecution`.

- [ ] **Step 5: Run the tests and confirm they pass**

  Run: `node --import tsx --test tests/deploy-preflight.test.ts`, `pnpm alpha:local` (about 3 minutes), `pnpm check`
  Expected: all pass.

- [ ] **Step 6: Commit** with message `fix(deploy): preflight refuses signer callers that are not split maker-only API / keeper-faucet-trader worker`

---

### Task 5: Close-out (controller)

- [ ] **Step 1: Update the public-alpha plan**

  In `docs/superpowers/plans/2026-10-15-public-alpha-readiness.md`, mark the four items in Open Items 6 and 9 (A1) as done, with commit hashes. Note that the alert webhook format adapter is dropped: the user chose the file sink for now.

- [ ] **Step 2: Check the site docs**

  Grep `apps/web/content/docs` and both READMEs for "finality", "TX_PENDING", "rate limit" and "retention". Update anything that is now wrong. If nothing is, change nothing.

- [ ] **Step 3: Verify, then merge and push**

  Run the full verification: `pnpm check`, `pnpm test:postgres`, `pnpm test:anvil`, `pnpm build`, `node --test tests/service-build.test.mjs`. Then merge, push and report the commit hashes.

## Open Items (not done by this plan)

1. **Unmapped outbox events.** `alert.deadline`, `market.creation_requested` and `market.creation_observed` are still stamped dispatched with no consumer. Task 3's retention now bounds them, but no one consumes them.
   - 2026-10-23: superseded. These events belong to the human approval and resolution flows that the autonomous-market design removes.
2. **Declared job types that are never enqueued:** `candidate.validate`, `market.deploy`, `budget.reconcile`, `chain.reconcile`, `tx.track`. `budget.reconcile` must exist before any paid model gateway.
   - 2026-10-23: `candidate.validate`, `market.deploy` and `budget.reconcile` are superseded (platform discovery, admin deployment and platform model spend go away). `chain.reconcile` and `tx.track` are still relevant to the indexer.
3. **Runtime-role refusal message.** It should say what to fix (`packages/adapters/src/runtime-role.ts`).
   - 2026-10-23: still relevant. The check covers every service login, not only the signer.
4. **Alerts.** No startup check that the alert sink is reachable. No chat-webhook format adapter: dropped while `ALERT_SINK=file` is used.
   - 2026-10-23: still relevant (infrastructure alerts stay with the platform).
5. **Pending finality stays visible.** A finality stall longer than about 70 minutes still dead-letters `tx.dispatch` and alerts. That is intended, because it is a real chain condition. The sweep keeps re-enqueueing it.
   - 2026-10-23: superseded. The platform will no longer send transactions, so `tx.dispatch` goes away with the signer.
6. **Shared limiter.** A shared rate limiter is still needed before running more than one API instance (Open Item 3 of the public-alpha plan).
   - 2026-10-23: still relevant.
7. **Parked minor findings from the task reviews:**
   - 2026-10-23: Task 1 (`tx.dispatch`, `faucet.mint`) and Task 4 (signer caller tokens) are superseded; Task 2 (trusted proxy) and Task 3 (retention) are still relevant.
   - **Task 1:**
     - The anvil test's `faucet.mint` assertion checks rows created at claim time, not the rows the sweep re-enqueues.
     - No red run was captured.
     - The two docs were not reformatted by Prettier, deliberately, because it would reflow unrelated tables.
   - **Task 3:**
     - No test covers the early stop on a short batch, outbox batching, or the register and schedule wiring.
     - The prune `LIMIT` has no `ORDER BY`, which is harmless.
     - Prettier reflowed `apps/worker/src/registry.ts`.
   - **Task 2:**
     - `isPrivateHost` rejects IPv4-mapped and link-local proxy addresses, which fails closed.
     - Prettier reflowed unrelated lines in `apps/api/src/main.ts` and `scripts/deploy-preflight.ts`.
   - **Task 4:** preflight hashes the raw token while the worker trims `WORKER_SIGNER_CALLER_TOKEN`, which fails closed.
