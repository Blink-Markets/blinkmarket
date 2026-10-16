# M5 — Alert delivery (A4)

中文摘要：完成告警的至少一次投遞、持續退避重試、安全輸出及不依賴 keeper 的本機期限告警演練。

This completes the A4 delivery slice, not all of M5 or public Alpha readiness. Nothing was deployed, signed, broadcast or provisioned.

The worker now delivers every `alert.*` outbox event through the `AlertSink` port and the `alert.deliver` job. Dispatch inserts the job and marks the outbox event dispatched in one transaction. Dispatched means queued, not delivered: only a successful sink response followed by a fenced queue acknowledgement sets the job to `SUCCEEDED`. Replaying an event preserves the unique `outbox:<event UUID>:alert.deliver` job key. The payload and webhook `Idempotency-Key` use `alert:<event UUID>` for receiver deduplication.

Sink errors retain `QUEUED` delivery jobs, with the existing 5-second exponential backoff capped at 300 seconds. Delivery alone bypasses the normal retry ceiling, including recovery of an expired lease; other job families retain their existing ceiling. Malformed internal jobs can still be dead-lettered as `INVALID_ALERT`. Only the fixed `ALERT_SINK_FAILED` code is persisted for destination failures. URLs and response bodies are never included in errors.

A crash after a destination accepts an alert but before acknowledgement can produce a duplicate. This is at-least-once delivery, not exactly-once delivery; webhook receivers must deduplicate by the key. File and stdout sinks append each accepted attempt. Local write acceptance does not establish remote receipt or disk durability after a machine failure.

## Worker configuration

`WORKER_ENABLED=true` and the existing worker database configuration are required. Select one sink:

| Configuration | Behavior |
| --- | --- |
| `ALERT_SINK=stdout` (default) | One JSON line per delivery on worker stdout |
| `ALERT_SINK=file`, `ALERT_FILE_PATH=<TO BE PROVIDED: local alert file path>` | Append JSON lines; newly created files use mode 0600; parent directory must exist |
| `ALERT_SINK=webhook`, `ALERT_WEBHOOK_URL=<TO BE PROVIDED: alert destination URL>` | JSON POST; success requires HTTP 2xx; 10-second timeout; redirects refused |

Incomplete, conflicting and placeholder configuration is rejected at startup. Webhook URLs come only from configuration; the destination selection remains D9. Embedded URL user credentials are rejected. No provider endpoint or credential is supplied here.

The outbound projection contains only the dedupe key, a constrained alert type, and validated deadline metadata (`marketId`, `deadline`, `thresholdSeconds`, `mode`, `kind`). It excludes arbitrary event fields, aggregate identifiers, evidence, URLs, tokens and raw error messages. File/stdout use the same projection as the webhook. Operators can use the event UUID to correlate a notification with internal outbox diagnostics.

## Independent deadline scheduling and local drill

The existing worker scheduler calls `scheduleResolution` every 15 seconds, deduplicating `resolution.alerts` jobs into 60-second business-clock buckets. Its resolution handler scans deadlines using `blink.now()` and inserts threshold-deduplicated `alert.deadline` events. This path does not invoke or require the keeper. Run a separate worker instance with `SIGNER_URL` and `WORKER_SIGNER_CALLER_TOKEN` unset to keep deadline scheduling and delivery independent of an execution/keeper worker process. That instance needs only its worker database and sink configuration; execution remains disabled. Existing LIVE thresholds remain 86400/3600/600 seconds; REPLAY remains 60/30/10 seconds. Deadline evaluation still requires a functioning worker and indexed market data; this is not an external uptime monitor.

Run `pnpm drill:alerts` with `TEST_POSTGRES_ADMIN_URL` set to a dedicated local PostgreSQL administrator. The separate local harness in `tests/postgres/alerts.test.ts` creates a random database, migrates it, uses the worker role, and removes the database and temporary file afterward. It runs no keeper, signer or chain process. It triggers one REPLAY deadline through the scheduler and injects one outbox fixture each for budget, pause, RPC failure and indexer lag. It delivers all five to a local file sink, checks unique keys, races two dispatchers, then replays the outbox and verifies that no duplicate job is created. `scripts/local-alpha.ts` remains unchanged.

**Producer limitation:** this checkout emits `alert.deadline` but has no `alert.*` producers for budget, pause, RPC failure or indexer lag. A4 supports their delivery and demonstrates it with injected events; it does not claim those incidents automatically emit notifications in production. Existing diagnostic/audit records are not automatically converted to alerts. A follow-up must wire those producers before operational coverage can be claimed.

## Verification

- `node --import tsx --test tests/alerts.test.ts`: five passing tests covering all alert routing (including unknown types), local webhook failure/retry with a stable key, private-field removal, file/stdout output/config validation, and pending delivery beyond the ordinary retry ceiling and after a lease expiry.
- `pnpm drill:alerts`: passing real-PostgreSQL drill under `blink_worker`; no keeper process.
- Full repository checks and build results are recorded below after the final verification run.

No migration was needed. No changes were made to the web app, README, roadmap, previous migrations, or the existing local Alpha scenarios.
