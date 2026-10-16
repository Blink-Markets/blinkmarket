# M5 — Alert delivery (A4) and alert producers (A4b)

中文摘要：完成告警的至少一次投遞、持續退避重試、安全輸出，以及 `alert.evaluate` 對預算、暫停、RPC、indexer 落後、keeper 逾時與 DEAD job 的真實條件產生者（OPEN／STILL_OPEN／CLEARED episode），並以不依賴 keeper 的本機演練驗證。

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

`alert.evaluate` is a periodic worker job (scheduled every 60 seconds by the same 15-second schedule tick as `resolution.alerts`, in the main job loop). It runs in every enabled worker, with or without execution, signer or keeper configuration. It observes the conditions below, keeps one **episode** per `(deployment, family, subject)` in `operations.alert_episodes` (migration `0022`, worker login only, no PUBLIC access), and writes the episode row and its `alert.<family>` outbox row in one transaction under a per-deployment advisory lock, so a transition is emitted exactly once even with several workers. The existing outbox dispatcher and `alert.deliver` path deliver it.

- Inactive to active: `state: "OPEN"`. Active for longer than the re-alert interval (default 60 minutes since the last alert): `"STILL_OPEN"`. Active to inactive: `"CLEARED"`. No tick in between emits anything.
- A failed observation (database error) fails the job and changes nothing; it never reports a recovery. The job uses the normal retry ceiling, and a job that goes DEAD is itself reported by `alert.jobs_dead`.
- Every query is bounded (`LIMIT`, indexed or small tables, the worker's 5 s statement timeout) and the RPC probe has a 5 s timeout.

| Family | Subject | Condition (reused, not rewritten) |
| --- | --- | --- |
| `budget` | `daily` | the health `BUDGET_GATE_CLOSED` SQL (`DAILY_BUDGET_CLOSED_SQL`): gate closed or cap used up; reason is `gate_closed_reason`, or `DAILY_CAP_REACHED` |
| `budget` | `questions` | any `budgets.questions` gate closed (`QUESTION_GATE_CLOSED`, `count`) |
| `budget` | `role:<role>` | `signing.sign_requests` `REJECTED` with `GAS_CAP_EXCEEDED` or `GAS_DAILY_CAP_EXCEEDED` in the last 24 hours (the codes come from `checkGasCaps`; `count`) |
| `pause` | `global`, `market:<id>` | the indexed pause projection, via the A3 operator-status `pause()` (`GLOBAL_PAUSED`, `MARKET_PAUSED`) |
| `pause` | `pool` | a closed maker-pool gate (reason `gate_reason`, e.g. `OVERCOMMITTED`) |
| `indexer_lag` | `indexer` | the health `INDEXER_LAG` freshness SQL (`INDEXER_FRESH_SQL`): reason `LAG_BLOCKS`, `STALE_CURSOR`, the cursor gate, or `CURSOR_MISSING`; `blockNumber`, `headNumber` |
| `rpc` | `rpc` | `eth_chainId` (must be 84532) then `eth_blockNumber`, 5 s timeout, using the worker's `BASE_SEPOLIA_RPC_URL`; opens after 3 consecutive failed probes (`ALERT_RPC_FAILURES`), clears on the first success; reasons `RPC_UNREACHABLE`, `RPC_WRONG_CHAIN`, `RPC_BAD_RESPONSE` |
| `keeper_overdue` | `market:<id>` | a non-FINAL market the keeper is due to finalize (`keeperDueSince`, the single rule behind `keeperDecision`) for more than 600 chain seconds (`ALERT_KEEPER_OVERDUE_SECONDS`); `overdueSeconds`. Separate from `alert.deadline`, which warns before a deadline |
| `jobs_dead` | `jobs` | DEAD job count above 0; `count` and `jobTypes` only |

**Without `BASE_SEPOLIA_RPC_URL` the `rpc` family is not evaluated** (no episode is created or cleared). The variable is read independently of execution, so an RPC-only worker probes it. `BLINK_DEPLOYMENT_ID` selects the deployment; when unset every enabled deployment (at most 10) is evaluated. Other optional settings, all validated at startup with defaults: `ALERT_REALERT_MINUTES` (60), `ALERT_RPC_FAILURES` (3), `ALERT_KEEPER_OVERDUE_SECONDS` (600).

Payload hygiene: the allow-list adds `family` (the six names), `state`, `subject` (`^[a-z_]{1,32}(:[a-z0-9_]{1,78})?$`), `reason` (`^[A-Z0-9_]{1,64}$`), `since` (epoch seconds of the episode's opening) and numeric fields (`blockNumber`, `headNumber`, `count`, `overdueSeconds`, `failures`) plus `jobTypes` (at most 10 job type names). Free text (question keys, errors, URLs, evidence, keys, job payloads) never reaches an alert; database values outside the code format are replaced by a fixed code. The outbox `event_version` is the episode's emission counter (`alert_seq`, an extra column beside the briefed ones) so each alert has a unique identity.

Known limits: the `rpc` and `indexer_lag` observations show only what this worker sees; an RPC outage that does not affect the worker's own endpoint is invisible. `jobs_dead` has no deployment scope (jobs are global) and repeats per evaluated deployment. A burst of many paused markets yields one alert per market. `alert.evaluate` itself is not an external uptime monitor: if every worker is down, nothing fires.

## Local drill

Run `pnpm drill:alerts` with `TEST_POSTGRES_ADMIN_URL` set to a dedicated local PostgreSQL administrator. `tests/postgres/alerts.test.ts` creates a random database through the shared `withDatabase` helper (which waits for sessions to end before `DROP DATABASE ... WITH (FORCE)`, fixing the earlier teardown race), migrates it, and runs everything as a real `blink_worker` login with no keeper, signer or chain process. It creates each real condition: a closed daily budget gate, a gas-cap refusal row, a paused market and global pause, a closed pool gate, a stale cursor, an RPC probe against a closed local port, an overdue market and a DEAD job, plus one REPLAY deadline through the scheduler. It asserts each OPEN reached the file sink (the RPC alert only after three failures), that extra ticks add nothing, that no injected `alert.*` outbox row exists, then restores every condition (including a local JSON-RPC server on the same port) and asserts one CLEARED per episode, and finally that replaying the outbox creates no duplicate delivery. `scripts/local-alpha.ts` remains unchanged.

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

## Not done

- **Explicit production sink:** requiring an explicit `ALERT_SINK` in production, and a startup probe of the destination, are left to the deployment-preflight task.
- Remote receipt and disk durability are not established by the local sinks.
- Producers read the worker's own database and RPC view only (see the known limits above); there is no external uptime monitor.

Migration `0022_alert_episodes.sql` is the only migration. No changes were made to the web app, README, roadmap, previous migrations, or the existing local Alpha scenarios.
