# M5 — Alert delivery (A4)

中文摘要：完成告警的至少一次投遞、持續退避重試、安全輸出及不依賴 keeper 的本機期限告警演練。

This completes the A4 delivery slice, not all of M5 or public Alpha readiness. Nothing was deployed, signed, broadcast or provisioned.

The worker now delivers every `alert.*` outbox event through the `AlertSink` port and the `alert.deliver` job. Dispatch inserts the job and marks the outbox event dispatched in one transaction. Dispatched means queued, not delivered: only a successful sink response followed by a fenced queue acknowledgement sets the job to `SUCCEEDED`. Replaying an event preserves the unique `outbox:<event UUID>:alert.deliver` job key. The payload and webhook `Idempotency-Key` use `alert:<event UUID>` for receiver deduplication.

Sink errors retain `QUEUED` delivery jobs, with the existing 5-second exponential backoff capped at 300 seconds. Delivery alone bypasses the normal retry ceiling, including recovery of an expired lease; other job families retain their existing ceiling. Malformed internal jobs can still be dead-lettered as `INVALID_ALERT`. Only the fixed `ALERT_SINK_FAILED` code is persisted for destination failures. URLs and response bodies are never included in errors.

`alert.deliver` runs in its own worker loop (`apps/worker/src/loops.ts`), separate from every other job type, so a slow or blackholed sink cannot hold the slot used by `keeper.finalize`, `tx.dispatch` or `quote.reconcile`. HTTP 4xx other than 408 and 429 is recorded as `ALERT_SINK_REJECTED` (a permanent-looking error such as a wrong path or rotated token); it is still retried and never marked delivered or DEAD. `/health` adds `ALERT_DELIVERY_STALLED` when an alert that has failed at least once is still undelivered after 15 minutes (the API reads `ALERT_STALL_SECONDS` to override). Like every health reason it also turns the readiness answer to `not-ready`.

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

Run `pnpm drill:alerts` with `TEST_POSTGRES_ADMIN_URL` set to a dedicated local PostgreSQL administrator. The separate local harness in `tests/postgres/alerts.test.ts` creates a random database, migrates it, uses the worker role, and removes the database and temporary file afterward. It runs no keeper, signer or chain process. It triggers one REPLAY deadline through the scheduler and injects one outbox fixture each for budget, pause, RPC failure and indexer lag. It delivers all five to a local file sink, checks unique keys, races two dispatchers, then replays the outbox and verifies that no duplicate job is created. `scripts/local-alpha.ts` remains unchanged.

**Producer limitation:** this checkout emits `alert.deadline` but has no `alert.*` producers for budget, pause, RPC failure or indexer lag. A4 supports their delivery and demonstrates it with injected events; it does not claim those incidents automatically emit notifications in production. Existing diagnostic/audit records are not automatically converted to alerts. A follow-up must wire those producers before operational coverage can be claimed.

## Verification

Fix round 1 results (2026-10-17, local PostgreSQL on 127.0.0.1:55414, Anvil chain id 84532):

- `node --import tsx --test tests/alerts.test.ts`: 16/16 pass (routing, retry with stable key, file/stdout/config, retry ceiling, hung-sink isolation, 4xx classification, timeout, abort mid-delivery, URL rules, null payload, explicit mapping, deploymentId, health stall reason).
- `pnpm check`: 635/635 tests pass, 0 fail, 0 skipped; typecheck, contracts and package boundaries pass.
- `pnpm build:services && pnpm test:service-build`: pass, 5/5.
- `node --import tsx --test --test-concurrency=1 tests/postgres/*.test.ts`: 54/54 pass.
- `pnpm drill:alerts`: 1/1 pass (real PostgreSQL under `blink_worker`, no keeper).
- `pnpm test:anvil`: 50/50 pass.

## Not done

- **Producers:** budget, pause, RPC-failure and indexer-lag alerts are still missing. Only `alert.deadline` is produced today. A4 delivers those families when something writes them (the drill injects fixtures) but nothing does yet. A follow-up task adds the producers; until then do not rely on alerts for those incidents and poll `/health`.
- **Explicit production sink:** requiring an explicit `ALERT_SINK` in production, and a startup probe of the destination, are left to the deployment-preflight task.
- Remote receipt and disk durability are not established by the local sinks.

No migration was needed. No changes were made to the web app, README, roadmap, previous migrations, or the existing local Alpha scenarios.
