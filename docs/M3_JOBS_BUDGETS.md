# M3 — Jobs, outbox dispatch, budgets and the model gateway

> Partly historical: the durable job runtime and the outbox still exist, but the USD budget ledger, the model gateway and every handler named here were removed in P2 Tasks 1 and 2. The worker registry now holds `forecast.schedule`, `evaluation.score`, `alert.deliver`, `alert.evaluate` and `operations.prune`. See [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md).

This slice adds the durable job runtime and the USD research budget ledger that the later worker tasks (discovery, forecasters, keeper, faucet) depend on. It registers **no job handler and no outbox mapping yet**, ships **no real model provider**, and spends nothing: the only gateway is a deterministic fixture.

## What exists

| Piece | Where |
| --- | --- |
| Migration | `packages/adapters/migrations/0008_jobs_budgets.sql` |
| Ports | `packages/ports/src/jobs.ts` (`JobQueue`, `JobSpec`, `LeasedJob`, `JobHandler`), `packages/ports/src/budgets.ts` (`BudgetLedger`, `ModelGateway`) |
| Domain | `packages/domain/src/jobs.ts` (`JobError`, `retryDelayMs`), `packages/domain/src/costs.ts` (`ModelRate`, `maxCostUsdMicros`, `usageCostUsdMicros`, `ModelCallError`) |
| Adapters | `job-queue.ts`, `outbox-dispatcher.ts`, `budget-ledger.ts`, `fixture-model-gateway.ts` |
| Application | `worker-runtime.ts` (`startWorker`, `schedulePeriodic`), `budgeted-model.ts` (`createBudgetedModelCaller`) |
| Worker app | `apps/worker/src/{config,handlers,main}.ts` |

The draft `JobQueue` and `ModelGateway` interfaces in `packages/ports/src/index.ts` were replaced by these. Nothing else used them.

## Jobs

`operations.jobs` (migration 0001) gains `max_attempts` (1 to 10, default 3), `created_at` and `finished_at`. `blink_api` and `blink_indexer` may now `INSERT` jobs so a business transaction enqueues atomically with its own writes (`enqueueJobInTransaction(client, spec)`); only `blink_worker` leases and updates them.

- **Lease.** One due job per call, `ORDER BY next_run_at, id FOR UPDATE SKIP LOCKED`: either `QUEUED` and due, or `LEASED` with an expired lease. It sets `attempt + 1`, `lease_token + 1`, the owner and `lease_until`.
- **Fencing.** `heartbeat`, `complete` and `fail` match job, owner **and** token and require an unexpired lease; otherwise they return `false` / `"STALE"`. A worker that lost its lease cannot acknowledge anything.
- **Failure.** Retryable and `attempt < max_attempts` requeues with `retryDelayMs(attempt)` (5 s doubling, capped at 5 min). Anything else is `DEAD` with `finished_at` and an `operations.audit_log` row (`actor=worker`, `action=job.dead`, `resource=<jobId>`, `reason=<code>`), written in the same statement.
- **Crash loops.** A job whose lease expires after its last attempt is dead-lettered at the next `lease` call (`last_error_code=LEASE_EXPIRED`, same audit row) instead of being leased forever. This goes beyond the brief; without it a job that kills its worker every time would never reach the dead-letter state.
- **Worker loop.** `startWorker` runs one job at a time. It heartbeats every `heartbeatMs` (default 20 s, lease 60 s). A heartbeat that returns `false` or throws aborts the handler's `signal` and nothing is acknowledged; the job is re-leased after expiry. When the handler finishes while a heartbeat is still in flight, the runtime waits for that heartbeat before acknowledging, so a failed heartbeat is never ignored. A `JobError` becomes `fail(code, retryable)`; any other error becomes `fail("INTERNAL_ERROR", true)`. `stop()` stops claiming and lets the current job finish; aborting `options.signal` also cancels the running handler. With an empty handler map it never polls.
- **Periodic work.** `schedulePeriodic` enqueues one job per `everyMs` bucket through the dedupe key `type:payload:bucket`.

## Outbox dispatch

`dispatchOutbox(pool, mapping, batch = 100)` locks undispatched rows (`created_at, id`, `FOR UPDATE SKIP LOCKED`), inserts the mapped jobs with dedupe key `outbox:<outboxId>:<jobType>` (and `outbox_id` set), and sets `dispatched_at`, all in one transaction. Unmapped event types are marked dispatched with no jobs. It returns the number of events dispatched. If a mapping throws, the whole batch rolls back and nothing is marked.

## Budget ledger

All amounts are USD micros (1 USD = 1,000,000). The `budgets` schema holds `daily` (cap at most 20,000,000), `questions` (cap 1 to 2,000,000, fixed by the first reservation), `reservations` (states `RESERVED`, `UNKNOWN`, `RECONCILED`, `RELEASED`) and the append-only `cost_entries` (kinds `RESERVE`, `UNKNOWN`, `RECONCILE`, `RELEASE`, `OVERRUN`). `blink_worker` reads and writes; `blink_api` can only read.

- **Day.** `(blink.now() AT TIME ZONE 'UTC')::date`; the day row is created with the default cap on first use. A reservation never moves to another day, so an unsettled one keeps counting on its own day after midnight, while the question total keeps accumulating across days.
- **Reserve.** In one transaction: lock the daily row, then the question row, compute `used = Σ actual(RECONCILED) + Σ max(RESERVED|UNKNOWN)` for the day and for the question, and admit only if no gate is closed and `used + max <= cap` for both (`BUDGET_GATE_CLOSED` / `BUDGET_EXHAUSTED`, both non-retryable). A rejected call leaves nothing behind. A repeated `runId` fails with `RUN_ID_REUSED`.
- **Unknown cost.** `markUnknown` keeps the full maximum occupied. A late `reconcile` can still settle it.
- **Overrun.** `reconcile` with `actual > max` records the full actual, appends an `OVERRUN` entry for the excess, and closes the gates of the reservation's day and question (`gate_closed_reason = 'OVERRUN'`). It takes the same locks in the same order as `reserve`.
- **Release** is only legal from `RESERVED`, i.e. for requests that were definitely not sent. A released reservation counts for nothing: day and question capacity come back. Admission and all summaries read the same buckets (`RECONCILED` actual, `RESERVED`/`UNKNOWN` maximum). Other illegal transitions fail with `RESERVATION_STATE_INVALID`.

## Budgeted model calls

`createBudgetedModelCaller({ ledger, gateway }).call(...)`:

1. No rate for the model: `JobError("MODEL_RATE_UNKNOWN", false)`, no reservation.
2. Reserve `maxCostUsdMicros` (every component rounded up; input tokens are bounded by UTF-8 bytes of `system + input`, output by `maxOutputTokens`, plus the per-request fee).
3. Call the gateway. Success reconciles with the reported cost, or with the maximum when the provider reports none. `NOT_SENT` releases. `UNKNOWN` marks unknown. `FAILED_WITH_USAGE` reconciles the reported usage. Provider errors surface as `JobError("MODEL_CALL_FAILED", kind !== "UNKNOWN")`.
4. Anything the gateway throws that is not a `ModelCallError`, and `FAILED_WITH_USAGE` without usable usage, is treated as `UNKNOWN`: never as free.

It never retries. A retry is a new `runId` and a new reservation, and an `UNKNOWN` earlier attempt keeps its own.

The fixture gateway treats one UTF-8 byte as one token, like the reservation: it cuts the response to `maxOutputTokens` bytes (never inside a character) and reports the usage cost of exactly the bytes it returns, so the cost never exceeds the reserved maximum. `providerRequestId` is `fixture-<runId>`.

## Worker app

Disabled by default: it serves `/health/live` and `/jobs` only, and `/health/ready` stays 503. With `WORKER_ENABLED=true` it requires `WORKER_DATABASE_URL`, a non-owner login in `blink_worker`; startup refuses superuser, role-creating, other runtime roles or schema `CREATE` rights (`UNSAFE_WORKER_DATABASE_ROLE`) and a database without migration 0008 (`JOBS_BUDGETS_MIGRATION_REQUIRED`). It then runs `startWorker` with the (currently empty) map in `handlers.ts`, dispatches the outbox every second with the (currently empty) mapping, serves `GET /health/jobs` (`queued`, `leased`, `dead`), and `/health/ready` returns 200 only while the job loop is running. `createService` in `@blink/runtime` gained an optional readiness callback for this; its default is unchanged.

## Notes for the next tasks

- Business time uses `blink.now()`. Migration 0008 begins with a temporary copy of its definition from migration 0007 (Task 1); the controller removes it at merge. `blink.test_clock_offset_seconds` shifts it in tests.
- `packages/adapters` may import only schemas and ports, so `JobError`, `retryDelayMs`, `ModelCallError` and `usageCostUsdMicros` are re-exported from `@blink/ports`. `ModelCallError` is defined in the domain and re-exported from `@blink/application/budgeted-model` as the brief names it.
- Register handlers in `apps/worker/src/handlers.ts` and outbox mappings in the same file. Handlers must honor `context.signal`; the runtime waits for a handler and does not kill it.
- `tests/helpers/serial-pglite-pool.ts` is the PGlite pool shim for these tests (single session, so not a lock test).

## Verification

Run on 2026-10-14 against PGlite and a local PostgreSQL (`TEST_POSTGRES_ADMIN_URL`).

| Command | Result |
| --- | --- |
| `pnpm check` | passed: 152 Node tests, typecheck (including web), boundaries, contracts |
| `pnpm build` | passed |
| `pnpm build:services && pnpm test:service-build` | passed: 3 bundle tests, including the worker entry failing closed |
| `node --import tsx --test tests/postgres/jobs-budgets.test.ts` | passed: 7 tests on real PostgreSQL, repeated without a failure |
| `pnpm test:postgres` (existing identity test) | passed |

The real-PostgreSQL tests race eight independent sessions for a day cap that admits five (exactly five succeed), eight for a question cap that admits four, eight spread over two business days (so only the question lock serializes them) for one question cap, twelve for the default cap on a day with no row yet, two workers leasing 30 jobs (no duplicate), and concurrent outbox dispatchers. Removing the row locks or `SKIP LOCKED` makes them fail, and removing only the question lock fails the two-day race. The worker bundle was also run once against a real database: a privileged login was refused, the proper login became ready, `/health/jobs` and the outbox loop worked, and SIGTERM exited cleanly.

## Remaining limits

- No job handler, outbox mapping, scheduled job or real model provider exists yet; those belong to the worker tasks. There is no `budget.reconcile` job that settles `UNKNOWN` reservations from provider data.
- A closed gate stays closed until an operator updates the row directly; there is no admin API or alert for it yet.
- If settling a reservation fails after a successful provider call, the reservation stays `RESERVED` at its maximum (counted, never free) and the output is lost with the failed job.
- A throwing outbox mapping blocks dispatch at that event until the code is fixed.
- `schedulePeriodic` buckets by the calling host's clock, so hosts with skewed clocks can each enqueue near a bucket boundary.
- An overrun closes the gate of the reservation's own day and question, not the current day if they differ.
- `pnpm test:postgres` still runs only the identity test; run `tests/postgres/jobs-budgets.test.ts` directly until the script uses a glob.
