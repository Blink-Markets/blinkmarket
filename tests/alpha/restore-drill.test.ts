import { test } from "node:test";
import assert from "node:assert/strict";
import { ALPHA_DEADLINE_MS, runLocalAlpha } from "../../scripts/local-alpha.ts";
import {
  runRestoreDrill,
  type RestoreDrillReport,
} from "../../scripts/restore-drill.ts";
import { databaseTraces, leakedTraces } from "../helpers/postgres-traces.js";

// One real Alpha run supplies the source database and the chain; the drill then runs on it
// five times: twice as intended (the second with a worker already reconciling) and three times with a deliberate fault the drill must catch.
test(
  "a restored database replays, stays gated until reconciled, and the drill catches a restore that does not",
  { timeout: 480_000 },
  async (t) => {
    const before = await databaseTraces();
    const outcomes = {} as {
      ok: RestoreDrillReport;
      withWorker: RestoreDrillReport;
      early: unknown;
      tampered: unknown;
      diverged: unknown;
    };
    const failure = (run: Promise<unknown>) =>
      run.then(
        () => undefined,
        (error: unknown) => error,
      );
    await runLocalAlpha({
      signal: AbortSignal.any([
        t.signal,
        AbortSignal.timeout(ALPHA_DEADLINE_MS * 2),
      ]),
      whileOpen: async (context) => {
        outcomes.ok = await runRestoreDrill(context);
        // A worker that is already running reconciles from the moment the database is back.
        outcomes.withWorker = await runRestoreDrill(context, {
          reconcileLoop: true,
        });
        // A restore that reopens quoting before the reconciler has run.
        outcomes.early = await failure(
          runRestoreDrill(context, {
            interfere: {
              beforeReconcile: async (db) => {
                await db.query(
                  "UPDATE trading.maker_pools SET gate_reason=NULL",
                );
              },
            },
          }),
        );
        // A restore whose projection no longer follows from the canonical events.
        outcomes.tampered = await failure(
          runRestoreDrill(context, {
            interfere: {
              afterRestore: async (db) => {
                await db.query(
                  "UPDATE chain.maker_state SET free_balance_micros = free_balance_micros + 1",
                );
              },
            },
          }),
        );
        // A restore that does not hold what the dump held (here a cursor that moved).
        outcomes.diverged = await failure(
          runRestoreDrill(context, {
            interfere: {
              afterRestore: async (db) => {
                await db.query(
                  "UPDATE chain.cursors SET head_number = head_number + 1",
                );
              },
            },
          }),
        );
      },
    });

    const report = outcomes.ok;
    assert.match(report.pgDumpVersion, /^pg_dump \(PostgreSQL\) 17\.6\b/);
    assert.ok(report.archiveBytes > 0);
    assert.ok(report.eventCount > 0);
    assert.equal(report.restoredEqualsDump, true);
    assert.equal(report.rebuildDifferences, 0);
    assert.ok(
      report.replayedAfterRestore >= 1,
      "the chain moved past the dump",
    );
    assert.equal(report.matchesContractAtDump, true);
    assert.equal(report.matchesContractAtHead, true);
    // Closed at every checkpoint before the reconciler, open only after it.
    assert.deepEqual(
      report.gates.map((g) => g.checkpoint),
      ["restored", "rebuild verified", "replayed to head", "reconciled"],
    );
    for (const gate of report.gates.slice(0, 3))
      assert.ok(gate.reasons.length > 0, gate.checkpoint + " is gated");
    assert.ok(report.gates[0]!.reasons.includes("OVERCOMMITTED"));
    assert.ok(report.gates[0]!.reasons.includes("INDEXER_LAG"));
    assert.ok(report.gates[2]!.reasons.includes("OVERCOMMITTED"));
    assert.deepEqual(report.gates[3]!.reasons, []);
    assert.equal(report.openReservations, 0);
    assert.equal(report.schemaIdentical, true);
    // The dump held an unfilled quote; the reconciler judged it against the chain.
    assert.ok(report.heldInDump >= 1);
    assert.ok(report.reconciled.accounted + report.reconciled.released >= 1);

    // With a worker reconciling all along, quoting still stays closed until the cursor is fresh:
    // its passes before the catch-up refused to judge, and the quote was settled afterwards.
    const worker = outcomes.withWorker;
    assert.ok(
      worker.reconcileSkips >= 1,
      "the worker's early passes were refused",
    );
    assert.ok(worker.gates[0]!.reasons.includes("OVERCOMMITTED"));
    assert.ok(worker.gates[1]!.reasons.includes("OVERCOMMITTED"));
    assert.ok(worker.reconciled.accounted + worker.reconciled.released >= 1);
    assert.deepEqual(worker.gates.at(-1)!.reasons, []);

    assert.match(String(outcomes.early), /RESTORE_QUOTING_REOPENED_EARLY/);
    assert.match(String(outcomes.tampered), /RESTORE_REPLAY_DIFFERS/);
    assert.match(String(outcomes.diverged), /RESTORE_NOT_EQUAL_TO_DUMP/);
    assert.deepEqual(await leakedTraces(before), []);
  },
);
