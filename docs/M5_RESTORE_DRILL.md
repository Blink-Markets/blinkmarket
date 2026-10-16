# M5 backup and restore drill — Task A5 delivery

中文摘要：在本機 Alpha 完成後以 PostgreSQL 17.6 映像的 pg_dump／pg_restore 備份並還原到全新資料庫，驗證投影與備份及合約檢視一致、重放 canonical 事件，並確認在 reservation 對帳器清除前報價一直關閉；物件封存還原尚未納入（待 D3）。

This is the §17.3 "backup restore succeeds" evidence, runnable locally and in CI. It builds
on the local Alpha harness (`docs/M5_LOCAL_ALPHA.md`) and on `chain:rebuild --verify`. It
deploys nothing, signs nothing and contacts no provider: the source is the harness's own
random database on a local Anvil (chain ID 84532).

## What the drill does

`runLocalAlpha` takes an optional `afterScenarios` hook (an additive option; the scenarios
and the harness's own restore drills are unchanged). `scripts/restore-drill.ts` runs from
that hook once all three REPLAY scenarios have settled:

1. **Capture.** The chain projection and cursor, a digest of every table (row count plus an
   md5 of the rows) and every table and column privilege of the source database.
2. **Dump.** `pg_dump --format=custom --no-owner` from the `postgres:17.6` image
   (`docker run`; the host needs Docker, not a PostgreSQL install). The tool version is
   recorded in the report.
3. **The chain moves on.** One `setTakerAllowed` event and six blocks, so the dump is behind
   the head by more than the RFQ lag rule tolerates, as a real backup would be.
4. **Restore.** `pg_restore --no-owner --exit-on-error` into a fresh database. Service roles
   are cluster-level and are not in the dump (the drill's logins are new and member of
   `blink_indexer` and `blink_worker`).
5. **Close quoting first.** The pool gate is set to `OVERCOMMITTED` before anything reads the
   restored data. Gate reasons are judged like the RFQ does: the pool gate, settled
   reservations whose block is not canonical (`RECONCILE_REQUIRED`), and the indexer's
   freshness (`INDEXER_LAG`).
6. **Replay.** `pnpm chain:rebuild <deployment> --verify` folds the stored canonical events
   and must find no difference with the restored projections.
7. **Compare.** The restored projection, cursor, table digests and privileges must equal the
   pre-dump ones, and the projection must equal the contract's views (maker balance, epoch,
   pause, each market's escrow, pairs, pause and state, positions, takers, consumed digests)
   read at the dump's block.
8. **Catch up.** The dead indexer's cursor lease is cleared (no indexer runs against the
   copy yet), then the indexer syncs from the chain to the head, which replays the missed
   event. The projection must again equal the contract's views, now at the head.
9. **Reconcile.** Quoting must still be closed. Only then does the reservation reconciler
   (`createQuoteReconciler`) run; quoting must be open afterwards with no open reservation.

Every created database and login is dropped when the drill ends, also when it fails or the
run is aborted; the test checks for leftovers.

## Failures the drill must catch

`tests/alpha/restore-drill.test.ts` runs the harness once and the drill four times:

| Run | Fault injected | Required failure |
| --- | --- | --- |
| intended | none | passes, report asserted |
| early reopen | the gate is cleared after replay and before the reconciler | `RESTORE_QUOTING_REOPENED_EARLY` |
| tampered projection | maker balance changed after restore | `RESTORE_REPLAY_DIFFERS` |
| diverged restore | cursor changed after restore | `RESTORE_NOT_EQUAL_TO_DUMP` |

The first is the review-focus-2 test: a restore that reopens quoting before the reservations
reconcile fails the drill. A restore that does not agree with the canonical events or with
the dump fails in the other two. The contract views are compared with `RESTORE_CONTRACT_MISMATCH`.

## Run

```sh
TEST_POSTGRES_ADMIN_URL=postgresql://blink_test:local-ci-only@127.0.0.1:55415/postgres pnpm drill:restore        # one intended run, prints the JSON report
TEST_POSTGRES_ADMIN_URL=postgresql://blink_test:local-ci-only@127.0.0.1:55415/postgres pnpm drill:restore:test   # the test above
```

Requirements: Docker (images are pulled on first use), the loopback PostgreSQL administrator
the other local tests use, and Anvil from the repository. On Linux the tool containers use
the host network; elsewhere they reach the host as `host.docker.internal`. CI runs
`drill:restore:test` in the `check` job after `alpha:local`.

## Findings while building it

- A dump carries the cursor lease of the indexer that died. Until it lapses (up to 30 s) a new
  indexer reads "nothing to do", which looks like a fully caught-up database. The drill
  clears the lease as an explicit restore step; a runbook must either do the same or wait.
- A restore must not depend on database-level settings: `ALTER ROLE ... IN DATABASE` (used by
  the harness for its test clock) is not part of a dump, so the drill sets it again.

## Verification

See `.superpowers/sdd/2026-10-15-public-alpha-readiness/task-A5-report.md` for the commands and results of this slice.

## Limits

- **Object archive restore is out of scope** until decision D3 picks the storage. The drill
  restores the database only; spec and evidence objects in the archive are not backed up,
  restored or compared here.
- The drill uses the local Alpha database and an Anvil chain. It does not exercise a managed
  PostgreSQL, a backup schedule, point-in-time recovery, restore timing targets or access
  control for backups.
- The gate closed in step 5 is the drill's model of the restore procedure; the application
  does not yet close it by itself after a restore, so the runbook must include that step.
- Only the `OVERCOMMITTED` and `RECONCILE_REQUIRED` paths are covered. The Alpha ends with no
  open reservation, so the reconciler clears the gate without having to settle one; held or
  reorged reservations are covered by the RFQ and indexer tests, not by this drill.
- Tool containers need Docker and the `postgres:17.6` image; a CI image digest is not pinned
  here (see the image tasks).
