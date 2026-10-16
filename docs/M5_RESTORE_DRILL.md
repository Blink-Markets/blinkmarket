# M5 backup and restore drill — Task A5 delivery

中文摘要：在本機 Alpha 最後一個市場仍開放、留有一張未成交報價（HELD reservation）時，以 PostgreSQL 17.6 映像的 pg_dump／pg_restore 備份並還原到全新資料庫；驗證投影、結構與備份及合約檢視一致、重放 canonical 事件，並確認在 reservation 對帳器於「新鮮」游標上完成對帳前報價一直關閉（對帳器在游標過時、落後或被關閉時拒絕判斷）。物件封存還原尚未納入（待 D3）。

This is the §17.3 "backup restore succeeds" evidence, runnable locally and in CI. It builds
on the local Alpha harness (`docs/M5_LOCAL_ALPHA.md`) and on `chain:rebuild --verify`. It
deploys nothing, signs nothing and contacts no provider: the source is the harness's own
random database on a local Anvil (chain ID 84532).

## What changed in the application

`createQuoteReconciler.reconcileOnce` now judges nothing while the chain cursor is not fresh.
It uses the RFQ's own rule (`indexerStatus`: a gated cursor, a cursor older than 10 s on the
database clock, or more than three blocks behind the head it last saw). It then leaves the pool
gate and every reservation as they are and returns `skipped: "INDEXER_LAG"` beside the usual
counts (the key is absent when it judged). Before, only a gated cursor stopped it, so the
worker's 5 s `quote.reconcile` pass could clear `OVERCOMMITTED` on a view that trailed the
chain. That was unsafe in normal operation as well as after a restore. Two existing tests were
touched, see "Verification".

## What the drill does

`runLocalAlpha` takes an optional `whileOpen` hook (additive; the scenarios and the harness's
own restore drills are unchanged). In the last scenario, once the taker has bought and the
market is still open, the harness stops its indexer pump and worker, runs the hook, and starts
them again. `scripts/restore-drill.ts` runs from that hook, several times:

1. **Capture.** A quote is requested through the API as the taker and left unfilled, so the
   dump holds a `HELD` reservation (asserted). Then the projection and cursor, a digest of
   every table (row count plus an md5 of the rows; `trading.maker_pools` and `chain.cursors`
   are left out because the restore procedure changes them, the cursor is compared field by
   field), every table and column privilege, and the schema as `pg_dump --schema-only`.
   An empty source (no events, markets or positions) fails the drill.
2. **Dump.** `pg_dump --format=custom --no-owner` from the `postgres:17.6` image
   (`docker run`; the host needs Docker, not a PostgreSQL install; the image is pulled first
   under its own bound). The tool version is recorded in the report.
3. **The chain moves on.** Chain time jumps 300 s (past the quote's 30 s validity), then one
   `setTakerAllowed` event and six blocks, so the dump is behind the head by more than the RFQ
   lag rule tolerates, as a real backup would be.
4. **Restore.** `pg_restore --no-owner --exit-on-error` into a fresh database. Service roles
   are cluster-level and are not in the dump (the drill's logins are new, members of
   `blink_indexer` and `blink_worker`). The restored database's clock runs one hour after the
   dump, as a real restore does, so the restored cursor is stale.
5. **Prepare.** `prepareRestoredDatabase` (`scripts/restore-prepare.ts`, `pnpm restore:prepare
   <deploymentId>` with `RESTORE_ADMIN_DATABASE_URL`) closes the pool's quote gate
   (`OVERCOMMITTED`) and releases the dumped cursor lease. The drill and the runbook run the same
   function. Gate reasons are then judged like the RFQ does: the pool gate, settled reservations
   whose block is not canonical (`RECONCILE_REQUIRED`), and the lag rule against the live head
   (`INDEXER_LAG`).
6. **Replay.** `pnpm chain:rebuild <deployment> --verify` folds the stored canonical events and
   must find no difference with the restored projections.
7. **Compare.** The restored projection, cursor, table digests, privileges and schema must equal
   the pre-dump ones, and the projection must equal the contract's views (maker balance, epoch,
   pause, each market's escrow, pairs, pause and state, positions, takers, consumed digests)
   read at the dump's block. In the schema comparison only the nesting of OR chains on `CHECK` lines (flattened by PostgreSQL on restore) and
   pg_dump's random `\restrict` token are normalized; every other character must match
   after a restore.
8. **Catch up.** The indexer syncs from the chain to the head, which replays the missed event.
   The projection must again equal the contract's views, now at the head.
9. **Reconcile.** Quoting must still be closed. Then the reconciler runs on the fresh cursor,
   must not skip, and must have released or accounted at least one reservation (the unfilled
   quote, expired by block time). A pass that settles nothing fails the drill
   (`RESTORE_RECONCILE_SETTLED_NOTHING`). Quoting must be open afterwards with no open
   reservation.

Every created database and login is dropped when the drill ends, also when it fails or the
run is aborted; the test checks for leftovers.

## Failures the drill must catch

`tests/alpha/restore-drill.test.ts` runs the harness once and the drill five times:

| Run | Fault or condition | Required result |
| --- | --- | --- |
| intended | none | passes, report asserted |
| worker running | a reconciler loop runs from the restore on, as a worker that was already up | passes: its passes are refused while the cursor is stale or lagging (`reconcileSkips >= 1`), the gate stays closed at the checkpoints before the catch-up, the quote is settled afterwards. Without the application fix this run fails. |
| early reopen | the gate is cleared after replay and before the reconciler | `RESTORE_QUOTING_REOPENED_EARLY` |
| tampered projection | maker balance changed after restore | `RESTORE_REPLAY_DIFFERS` |
| diverged restore | cursor changed after restore | `RESTORE_NOT_EQUAL_TO_DUMP` |

The contract views are compared with `RESTORE_CONTRACT_MISMATCH`. A unit test in
`tests/quote-reconcile.test.ts` pins the reconciler rule for a lagging, gated and stale cursor.

## Run

```sh
TEST_POSTGRES_ADMIN_URL=postgresql://blink_test:local-ci-only@127.0.0.1:55415/postgres pnpm drill:restore        # one intended run, prints the JSON report
TEST_POSTGRES_ADMIN_URL=postgresql://blink_test:local-ci-only@127.0.0.1:55415/postgres pnpm drill:restore:test   # the test above
```

Requirements: Docker (the image is pulled on first use), the loopback PostgreSQL administrator
the other local tests use, and Anvil from the repository. On Linux the tool containers use
the host network; elsewhere they reach the host as `host.docker.internal`. CI runs
`drill:restore:test` in the `check` job after `alpha:local`.

## Inputs for the deployment runbook (A6)

The restore order the application now supports: restore the dump; run `restore:prepare`; start
the indexer; start the worker and the API at any time after that. The pool gate stays closed
until the indexer's cursor is fresh and the reconciler has judged the reservations; no service
needs to be held back for it. Real restores differ from the drill in these ways:

- **Roles.** The drill restores into the same cluster. A fresh cluster needs the `blink_*`
  group roles and the service logins before `pg_restore --exit-on-error`, otherwise the GRANTs
  fail.
- **Owner.** `--no-owner` makes the restoring login own every object. Here that login is the
  schema owner anyway. A production restore must run as the schema owner (or use `--role`),
  or later migrations fail.
- **Fence the old stack.** Quotes and reservations signed after the dump are unknown to the
  restored database, so its reconciler cannot see them. That is safe only because a quote is
  valid for 30 s of block time, which has passed before a restore finishes, and only if the old
  API and signer are stopped first.
- **Signer state.** Nonce allocations and unbroadcast artifacts made after the dump are lost
  with them; check the signer's nonce against the chain before it signs again.
- **Cursor lease.** A dump carries the lease of the indexer that died, normally already lapsed
  by restore time. If it has not, the new indexer's sync result reads "nothing to do" although
  RFQ and health still report `INDEXER_LAG` through `synced_at` and the lag. Clearing the lease
  is safe: indexer commits are fenced by `lease_token`, so a live holder's next commit fails.
- **Database-level settings** (`ALTER ROLE ... IN DATABASE`, such as the harness's test clock)
  are not part of a dump and must be applied again.
- **Entry point.** `runRestoreDrill` needs the local Alpha (Anvil, its admin key, the test
  clock). A drill against a real deployment (plan B4) needs a separate entry point; this slice
  does not provide one.
- **Automatic gate.** The application does not close the gate by itself after a restore; that
  would need a restore marker in the database and a migration this plan did not allot. The
  runbook step `restore:prepare` is what closes it.

## Findings while building it

- A dump carries the cursor lease of the indexer that died (see above); a quick drill sees the
  new indexer do nothing until it lapses.
- The worker's reconcile backstop used to clear the gate on a stale cursor, which defeated any
  runbook that only closed the gate. Fixed in the reconciler.
- pg_dump 17.6 writes a random `\restrict` token per run and PostgreSQL re-parenthesizes long
  CHECK constraints after a restore; both are normalized in the schema comparison.

## Verification

Run on 2026-10-18 against PostgreSQL 17.6 on port 55415 (see the task report for output):

- `pnpm check`: passes (includes the new reconciler unit test and `tests/quote-reconcile.test.ts`).
- `pnpm build:services && pnpm test:service-build`: passes.
- `pnpm test:anvil`, `pnpm test:postgres`, `pnpm alpha:local`: pass.
- `pnpm drill:restore:test`: passes (five drill runs, about 2 minutes).
- Existing expectations changed, both in `tests/quote-reconcile.test.ts`, both because a cursor
  that is not fresh is now refused: "while the indexer's cursor is gated nothing is concluded"
  now also expects `skipped: "INDEXER_LAG"` (the counts are the same zeros); and "expiry
  releases on the block time of the cursor, never on a local clock" now refreshes the cursor
  while the database clock is skewed, because a skewed clock without a fresh sync correctly
  makes the cursor stale. Its assertions about block time are unchanged.

## Limits

- **Object archive restore is out of scope** until decision D3 picks the storage. The drill
  restores the database only; spec and evidence objects in the archive are not backed up,
  restored or compared here.
- The drill uses the local Alpha database and an Anvil chain. It does not exercise a managed
  PostgreSQL, a backup schedule, point-in-time recovery, restore timing targets or access
  control for backups.
- The reconciler's fate for the unfilled quote is "expired by block time". A fill that lands
  after the dump (ACCOUNTED) and a reorg after restore are covered by the RFQ and indexer
  tests, not by this drill.
- Tool containers need Docker and the `postgres:17.6` image; an image digest is not pinned
  here (see the image tasks). Only the Docker Desktop (macOS) network path ran locally; the
  Linux `--network host` path is for CI.
