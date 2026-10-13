import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { postgresBudgetLedger } from "../packages/adapters/src/budget-ledger.js";
import { JobError } from "../packages/domain/src/jobs.js";
import { migratedPglite } from "./helpers/serial-pglite-pool.js";

type Db = Awaited<ReturnType<typeof migratedPglite>>;

async function withLedger(
  run: (
    s: Db,
    ledger: ReturnType<typeof postgresBudgetLedger>,
  ) => Promise<void>,
) {
  const s = await migratedPglite();
  try {
    await run(s, postgresBudgetLedger(s.pool));
  } finally {
    await s.db.close();
  }
}

const reservation = (
  maxUsdMicros: bigint,
  extra: {
    questionKey?: string;
    questionCapUsdMicros?: bigint;
    runId?: string;
  } = {},
) => ({
  runId: extra.runId ?? randomUUID(),
  questionKey: extra.questionKey ?? "q1",
  questionCapUsdMicros: extra.questionCapUsdMicros ?? 2_000_000n,
  provider: "fixture",
  model: "fixture-model",
  maxUsdMicros,
});

function jobError(code: string, retryable = false) {
  return (error: unknown) =>
    error instanceof JobError &&
    error.code === code &&
    error.retryable === retryable;
}

async function rows(s: Db, sql: string, params: unknown[] = []) {
  return (await s.pool.query(sql, params)).rows;
}

test("reserve within both caps occupies the day and the question", () =>
  withLedger(async (s, ledger) => {
    const { reservationId } = await ledger.reserve(reservation(500_000n));
    const day = await ledger.daySummary();
    assert.deepEqual(day, {
      day: day.day,
      capUsdMicros: 20_000_000n,
      spentUsdMicros: 0n,
      reservedUsdMicros: 500_000n,
      unknownUsdMicros: 0n,
    });
    assert.match(day.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(await ledger.questionSummary("q1"), {
      capUsdMicros: 2_000_000n,
      spentUsdMicros: 0n,
      reservedUsdMicros: 500_000n,
      unknownUsdMicros: 0n,
    });
    assert.deepEqual(await ledger.totals(), {
      spentUsdMicros: 0n,
      reservedUsdMicros: 500_000n,
      unknownUsdMicros: 0n,
    });
    assert.equal(await ledger.questionSummary("never-used"), null);
    const entries = await rows(
      s,
      "SELECT kind, amount_usd_micros::text AS amount FROM budgets.cost_entries WHERE reservation_id=$1",
      [reservationId],
    );
    assert.deepEqual(entries, [{ kind: "RESERVE", amount: "500000" }]);
    const stored = (
      await rows(
        s,
        `SELECT state, day::text AS day, provider, model FROM budgets.reservations WHERE id=$1`,
        [reservationId],
      )
    )[0];
    assert.deepEqual(stored, {
      state: "RESERVED",
      day: day.day,
      provider: "fixture",
      model: "fixture-model",
    });
  }));

test("a daily cap breach is BUDGET_EXHAUSTED and leaves no reservation", () =>
  withLedger(async (s, ledger) => {
    await s.asOwner(() =>
      s.db.query(
        `INSERT INTO budgets.daily(day,cap_usd_micros)
         VALUES ((blink.now() AT TIME ZONE 'UTC')::date, 1000000)`,
      ),
    );
    await ledger.reserve(reservation(600_000n, { questionKey: "a" }));
    await assert.rejects(
      ledger.reserve(reservation(600_000n, { questionKey: "b" })),
      jobError("BUDGET_EXHAUSTED"),
    );
    assert.equal((await ledger.daySummary()).reservedUsdMicros, 600_000n);
    assert.equal(
      (await rows(s, "SELECT id FROM budgets.reservations")).length,
      1,
    );
    // A request that still fits is admitted: the cap is exact, not rounded.
    await ledger.reserve(reservation(400_000n, { questionKey: "b" }));
    assert.equal((await ledger.daySummary()).reservedUsdMicros, 1_000_000n);
  }));

test("a question cap breach is BUDGET_EXHAUSTED and the first cap is kept", () =>
  withLedger(async (_s, ledger) => {
    await ledger.reserve(
      reservation(600_000n, { questionCapUsdMicros: 1_000_000n }),
    );
    await assert.rejects(
      ledger.reserve(
        reservation(600_000n, { questionCapUsdMicros: 2_000_000n }),
      ),
      jobError("BUDGET_EXHAUSTED"),
    );
    assert.equal(
      (await ledger.questionSummary("q1"))?.capUsdMicros,
      1_000_000n,
    );
    await ledger.reserve(reservation(600_000n, { questionKey: "other" }));
    assert.equal((await ledger.daySummary()).reservedUsdMicros, 1_200_000n);
  }));

test("UNKNOWN keeps the full maximum occupied without double counting", () =>
  withLedger(async (s, ledger) => {
    const { reservationId } = await ledger.reserve(reservation(1_500_000n));
    await ledger.markUnknown(reservationId, "req-unknown");
    const expected = {
      spentUsdMicros: 0n,
      reservedUsdMicros: 0n,
      unknownUsdMicros: 1_500_000n,
    };
    assert.deepEqual(await ledger.totals(), expected);
    assert.deepEqual(await ledger.questionSummary("q1"), {
      capUsdMicros: 2_000_000n,
      ...expected,
    });
    assert.equal((await ledger.daySummary()).unknownUsdMicros, 1_500_000n);
    await assert.rejects(
      ledger.reserve(reservation(600_000n)),
      jobError("BUDGET_EXHAUSTED"),
    );
    const stored = (
      await rows(
        s,
        "SELECT state, provider_request_id FROM budgets.reservations WHERE id=$1",
        [reservationId],
      )
    )[0];
    assert.deepEqual(stored, {
      state: "UNKNOWN",
      provider_request_id: "req-unknown",
    });
    assert.deepEqual(
      (
        await rows(
          s,
          "SELECT kind FROM budgets.cost_entries WHERE reservation_id=$1 ORDER BY created_at, kind",
          [reservationId],
        )
      ).map((r) => r.kind),
      ["RESERVE", "UNKNOWN"],
    );
    // A null request id is allowed: the request may never have reached the provider.
    const second = await ledger.reserve(
      reservation(100_000n, { questionKey: "q2" }),
    );
    await ledger.markUnknown(second.reservationId, null);
    // Late usage for an unknown request settles it.
    assert.deepEqual(
      await ledger.reconcile(reservationId, 900_000n, "req-unknown"),
      { overrun: false },
    );
    assert.equal((await ledger.totals()).unknownUsdMicros, 100_000n);
  }));

test("reconcile below the maximum frees the difference", () =>
  withLedger(async (s, ledger) => {
    const { reservationId } = await ledger.reserve(reservation(1_000_000n));
    assert.deepEqual(await ledger.reconcile(reservationId, 400_000n, "req-1"), {
      overrun: false,
    });
    assert.deepEqual(await ledger.totals(), {
      spentUsdMicros: 400_000n,
      reservedUsdMicros: 0n,
      unknownUsdMicros: 0n,
    });
    // 400k spent + 1.6M fits the 2M question cap exactly; one micro more does not.
    await assert.rejects(
      ledger.reserve(reservation(1_600_001n)),
      jobError("BUDGET_EXHAUSTED"),
    );
    await ledger.reserve(reservation(1_600_000n));
    const stored = (
      await rows(
        s,
        `SELECT state, actual_usd_micros::text AS actual, provider_request_id
         FROM budgets.reservations WHERE id=$1`,
        [reservationId],
      )
    )[0];
    assert.deepEqual(stored, {
      state: "RECONCILED",
      actual: "400000",
      provider_request_id: "req-1",
    });
    assert.deepEqual(
      await rows(
        s,
        "SELECT kind, amount_usd_micros::text AS amount FROM budgets.cost_entries WHERE reservation_id=$1 ORDER BY kind",
        [reservationId],
      ),
      [
        { kind: "RECONCILE", amount: "400000" },
        { kind: "RESERVE", amount: "1000000" },
      ],
    );
    await assert.rejects(
      ledger.reconcile(reservationId, 1n, "again"),
      jobError("RESERVATION_STATE_INVALID"),
    );
  }));

test("an overrun records the full actual cost and closes both gates", () =>
  withLedger(async (s, ledger) => {
    const { reservationId } = await ledger.reserve(reservation(500_000n));
    assert.deepEqual(
      await ledger.reconcile(reservationId, 700_000n, "req-over"),
      {
        overrun: true,
      },
    );
    assert.equal((await ledger.totals()).spentUsdMicros, 700_000n);
    assert.deepEqual(
      await rows(
        s,
        "SELECT kind, amount_usd_micros::text AS amount FROM budgets.cost_entries WHERE reservation_id=$1 ORDER BY kind",
        [reservationId],
      ),
      [
        { kind: "OVERRUN", amount: "200000" },
        { kind: "RECONCILE", amount: "700000" },
        { kind: "RESERVE", amount: "500000" },
      ],
    );
    const gates = await rows(
      s,
      `SELECT 'daily' AS scope, gate_closed_reason, version::text AS version FROM budgets.daily
       UNION ALL SELECT 'question', gate_closed_reason, version::text FROM budgets.questions`,
    );
    assert.deepEqual(gates, [
      { scope: "daily", gate_closed_reason: "OVERRUN", version: "1" },
      { scope: "question", gate_closed_reason: "OVERRUN", version: "1" },
    ]);
    await assert.rejects(
      ledger.reserve(reservation(1n)),
      jobError("BUDGET_GATE_CLOSED"),
    );
    // The day gate alone also blocks unrelated questions.
    await assert.rejects(
      ledger.reserve(reservation(1n, { questionKey: "unrelated" })),
      jobError("BUDGET_GATE_CLOSED"),
    );
  }));

test("an unsettled reservation stays on its own day and counts toward the question", () =>
  withLedger(async (s, ledger) => {
    const yesterday = (
      await rows(
        s,
        "SELECT ((blink.now() AT TIME ZONE 'UTC')::date - 1)::text AS d",
      )
    )[0].d as string;
    await s.asOwner(async () => {
      await s.db.query("INSERT INTO budgets.daily(day) VALUES ($1::date)", [
        yesterday,
      ]);
      await s.db.query(
        "INSERT INTO budgets.questions(question_key,cap_usd_micros) VALUES ('q1', 2000000)",
      );
      await s.db.query(
        `INSERT INTO budgets.reservations
           (id,day,question_key,run_id,provider,model,max_usd_micros,state)
         VALUES ($1,$2::date,'q1',$3,'fixture','m',1500000,'UNKNOWN')`,
        [randomUUID(), yesterday, randomUUID()],
      );
    });
    const old = await ledger.daySummary(yesterday);
    assert.equal(old.day, yesterday);
    assert.equal(old.unknownUsdMicros, 1_500_000n);
    const today = await ledger.daySummary();
    assert.notEqual(today.day, yesterday);
    assert.equal(today.unknownUsdMicros, 0n);
    assert.equal(today.capUsdMicros, 20_000_000n);
    assert.equal(
      (await ledger.questionSummary("q1"))?.unknownUsdMicros,
      1_500_000n,
    );
    // The new day is a new row, but the question total keeps accumulating.
    await assert.rejects(
      ledger.reserve(reservation(600_000n)),
      jobError("BUDGET_EXHAUSTED"),
    );
    await ledger.reserve(reservation(500_000n));
    assert.equal((await ledger.daySummary()).reservedUsdMicros, 500_000n);
    assert.equal((await ledger.daySummary(yesterday)).reservedUsdMicros, 0n);
  }));

test("release is only for reservations that were never sent", () =>
  withLedger(async (s, ledger) => {
    const unknown = await ledger.reserve(reservation(100_000n));
    await ledger.markUnknown(unknown.reservationId, null);
    await assert.rejects(
      ledger.release(unknown.reservationId),
      jobError("RESERVATION_STATE_INVALID"),
    );
    const unsent = await ledger.reserve(
      reservation(300_000n, { questionKey: "q2" }),
    );
    await ledger.release(unsent.reservationId);
    assert.deepEqual(await ledger.totals(), {
      spentUsdMicros: 0n,
      reservedUsdMicros: 0n,
      unknownUsdMicros: 100_000n,
    });
    await assert.rejects(
      ledger.release(unsent.reservationId),
      jobError("RESERVATION_STATE_INVALID"),
    );
    await assert.rejects(
      ledger.markUnknown(unsent.reservationId, null),
      jobError("RESERVATION_STATE_INVALID"),
    );
    await assert.rejects(
      ledger.release(randomUUID()),
      jobError("RESERVATION_NOT_FOUND"),
    );
    assert.deepEqual(
      (
        await rows(
          s,
          "SELECT kind FROM budgets.cost_entries WHERE reservation_id=$1 ORDER BY kind",
          [unsent.reservationId],
        )
      ).map((r) => r.kind),
      ["RELEASE", "RESERVE"],
    );
  }));

test("a released reservation gives its question capacity back", () =>
  withLedger(async (_s, ledger) => {
    const options = { questionCapUsdMicros: 100n };
    const first = await ledger.reserve(reservation(100n, options));
    await assert.rejects(
      ledger.reserve(reservation(1n, options)),
      jobError("BUDGET_EXHAUSTED"),
    );
    await ledger.release(first.reservationId);
    const second = await ledger.reserve(reservation(100n, options));
    await ledger.release(second.reservationId);
    await ledger.reserve(reservation(100n, options));
    assert.deepEqual(await ledger.questionSummary("q1"), {
      capUsdMicros: 100n,
      spentUsdMicros: 0n,
      reservedUsdMicros: 100n,
      unknownUsdMicros: 0n,
    });
  }));

test("a released reservation gives its day capacity back", () =>
  withLedger(async (s, ledger) => {
    await s.asOwner(() =>
      s.db.query(
        `INSERT INTO budgets.daily(day,cap_usd_micros)
         VALUES ((blink.now() AT TIME ZONE 'UTC')::date, 100)`,
      ),
    );
    const first = await ledger.reserve(reservation(100n, { questionKey: "a" }));
    await assert.rejects(
      ledger.reserve(reservation(1n, { questionKey: "b" })),
      jobError("BUDGET_EXHAUSTED"),
    );
    await ledger.release(first.reservationId);
    await ledger.reserve(reservation(100n, { questionKey: "b" }));
    assert.equal((await ledger.daySummary()).reservedUsdMicros, 100n);
  }));

test("a run id can be reserved only once and bad requests are refused", () =>
  withLedger(async (_s, ledger) => {
    const runId = randomUUID();
    await ledger.reserve(reservation(1n, { runId }));
    await assert.rejects(
      ledger.reserve(reservation(1n, { runId })),
      jobError("RUN_ID_REUSED"),
    );
    await assert.rejects(
      ledger.reserve(reservation(0n)),
      jobError("BUDGET_REQUEST_INVALID"),
    );
    await assert.rejects(
      ledger.reserve(reservation(1n, { questionCapUsdMicros: 2_000_001n })),
      jobError("BUDGET_REQUEST_INVALID"),
    );
    await assert.rejects(
      ledger.reserve(reservation(1n, { questionKey: "" })),
      jobError("BUDGET_REQUEST_INVALID"),
    );
    assert.deepEqual((await ledger.totals()).reservedUsdMicros, 1n);
  }));

test("cost entries are append-only and the API role can read but not reserve", () =>
  withLedger(async (s, ledger) => {
    await ledger.reserve(reservation(100_000n));
    await assert.rejects(
      s.pool.query("UPDATE budgets.cost_entries SET amount_usd_micros=0"),
      /permission denied/,
    );
    await s.asOwner(async () => {
      await assert.rejects(
        s.db.query("UPDATE budgets.cost_entries SET amount_usd_micros=0"),
        /append-only/,
      );
      await assert.rejects(
        s.db.query("DELETE FROM budgets.cost_entries"),
        /append-only/,
      );
      await assert.rejects(
        s.db.query("TRUNCATE budgets.cost_entries"),
        /append-only/,
      );
    });
    await s.db.exec("SET ROLE blink_api");
    assert.equal((await ledger.daySummary()).reservedUsdMicros, 100_000n);
    await assert.rejects(
      ledger.reserve(reservation(1n, { questionKey: "api" })),
      /permission denied/,
    );
  }));
