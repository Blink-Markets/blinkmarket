import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { DiscoveryStore, ScanRun } from "@blink/ports";
import { createUnitOfWork } from "./database.js";

const MAX_CANDIDATES_PER_DAY = 10;

// Runs as blink_worker. The lock order is always the day's counter, then the run.
export function postgresDiscoveryStore(pool: Pool): DiscoveryStore {
  const uow = createUnitOfWork(pool);
  const runColumns = `id,state,evidence_id AS "evidenceId",answer`;
  return {
    async now() {
      const { rows } = await pool.query("SELECT blink.now() AS now");
      return new Date(rows[0].now);
    },
    async fetchableSources() {
      const { rows } = await pool.query(
        "SELECT id FROM evidence.sources WHERE enabled AND fetch_enabled ORDER BY id",
      );
      return rows.map((row) => String(row.id));
    },
    startRun: (input) =>
      uow.run(async (tx) => {
        const db = uow.client(tx);
        await db.query(
          `INSERT INTO discovery.scan_runs(id,source_id,day,slot,state)
           VALUES ($1,$2,$3::date,$4,'STARTED')
           ON CONFLICT (source_id,day,slot) DO NOTHING`,
          [randomUUID(), input.sourceId, input.day, input.slot],
        );
        const { rows } = await db.query<ScanRun>(
          `SELECT ${runColumns} FROM discovery.scan_runs
           WHERE source_id=$1 AND day=$2::date AND slot=$3`,
          [input.sourceId, input.day, input.slot],
        );
        return rows[0]!;
      }),
    async recordEvidence(runId, evidenceId) {
      await pool.query(
        `UPDATE discovery.scan_runs SET evidence_id=$2,updated_at=blink.now()
         WHERE id=$1 AND state='STARTED'`,
        [runId, evidenceId],
      );
    },
    async fetchedEvidence(jobId) {
      const { rows } = await pool.query(
        "SELECT evidence_id FROM evidence.fetch_attempts WHERE job_id=$1 AND state='SUCCEEDED'",
        [jobId],
      );
      return rows[0] ? String(rows[0].evidence_id) : null;
    },
    async newestEvidence(sourceId, day) {
      const { rows } = await pool.query(
        `SELECT id FROM evidence.records
         WHERE source_id=$1 AND (observed_at AT TIME ZONE 'UTC')::date=$2::date
         ORDER BY observed_at DESC,id LIMIT 1`,
        [sourceId, day],
      );
      return rows[0] ? String(rows[0].id) : null;
    },
    async evidence(evidenceId) {
      const { rows } = await pool.query(
        `SELECT id,object_uri,'0x'||encode(content_hash,'hex') AS content_hash
         FROM evidence.records WHERE id=$1`,
        [evidenceId],
      );
      const row = rows[0];
      return row
        ? {
            evidenceId: String(row.id),
            objectUri: String(row.object_uri),
            contentHash: String(row.content_hash),
          }
        : null;
    },
    async beginModelAttempt(runId) {
      const { rows } = await pool.query(
        `UPDATE discovery.scan_runs SET attempts=attempts+1,updated_at=blink.now()
         WHERE id=$1 AND state='STARTED' AND attempts<2 RETURNING attempts`,
        [runId],
      );
      return rows[0] ? Number(rows[0].attempts) : null;
    },
    takeSlot: (runId, answer) =>
      uow.run(async (tx) => {
        const db = uow.client(tx);
        const run = (
          await db.query(
            "SELECT day::text AS day FROM discovery.scan_runs WHERE id=$1",
            [runId],
          )
        ).rows[0]!;
        await db.query(
          "INSERT INTO discovery.daily_counters(day) VALUES ($1::date) ON CONFLICT (day) DO NOTHING",
          [run.day],
        );
        const counter = (
          await db.query(
            "SELECT candidates FROM discovery.daily_counters WHERE day=$1::date FOR UPDATE",
            [run.day],
          )
        ).rows[0]!;
        const held = (
          await db.query(
            "SELECT slot_taken FROM discovery.scan_runs WHERE id=$1 FOR UPDATE",
            [runId],
          )
        ).rows[0]!;
        if (held.slot_taken) return "ALREADY";
        if (Number(counter.candidates) >= MAX_CANDIDATES_PER_DAY) return "CAP";
        await db.query(
          "UPDATE discovery.daily_counters SET candidates=candidates+1 WHERE day=$1::date",
          [run.day],
        );
        await db.query(
          "UPDATE discovery.scan_runs SET slot_taken=true,answer=$2,updated_at=blink.now() WHERE id=$1",
          [runId, answer],
        );
        return "TAKEN";
      }),
    finish: (runId, outcome) =>
      uow.run(async (tx) => {
        const db = uow.client(tx);
        const run = (
          await db.query(
            "SELECT day::text AS day FROM discovery.scan_runs WHERE id=$1",
            [runId],
          )
        ).rows[0]!;
        await db.query(
          "SELECT 1 FROM discovery.daily_counters WHERE day=$1::date FOR UPDATE",
          [run.day],
        );
        const current = (
          await db.query(
            "SELECT state,slot_taken FROM discovery.scan_runs WHERE id=$1 FOR UPDATE",
            [runId],
          )
        ).rows[0]!;
        // Only a STARTED run can end; a redelivered job finds it already settled.
        if (current.state !== "STARTED") return;
        const keepSlot =
          outcome.state === "CANDIDATE_CREATED" || outcome.keepSlot === true;
        await db.query(
          `UPDATE discovery.scan_runs
           SET state=$2,candidate_id=$3,error_code=$4,slot_taken=slot_taken AND $5::boolean,updated_at=blink.now()
           WHERE id=$1`,
          [
            runId,
            outcome.state,
            outcome.candidateId ?? null,
            outcome.errorCode ?? null,
            keepSlot,
          ],
        );
        if (current.slot_taken && !keepSlot)
          await db.query(
            "UPDATE discovery.daily_counters SET candidates=candidates-1 WHERE day=$1::date",
            [run.day],
          );
        if (outcome.audit)
          await db.query(
            `INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id)
             VALUES ($1,current_user,$2,$3,$4,$5)`,
            [
              randomUUID(),
              outcome.audit,
              runId,
              outcome.errorCode ?? outcome.state,
              runId,
            ],
          );
      }),
  };
}
