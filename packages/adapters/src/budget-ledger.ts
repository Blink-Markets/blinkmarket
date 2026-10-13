import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { JobError, type BudgetLedger } from "@blink/ports";
import { createUnitOfWork } from "./database.js";

type Db = Pick<PoolClient, "query">;

const MAX_QUESTION_CAP_USD_MICROS = 2_000_000n;
const UTC_TODAY = "(blink.now() AT TIME ZONE 'UTC')::date";
// The one definition of what a scope has used: RECONCILED counts its actual cost,
// RESERVED and UNKNOWN their full maximum, RELEASED nothing. Admission and every
// summary read these buckets.
const BUCKETS = `
  COALESCE(SUM(r.actual_usd_micros) FILTER (WHERE r.state='RECONCILED'),0)::text AS spent,
  COALESCE(SUM(r.max_usd_micros) FILTER (WHERE r.state='RESERVED'),0)::text AS reserved,
  COALESCE(SUM(r.max_usd_micros) FILTER (WHERE r.state='UNKNOWN'),0)::text AS unknown`;

interface Buckets {
  spent: string;
  reserved: string;
  unknown: string;
}
const usage = (row: Buckets) => ({
  spentUsdMicros: BigInt(row.spent),
  reservedUsdMicros: BigInt(row.reserved),
  unknownUsdMicros: BigInt(row.unknown),
});
const used = (row: Buckets) => {
  const { spentUsdMicros, reservedUsdMicros, unknownUsdMicros } = usage(row);
  return spentUsdMicros + reservedUsdMicros + unknownUsdMicros;
};

function validRequest(ok: boolean) {
  if (!ok) throw new JobError("BUDGET_REQUEST_INVALID", false);
}

async function appendEntry(
  db: Db,
  reservationId: string,
  kind: "RESERVE" | "UNKNOWN" | "RECONCILE" | "RELEASE" | "OVERRUN",
  amountUsdMicros: bigint,
  providerRequestId: string | null = null,
) {
  await db.query(
    `INSERT INTO budgets.cost_entries(id,reservation_id,kind,amount_usd_micros,provider_request_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      randomUUID(),
      reservationId,
      kind,
      amountUsdMicros.toString(),
      providerRequestId,
    ],
  );
}

export function postgresBudgetLedger(pool: Pool): BudgetLedger {
  const uow = createUnitOfWork(pool);

  // A reservation's day, question and maximum never change after it is created.
  async function identify(db: Db, reservationId: string) {
    const { rows } = await db.query<{
      day: string;
      question_key: string;
      max: string;
    }>(
      `SELECT day::text AS day,question_key,max_usd_micros::text AS max
       FROM budgets.reservations WHERE id=$1`,
      [reservationId],
    );
    if (!rows[0]) throw new JobError("RESERVATION_NOT_FOUND", false);
    return {
      day: rows[0].day,
      questionKey: rows[0].question_key,
      max: BigInt(rows[0].max),
    };
  }

  async function lockState(db: Db, reservationId: string) {
    const { rows } = await db.query<{ state: string }>(
      "SELECT state FROM budgets.reservations WHERE id=$1 FOR UPDATE",
      [reservationId],
    );
    return rows[0]!.state;
  }

  // Lock order everywhere: daily row, then question row, then the reservation.
  async function lockDaily(db: Db, day: string) {
    const { rows } = await db.query<{ cap: string; gate: string | null }>(
      "SELECT cap_usd_micros::text AS cap,gate_closed_reason AS gate FROM budgets.daily WHERE day=$1::date FOR UPDATE",
      [day],
    );
    return rows[0]!;
  }

  async function lockQuestion(db: Db, questionKey: string) {
    const { rows } = await db.query<{ cap: string; gate: string | null }>(
      "SELECT cap_usd_micros::text AS cap,gate_closed_reason AS gate FROM budgets.questions WHERE question_key=$1 FOR UPDATE",
      [questionKey],
    );
    return rows[0]!;
  }

  return {
    async reserve(input) {
      validRequest(input.maxUsdMicros > 0n);
      validRequest(
        input.questionCapUsdMicros >= 1n &&
          input.questionCapUsdMicros <= MAX_QUESTION_CAP_USD_MICROS,
      );
      validRequest(
        input.questionKey.length >= 1 && input.questionKey.length <= 200,
      );
      return uow.run(async (tx) => {
        const db = uow.client(tx);
        const day = (
          await db.query<{ day: string }>(`SELECT ${UTC_TODAY}::text AS day`)
        ).rows[0]!.day;
        await db.query(
          "INSERT INTO budgets.daily(day) VALUES ($1::date) ON CONFLICT (day) DO NOTHING",
          [day],
        );
        const daily = await lockDaily(db, day);
        // The first call fixes the question's cap; later callers cannot change it.
        await db.query(
          `INSERT INTO budgets.questions(question_key,cap_usd_micros) VALUES ($1,$2)
           ON CONFLICT (question_key) DO NOTHING`,
          [input.questionKey, input.questionCapUsdMicros.toString()],
        );
        const question = await lockQuestion(db, input.questionKey);
        if (daily.gate || question.gate)
          throw new JobError("BUDGET_GATE_CLOSED", false);
        const dayBuckets = await db.query<Buckets>(
          `SELECT ${BUCKETS} FROM budgets.reservations r WHERE r.day=$1::date`,
          [day],
        );
        const questionBuckets = await db.query<Buckets>(
          `SELECT ${BUCKETS} FROM budgets.reservations r WHERE r.question_key=$1`,
          [input.questionKey],
        );
        if (
          used(dayBuckets.rows[0]!) + input.maxUsdMicros > BigInt(daily.cap) ||
          used(questionBuckets.rows[0]!) + input.maxUsdMicros >
            BigInt(question.cap)
        )
          throw new JobError("BUDGET_EXHAUSTED", false);
        const reservationId = randomUUID();
        try {
          await db.query(
            `INSERT INTO budgets.reservations
               (id,day,question_key,run_id,job_id,provider,model,max_usd_micros,state)
             VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,'RESERVED')`,
            [
              reservationId,
              day,
              input.questionKey,
              input.runId,
              input.jobId ?? null,
              input.provider,
              input.model,
              input.maxUsdMicros.toString(),
            ],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "23505")
            throw new JobError("RUN_ID_REUSED", false);
          throw error;
        }
        await appendEntry(db, reservationId, "RESERVE", input.maxUsdMicros);
        return { reservationId };
      });
    },

    async markUnknown(reservationId, providerRequestId) {
      await uow.run(async (tx) => {
        const db = uow.client(tx);
        const { max } = await identify(db, reservationId);
        if ((await lockState(db, reservationId)) !== "RESERVED")
          throw new JobError("RESERVATION_STATE_INVALID", false);
        await db.query(
          `UPDATE budgets.reservations
           SET state='UNKNOWN',provider_request_id=$2,updated_at=blink.now() WHERE id=$1`,
          [reservationId, providerRequestId],
        );
        await appendEntry(db, reservationId, "UNKNOWN", max, providerRequestId);
      });
    },

    async reconcile(reservationId, actualUsdMicros, providerRequestId) {
      validRequest(actualUsdMicros >= 0n && providerRequestId.length > 0);
      return uow.run(async (tx) => {
        const db = uow.client(tx);
        const { day, questionKey, max } = await identify(db, reservationId);
        const overrun = actualUsdMicros > max;
        // An overrun closes both gates, so it takes the same locks as reserve, in the same order.
        if (overrun) {
          await lockDaily(db, day);
          await lockQuestion(db, questionKey);
        }
        const state = await lockState(db, reservationId);
        if (state !== "RESERVED" && state !== "UNKNOWN")
          throw new JobError("RESERVATION_STATE_INVALID", false);
        await db.query(
          `UPDATE budgets.reservations
           SET state='RECONCILED',actual_usd_micros=$2,provider_request_id=$3,updated_at=blink.now()
           WHERE id=$1`,
          [reservationId, actualUsdMicros.toString(), providerRequestId],
        );
        await appendEntry(
          db,
          reservationId,
          "RECONCILE",
          actualUsdMicros,
          providerRequestId,
        );
        if (overrun) {
          await appendEntry(
            db,
            reservationId,
            "OVERRUN",
            actualUsdMicros - max,
            providerRequestId,
          );
          await db.query(
            "UPDATE budgets.daily SET gate_closed_reason='OVERRUN',version=version+1 WHERE day=$1::date",
            [day],
          );
          await db.query(
            "UPDATE budgets.questions SET gate_closed_reason='OVERRUN',version=version+1 WHERE question_key=$1",
            [questionKey],
          );
        }
        return { overrun };
      });
    },

    async release(reservationId) {
      await uow.run(async (tx) => {
        const db = uow.client(tx);
        const { max } = await identify(db, reservationId);
        if ((await lockState(db, reservationId)) !== "RESERVED")
          throw new JobError("RESERVATION_STATE_INVALID", false);
        await db.query(
          "UPDATE budgets.reservations SET state='RELEASED',updated_at=blink.now() WHERE id=$1",
          [reservationId],
        );
        await appendEntry(db, reservationId, "RELEASE", max);
      });
    },

    async daySummary(day) {
      const { rows } = await pool.query<Buckets & { day: string; cap: string }>(
        `WITH d AS (SELECT COALESCE($1::date,${UTC_TODAY}) AS day)
         SELECT d.day::text AS day,
           -- 20000000 is the budgets.daily cap default for a day that has no row yet.
           COALESCE((SELECT cap_usd_micros FROM budgets.daily WHERE day=d.day),20000000)::text AS cap,
           ${BUCKETS}
         FROM d LEFT JOIN budgets.reservations r ON r.day=d.day
         GROUP BY d.day`,
        [day ?? null],
      );
      const row = rows[0]!;
      return { day: row.day, capUsdMicros: BigInt(row.cap), ...usage(row) };
    },

    async questionSummary(questionKey) {
      const { rows } = await pool.query<Buckets & { cap: string }>(
        `SELECT q.cap_usd_micros::text AS cap,${BUCKETS}
         FROM budgets.questions q
         LEFT JOIN budgets.reservations r ON r.question_key=q.question_key
         WHERE q.question_key=$1
         GROUP BY q.question_key`,
        [questionKey],
      );
      const row = rows[0];
      return row ? { capUsdMicros: BigInt(row.cap), ...usage(row) } : null;
    },

    async totals() {
      const { rows } = await pool.query<Buckets>(
        `SELECT ${BUCKETS} FROM budgets.reservations r`,
      );
      return usage(rows[0]!);
    },
  };
}
