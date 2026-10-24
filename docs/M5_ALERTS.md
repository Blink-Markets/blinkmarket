# M5 — Alert delivery (A4) and alert producers (A4b)

This completes the A4 delivery slice and the A4b producers, not all of M5 or public Alpha readiness. Nothing was deployed, signed, broadcast or provisioned.

The worker now delivers every `alert.*` outbox event through the `AlertSink` port and the `alert.deliver` job. Dispatch inserts the job and marks the outbox event dispatched in one transaction. Dispatched means queued, not delivered: only a successful sink response followed by a fenced queue acknowledgement sets the job to `SUCCEEDED`. Replaying an event preserves the unique `outbox:<event UUID>:alert.deliver` job key. The payload and webhook `Idempotency-Key` use `alert:<event UUID>` for receiver deduplication.

Sink errors retain `QUEUED` delivery jobs, with the existing 5-second exponential backoff capped at 300 seconds. Delivery alone bypasses the normal retry ceiling, including recovery of an expired lease; other job families retain their existing ceiling. Malformed internal jobs can still be dead-lettered as `INVALID_ALERT`. Only the fixed `ALERT_SINK_FAILED` and `ALERT_SINK_REJECTED` codes are persisted for destination failures. URLs and response bodies are never included in errors.

`alert.deliver` runs in its own worker loop (`apps/worker/src/loops.ts`), separate from every other job type, so a slow or blackholed sink cannot hold the slot used by `keeper.finalize`, `tx.dispatch` or `quote.reconcile`. HTTP 4xx other than 408 and 429 is recorded as `ALERT_SINK_REJECTED` (a permanent-looking error such as a wrong path or rotated token); it is still retried and never marked delivered or DEAD. The admin health details (`GET /v1/health` with an admin key) gain `alerts: { stalled, stalledCount, oldestStalledSeconds }`. An alert counts as stalled when its job is still `QUEUED` or `LEASED` 15 minutes after it was created, whether or not an error was ever recorded, so a hung first attempt (or alerts queued behind it) shows as stalled too (age is counted from `created_at`, meaning "not delivered within N minutes", not from the first failure). This is informational only: it is not a readiness reason and never changes `status` or `tradingEnabled`, because an alert outage does not make quotes unsafe. The 15-minute threshold is the reader's default; there is no environment setting for it.

A crash after a destination accepts an alert but before acknowledgement can produce a duplicate. This is at-least-once delivery, not exactly-once delivery; webhook receivers must deduplicate by the key. File and stdout sinks append each accepted attempt. Local write acceptance does not establish remote receipt or disk durability after a machine failure.

## Worker configuration

`WORKER_ENABLED=true` and the existing worker database configuration are required. Select one sink:

| Configuration | Behavior |
| --- | --- |
| `ALERT_SINK=stdout` (default) | One JSON line per delivery on worker stdout |
| `ALERT_SINK=file`, `ALERT_FILE_PATH=<TO BE PROVIDED: local alert file path>` | Append JSON lines; newly created files use mode 0600; parent directory must exist |
| `ALERT_SINK=webhook`, `ALERT_WEBHOOK_URL=<TO BE PROVIDED: alert destination URL>` | JSON POST; success requires HTTP 2xx; 10-second timeout (injectable in code, default unchanged); redirects refused; `https:` required except for loopback hosts |

Incomplete, conflicting and placeholder configuration is rejected at startup. Webhook URLs come only from configuration; the destination selection remains D9. Embedded URL user credentials, fragments and plain `http:` to a non-loopback host are rejected (one shared `isAllowedAlertWebhookUrl`). An unset `ALERT_SINK` still defaults to stdout; requiring an explicit sink in production belongs to the deployment-preflight task, not this one. No provider endpoint or credential is supplied here.

The outbound projection contains only the dedupe key, a constrained alert type, and validated deadline metadata (`deploymentId`, `marketId`, `deadline`, `thresholdSeconds`, `mode`, `kind`). A source payload that is not a JSON object is delivered as the minimal alert with `marker: "PAYLOAD_INVALID"`; it never throws inside dispatch. It excludes arbitrary event fields, aggregate identifiers, evidence, URLs, tokens and raw error messages. File/stdout use the same projection as the webhook. Operators can use the event UUID to correlate a notification with internal outbox diagnostics.

## Independent deadline scheduling and local drill

The existing worker scheduler calls `scheduleResolution` every 15 seconds, deduplicating `resolution.alerts` jobs into 60-second business-clock buckets. Its resolution handler scans deadlines using `blink.now()` and inserts threshold-deduplicated `alert.deadline` events. This path does not invoke or require the keeper. Run a separate worker instance with `SIGNER_URL` and `WORKER_SIGNER_CALLER_TOKEN` unset to keep deadline scheduling and delivery independent of an execution/keeper worker process. That instance needs only its worker database and sink configuration; execution remains disabled. Existing LIVE thresholds remain 86400/3600/600 seconds; REPLAY remains 60/30/10 seconds. Deadline evaluation still requires a functioning worker and indexed market data; this is not an external uptime monitor.

## Alert producers (`alert.evaluate`, A4b)

`alert.evaluate` is a periodic worker job (scheduled every 60 seconds by the same 15-second schedule tick as `resolution.alerts`, in the main job loop). It runs in every enabled worker, with or without execution, signer or keeper configuration. It observes the conditions below, keeps one **episode** per `(scope, family, subject)` in `operations.alert_episodes` (migration `0022`, worker login only, no PUBLIC access), and writes the episode row and its `alert.<family>` outbox row in one transaction under a per-scope advisory lock, so a transition is emitted exactly once even with several workers evaluating at once (tested with four concurrent evaluators). The existing outbox dispatcher and `alert.deliver` path deliver it.

**Scopes.** Conditions with no deployment column are evaluated once per tick under the global scope (`deployment_id = '*'`, no `deploymentId` in the payload): the daily budget gate, closed question gates, DEAD jobs and the RPC probe. Everything else (gas-cap refusals, pause, indexer lag, keeper overdue) is evaluated once per deployment. Without `BLINK_DEPLOYMENT_ID`, every enabled deployment is evaluated (at most 10; further ones are skipped).

**Transitions.**

- Inactive to active: `state: "OPEN"`. Active to inactive: `"CLEARED"`. No tick in between emits anything.
- Active for longer than the re-alert interval (default 60 minutes since the last alert): `"STILL_OPEN"` heartbeat. This applies to the non-monotonic families only.
- A **reason change** inside an open episode is announced as `STILL_OPEN` with the new reason, at most once per 10 minutes per episode (a reason that alternates every minute, such as a flaky RPC, stays quiet; the hourly re-alert and growth re-alerts are not rate limited). A condition that flips between ticks opens and clears an episode per flip: flapping happens at tick (one-minute) granularity. Only `rpc` has hysteresis (3 consecutive failures).
- **Monotonic families** (`jobs_dead`, the `questions` gate) have no hourly heartbeat. They send `STILL_OPEN` immediately when their count grows (with the new count, and for DEAD jobs the new job types), and `CLEARED` when the count returns to 0. The last announced count is stored in `last_count`; a lower count is recorded silently, so the next growth announces again.
- **Unknown is not inactive.** Each family is read in its own transaction with its own 3 s statement timeout. A family whose source is unavailable is *unknown* for that tick: it opens nothing, clears nothing, and leaves the RPC streak as it was. A family is unknown when its query fails or times out (the worker logs `ALERT_EVALUATE_FAMILY_FAILED:<family>`, never a message, URL or SQL), when the chain cursor is missing or gated (`pause` and `keeper_overdue`, whose sources are the indexed projection and the keeper's candidate query), or when the RPC is not configured. The maker pool gate is database state, so it is judged independently of the cursor (a reorg is when it tends to close); only the indexed pause projection (`global`, `market:<id>`) becomes unknown while the cursor is gated. The other families still evaluate, and a failing scope (global or one deployment) does not stop the others: the job finishes every scope and then fails with the first error. Each family reads in one REPEATABLE READ snapshot, so the cursor check and the reads that depend on it agree. `indexer_lag` treats a missing or gated cursor as the condition itself (`CURSOR_MISSING`, the gate reason).
- Per-family bounds are `LIMIT`s, the 3 s timeout, one partial index (`sign_requests_rejected_recent`), and the 5 s RPC probe timeout. The A3 `pause()` projection is not bounded by a `LIMIT` (it aggregates every market of the deployment); its cost is bounded only by the timeout.
- **Subject bound.** `pause` and `keeper_overdue` report at most 100 market subjects per deployment per tick (lowest market ids first). Beyond that, each reported alert carries `truncated: true`, and no episode of that family is cleared on that tick (an episode outside the window cannot be told from a recovered one). The window moves on as markets resolve or unpause.
- **Retention.** The read does not use a row cap: it loads every active episode, the RPC streak row and the episodes of the subjects observed this tick. Inactive episodes whose last alert is older than 30 days are deleted in the same transaction, at most 100 per tick.
- The job uses the normal retry ceiling when the transition itself fails; a job that goes DEAD is itself reported by `alert.jobs_dead`.

| Family | Subject | Condition (reused, not rewritten) |
| --- | --- | --- |
| `budget` | `daily` (global) | the health `BUDGET_GATE_CLOSED` SQL (`DAILY_BUDGET_CLOSED_SQL`, including the day filter): gate closed or cap used up; reason is `gate_closed_reason`, or `DAILY_CAP_REACHED` |
| `budget` | `questions` (global, monotonic) | the health question-gate count (`QUESTION_GATES_CLOSED_SQL`); `QUESTION_GATE_CLOSED`, `count` |
| `budget` | `role:<role>` | `signing.sign_requests` `REJECTED` with `GAS_CAP_EXCEEDED` or `GAS_DAILY_CAP_EXCEEDED` in the last 24 hours (the codes are an exhaustive record keyed by `checkGasCaps`' result type; `count`) |
| `pause` | `global`, `market:<id>` | the indexed pause projection, via the A3 operator-status `pause()`, for markets that are not FINAL (a resolved market stays flagged paused until an admin unpauses it, but it clears its episode); `GLOBAL_PAUSED`, `MARKET_PAUSED` |
| `pause` | `pool` | a closed maker-pool gate (`POOL_GATE_CLOSED_SQL`; reason `gate_reason`, e.g. `OVERCOMMITTED`) |
| `indexer_lag` | `indexer` | the health `INDEXER_LAG` freshness SQL (`INDEXER_FRESH_SQL`, from `INDEXER_MAX_LAG_BLOCKS`): reason `LAG_BLOCKS`, `STALE_CURSOR`, the cursor gate, or `CURSOR_MISSING`; `blockNumber`, `headNumber` |
| `rpc` (global) | `rpc` | `eth_chainId` (must be 84532) then `eth_blockNumber`, 5 s timeout, using the worker's `BASE_SEPOLIA_RPC_URL`; opens after 3 consecutive failed probes (`ALERT_RPC_FAILURES`), clears on the first success; reasons `RPC_UNREACHABLE`, `RPC_WRONG_CHAIN`, `RPC_BAD_RESPONSE`, and `MAINNET_REFUSED` for chain 8453 (a configuration error; it still counts through the 3-probe hysteresis) |
| `keeper_overdue` | `market:<id>` | a non-FINAL market the keeper is due to finalize (`keeperDueSince`, the single rule behind `keeperDecision`, over the keeper's own candidate query) for more than 600 chain seconds (`ALERT_KEEPER_OVERDUE_SECONDS`); `overdueSeconds`. Separate from `alert.deadline`, which warns before a deadline |
| `jobs_dead` (global, monotonic) | `jobs` | jobs that became DEAD in the trailing 24 hours; `count` (all of them) and `jobTypes` (at most 10 types) only |

`jobs_dead` uses `operations.jobs.finished_at`, which the queue sets to `blink.now()` in the same statement that marks a job DEAD (`operations.jobs` has no `updated_at`). A job left DEAD forever therefore stops counting after 24 hours, so the episode ends and the next incident produces a fresh OPEN; the DEAD rows themselves stay for diagnosis (`pnpm ops:status`, admin jobs list). The same reasoning applies to the monotonic question-gate count: a gate that nothing reopens keeps its episode open without heartbeats, and any new closed gate is announced at once.

**Without `BASE_SEPOLIA_RPC_URL` the `rpc` family is not evaluated** (no episode is created or cleared). The variable is read independently of execution, so an RPC-only worker probes it. Other optional settings, all validated at startup with defaults: `ALERT_REALERT_MINUTES` (60), `ALERT_RPC_FAILURES` (3), `ALERT_KEEPER_OVERDUE_SECONDS` (600).

Payload hygiene: the allow-list adds `family` (the six names), `state`, `subject` (`^[a-z_]{1,32}(:[a-z0-9_]{1,78})?$`), `reason` (`^[A-Z0-9_]{1,64}$`), `since` (epoch seconds of the episode's opening), numeric fields (`blockNumber`, `headNumber`, `count`, `overdueSeconds`, `failures`), `jobTypes` (at most 10 job type names) and `truncated` (only ever `true`). Free text (question keys, errors, URLs, evidence, keys, job payloads) never reaches an alert; database values outside the code format are replaced by a fixed code. Each episode has its own outbox identity: the aggregate id is `["alert", scope, family, subject, openedAtMs]` and the `event_version` is the row's emission counter (`alert_seq`, an extra column beside the briefed ones), so a subject that is pruned after 30 quiet days and later reopens can never collide with an older episode's alerts.

Known limits: the `rpc` and `indexer_lag` observations show only what this worker sees; an RPC outage that does not affect the worker's own endpoint is invisible. Observations are taken before the per-scope transaction lock, so two overlapping evaluators could apply an older observation after a newer one. A job-level session advisory lock prevents that: a tick that finds another evaluator running skips itself (logged as `ALERT_EVALUATE_SKIPPED_OVERLAP`, the job still succeeds; the job queue has no result field to record it in). Overlap is possible without any retry, since one tick can take longer than the 60 s bucket (5 s probe plus up to 3 s per family and scope), so the lock is what keeps ticks apart; the lock is released when the holder's connection ends, so a crashed evaluator cannot wedge alerting. Up to 100 paused or overdue markets per deployment are alerted individually. `alert.evaluate` is not an external uptime monitor: if every worker is down, nothing fires.

## Local drill

Run `pnpm drill:alerts` with `TEST_POSTGRES_ADMIN_URL` set to a dedicated local PostgreSQL administrator. `tests/postgres/alerts.test.ts` creates a random database through the shared `withDatabase` helper (which waits for sessions to end before `DROP DATABASE ... WITH (FORCE)`, fixing the earlier teardown race), migrates it, and runs everything on connections that assume the `blink_worker` role (so only the worker's grants apply) with no keeper, signer or chain process. It creates each real condition: a closed daily budget gate, a gas-cap refusal row, a paused market and global pause, a closed pool gate, a stale cursor, an RPC probe against a closed local port, an overdue market and a DEAD job, plus one REPLAY deadline through the scheduler. It asserts each OPEN reached the file sink (the RPC alert only after three failures), that extra ticks add nothing, that no injected `alert.*` outbox row exists, then restores every condition (including a local JSON-RPC server, swapped in as the probe target so no released port is reused) and asserts one CLEARED per episode, and finally that replaying the outbox creates no duplicate delivery. `scripts/local-alpha.ts` remains unchanged.

## Verification

A4 results after fix rounds 1 and 2 (2026-10-17): `tests/alerts.test.ts` 16/16, `pnpm check` 635/635, postgres 54/54, anvil 50/50, drill 1/1.

A4b results (2026-10-17, local PostgreSQL on 127.0.0.1:55414, Anvil chain id 84532):

- `node --import tsx --test tests/alert-evaluate.test.ts`: 17/17 pass (episode transitions with no duplicate OPEN, the re-alert interval, CLEARED, one test per family from its real condition, RPC streak and probe codes, keeper not configured, deployment fallback, transactional episode+outbox, grants, payload allow-list, configuration).
- `tests/alerts.test.ts` gained the never-failed stall case (N1), the worker sink-selection test and the redirect-refusal test (Minor 7); `tests/keeper-decisions.test.ts` proves `keeperDueSince` agrees with `keeperDecision`.
- `pnpm check`: 664/664 tests pass, 0 fail, 0 skipped; typecheck, contracts and package boundaries pass.
- `pnpm build` (schemas are unchanged; run anyway): pass. `pnpm build:services && pnpm test:service-build`: pass, 5/5.
- `pnpm test:anvil`: 50/50 pass.
- `node --import tsx --test --test-concurrency=1 tests/postgres/*.test.ts`: 55/55 pass.
- `pnpm drill:alerts`: 1/1 pass, three consecutive runs; no `blink_t8_*` database or `t8_*` role is left behind.

A4b fix round 1 (2026-10-17): `tests/alert-evaluate.test.ts` 28/28 (new: gated or missing cursor is unknown, more than 1000 episode rows, pruning, DEAD-job window and growth, question-gate growth, reason change, resolved paused market, global scope once, family isolation, subject truncation, lag boundary), `pnpm check` 675/675, `pnpm build` and `build:services` + `test:service-build` 5/5 pass, `pnpm test:anvil` 50/50, postgres suite 56/56, `pnpm drill:alerts` 2/2 on each of 3 runs, and 8 runs of the postgres alert tests in 4-way parallel all pass with no leftover databases or roles. A temporary removal of the advisory lock made the concurrent-evaluator test fail.

A4b fix round 2 (2026-10-17): `tests/alert-evaluate.test.ts` 33/33 (new: prune-and-reopen with a delivered OPEN, scope isolation, alternating RPC reason rate limit, pool gate during a gated cursor, mainnet refusal), the postgres alert tests 3/3 (concurrent evaluators with only the transaction lock, with the job lock, and a held job lock skipping a tick), plus the full commands listed in the report.

## Not done

- **Explicit production sink:** requiring an explicit `ALERT_SINK` in production, and a startup probe of the destination, are left to the deployment-preflight task.
- Remote receipt and disk durability are not established by the local sinks.
- Producers read the worker's own database and RPC view only (see the known limits above); there is no external uptime monitor.

Migration `0022_alert_episodes.sql` is the only migration. No changes were made to the web app, README, roadmap, previous migrations, or the existing local Alpha scenarios.
