# M2.3b — Continuous creation receipt polling

This opt-in indexer process repeatedly checks creation transactions that M2.3a already validated and pinned. It does not discover transactions, scan block ranges, accept replacement hashes, sign, broadcast, or release an approval slot. The operator continues to register the first hash with `pnpm creation:reconcile <intent-id> <tx-hash>`; once that validated observation commits, migration 0006's durable schedule makes it eligible for polling.

## Scheduling and recovery

`chain.creation_tracking_schedule` is separate from the chain-status projection. Migration `0006_creation_tracking_schedule.sql` backfills rows only for existing projections with a non-null pinned `txHash`. A successful initial reconciliation creates the schedule row in the same transaction as the projection. A failed or unvalidated hash cannot be enrolled.

The indexer claims one due row at a time in `(next_run_at, intent_id)` order with `FOR UPDATE SKIP LOCKED`. Claims are bounded by an expiring lease and a monotonically increasing fencing token. Projection save checks the current lease token and the projection version in the same SQL transaction; completion and failure updates also require the lease owner and token. If a process exits, another process can claim after lease expiry. Disabled deployments and rows without pinned hashes are excluded from selection.

The process is serial and does not overlap its own polling ticks. Defaults are a 1 second idle tick, 15 second retry cadence for ordinary states, and 5 minute rechecks for CONFIRMED and REVERTED receipts. Failures use persisted exponential backoff from 5 seconds to a 5 minute cap. The confirmation cadence still rechecks the receipt and its canonical block anchor for reorgs.

Successful checks refresh the current projection's version, head, confirmations, and `observedAt`. Append-only observations, audit entries, and outbox events are written when the state, tracked hash, receipt block, or market ID changes. This retains inclusion, confirmation-threshold, reorg, and same-hash re-inclusion transitions without growing history on every head-only poll. The API remains a read of the last stored snapshot; it does not call RPC.

If a receipt lookup temporarily fails after an INCLUDED, CONFIRMED, or REVERTED observation, the reader checks the stored block anchor. A still-canonical anchor yields a retryable `CREATION_RECEIPT_INDETERMINATE` error and preserves the last verified projection. A positively orphaned anchor produces REORGED and withdraws the provisional market ID.

## Opt-in runtime

Polling is disabled unless `INDEXER_CREATION_POLLING_ENABLED=true`. When enabled, set `INDEXER_DATABASE_URL` to a dedicated non-owner login with `blink_indexer` membership and `BASE_SEPOLIA_RPC_URL` to the Base Sepolia read endpoint. Apply migrations separately with the migration account before starting the service. Startup fails closed if the runtime role or migration is missing.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `INDEXER_PORT` / `INDEXER_HOST` | `3003` / `127.0.0.1` | HTTP health listener |
| `INDEXER_POLL_INTERVAL_MS` | `1000` | Delay between serial claims |
| `INDEXER_LEASE_MS` | `90000` | Lease duration; must exceed the full reconciliation deadline by 15 seconds |
| `INDEXER_RECONCILIATION_DEADLINE_MS` | `60000` | Hard per-intent deadline; aborts in-flight RPC fetches |
| `INDEXER_RPC_TIMEOUT_MS` | `5000` | Per-RPC fetch deadline, combined with the overall cancellation signal |
| `INDEXER_RETRY_BASE_MS` / `INDEXER_RETRY_MAX_MS` | `5000` / `300000` | Persisted exponential retry bounds |
| `INDEXER_PENDING_POLL_MS` | `15000` | Next check for ordinary states |
| `INDEXER_CONFIRMED_POLL_MS` / `INDEXER_REVERTED_POLL_MS` | `300000` / `300000` | Continued canonicality checks |

SIGINT/SIGTERM stops new claims, cancels the timer, aborts the active reader, and waits for the bounded reconciliation and database work to settle. The default upper bounds are a 60 second whole-reconciliation deadline plus database query/connection timeouts of 5 seconds; the 90 second lease leaves additional margin. The HTTP fetch wrapper composes the per-request timeout with the overall AbortSignal and removes its abort listener and timer after every request. If a reader implementation ignores cancellation, the caller still stops at the deadline; the tracker's post-read abort check and database lease fence prevent a late result from saving a projection. A database transaction already in progress is bounded by its query timeout and rechecks cancellation before commit.

`GET /health/creation-observer` reports this component's process diagnostics and durable tracked/due/leased/failing counts. Readiness uses whether the poller is running and the schedule's authoritative due/failing counts; `lastErrorCode` and `lastSuccessAt` are historical process-local diagnostics, not readiness gates. This lets another worker's recovery be reflected without waiting for this process to claim the same row. A schedule health query failure returns 503. This endpoint reports only creation-observation readiness; the service's global `/health/ready` remains not ready, and this poller does not make trading ready.

## Boundaries

This slice does not implement a global block cursor, event-range scanner, common-ancestor rollback, market-wide projections, replacement/cancel tracking, candidate DEPLOYED state, slot release, L1 finality, RFQ, or Signer integration. A reorg withdraws the projected market ID but does not change approval history or release capacity. No remote transaction is sent by this process.

## Verification

Local verification on 2026-10-09:

- `CI=true pnpm check` passed: TypeScript, all 78 Node tests, package boundaries, and contract compilation.
- `CI=true pnpm build` passed with Turbopack.
- `CI=true pnpm build:services` and `CI=true pnpm test:service-build` passed; both bundle smoke tests passed.
- `CI=true pnpm test:contracts` passed all 24 Foundry tests.
- `CI=true pnpm replay` passed the normal, dispute, and timeout local Anvil receipt/payout scenarios. The sandbox initially denied the loopback listener; the same local-only command passed when run with listener permission.
- Focused poller, receipt-reader, tracker, and cancellation tests passed, including empty claims preserving failures, readiness following durable schedule health, timeout plus parent cancellation, and late-reader save fencing.

The real PostgreSQL multi-session test remains pending: `TEST_POSTGRES_ADMIN_URL` is unset and the Docker daemon is unavailable here. CI must run `pnpm test:postgres` against its dedicated PostgreSQL service to verify the migration, two-pool lease competition, stale fencing, and durable schedule behavior. No remote CI result is claimed. This verification covers M2.3b only and does not mark M2 complete.

On 2026-10-10, corrected the PostgreSQL fixture so the projection used by the untracked-row assertion has a null `txHash`, matching the schedule claim filter. It stays hashless through the two-worker lease race, reclaim, and failure checks, then its valid payload is restored immediately before the intentional fairness claim. `CI=true pnpm check` passed (typecheck, 86 Node tests, boundary check, and contract compilation). The focused real PostgreSQL test could not run because `TEST_POSTGRES_ADMIN_URL` is unset and the Docker daemon is unavailable; the database-backed claim/fairness assertions therefore remain pending in CI.
