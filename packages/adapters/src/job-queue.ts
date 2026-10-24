import { assertRuntimeRole } from "./runtime-role.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { retryDelayMs, type JobQueue, type JobSpec } from "@blink/ports";

type Db = Pick<PoolClient, "query">;

// Matches the operations.jobs.max_attempts column default.
const DEFAULT_MAX_ATTEMPTS = 3;

function positive(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000)
    throw new Error("INVALID_JOB_QUEUE_" + name.toUpperCase());
}

/**
 * Inserts a job unless its dedupe key exists. Business transactions call this
 * (through enqueueJobInTransaction) so the job commits or rolls back with them.
 * `outboxId` links a job to the event that produced it.
 */
export async function insertJob(
  db: Db,
  spec: JobSpec,
  outboxId: string | null = null,
): Promise<{ jobId: string; created: boolean }> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO operations.jobs
       (id,outbox_id,type,dedupe_key,payload,state,next_run_at,max_attempts)
     VALUES ($1,$2,$3,$4,$5,'QUEUED',COALESCE($6::timestamptz,blink.now()),$7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      outboxId,
      spec.type,
      spec.dedupeKey,
      spec.payload,
      spec.runAt ?? null,
      spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    ],
  );
  if (inserted.rows[0]) return { jobId: inserted.rows[0].id, created: true };
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM operations.jobs WHERE dedupe_key=$1",
    [spec.dedupeKey],
  );
  return { jobId: existing.rows[0]!.id, created: false };
}

export async function enqueueJobInTransaction(
  client: PoolClient,
  spec: JobSpec,
): Promise<{ jobId: string; created: boolean }> {
  return insertJob(client, spec);
}

export function postgresJobQueue(pool: Pool): JobQueue {
  return {
    enqueue: (spec) => insertJob(pool, spec),
    async lease(workerId, types, leaseMs) {
      if (!workerId || workerId.length > 128)
        throw new Error("INVALID_JOB_QUEUE_WORKER_ID");
      positive("lease_ms", leaseMs);
      if (types.length === 0) return null;
      // A job whose lease keeps expiring has crashed its workers every time:
      // dead-letter it once its attempts are spent instead of leasing it again.
      // Alert delivery stays recoverable until a destination accepts it.
      await pool.query(
        `WITH expired AS (
           UPDATE operations.jobs
           SET state='DEAD',finished_at=blink.now(),lease_owner=NULL,lease_until=NULL,
               last_error_code='LEASE_EXPIRED'
           WHERE state='LEASED' AND lease_until<blink.now()
             AND attempt>=max_attempts AND type<>'alert.deliver' AND type=ANY($1::text[])
           RETURNING id
         )
         INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id)
         SELECT gen_random_uuid(),'worker','job.dead',id::text,'LEASE_EXPIRED','job-queue'
         FROM expired`,
        [types],
      );
      const { rows } = await pool.query(
        `WITH due AS (
           SELECT id FROM operations.jobs
           WHERE type=ANY($2::text[])
             AND ((state='QUEUED' AND next_run_at<=blink.now())
               OR (state='LEASED' AND lease_until<blink.now()))
           ORDER BY next_run_at,id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE operations.jobs j
         SET state='LEASED',attempt=j.attempt+1,lease_token=j.lease_token+1,
             lease_owner=$1,lease_until=blink.now()+$3::bigint*interval '1 millisecond'
         FROM due
         WHERE j.id=due.id
         RETURNING j.id,j.type,j.payload,j.attempt,j.max_attempts,j.lease_token`,
        [workerId, types, leaseMs],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        type: row.type,
        payload: row.payload,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        leaseToken: String(row.lease_token),
        workerId,
      };
    },
    async heartbeat(job, leaseMs) {
      positive("lease_ms", leaseMs);
      const { rows } = await pool.query(
        `UPDATE operations.jobs
         SET lease_until=blink.now()+$4::bigint*interval '1 millisecond'
         WHERE id=$1 AND state='LEASED' AND lease_owner=$2 AND lease_token=$3::bigint
           AND lease_until>blink.now()
         RETURNING id`,
        [job.id, job.workerId, job.leaseToken, leaseMs],
      );
      return rows.length === 1;
    },
    async complete(job) {
      const { rows } = await pool.query(
        `UPDATE operations.jobs
         SET state='SUCCEEDED',lease_owner=NULL,lease_until=NULL,finished_at=blink.now()
         WHERE id=$1 AND state='LEASED' AND lease_owner=$2 AND lease_token=$3::bigint
           AND lease_until>blink.now()
         RETURNING id`,
        [job.id, job.workerId, job.leaseToken],
      );
      return rows.length === 1;
    },
    async fail(job, error) {
      // Alert delivery remains pending until acceptance, even past the normal retry ceiling.
      // Dead-lettering and its audit row are one statement, so neither can be lost.
      const { rows } = await pool.query<{ state: "QUEUED" | "DEAD" }>(
        `WITH updated AS (
           UPDATE operations.jobs
           SET state=CASE WHEN $4::boolean AND (attempt<max_attempts OR type='alert.deliver') THEN 'QUEUED' ELSE 'DEAD' END,
               next_run_at=CASE WHEN $4::boolean AND (attempt<max_attempts OR type='alert.deliver')
                 THEN blink.now()+$5::bigint*interval '1 millisecond' ELSE next_run_at END,
               finished_at=CASE WHEN $4::boolean AND (attempt<max_attempts OR type='alert.deliver') THEN NULL ELSE blink.now() END,
               lease_owner=NULL,lease_until=NULL,last_error_code=$6::text
           WHERE id=$1 AND state='LEASED' AND lease_owner=$2 AND lease_token=$3::bigint
             AND lease_until>blink.now()
           RETURNING id,state
         ), audit AS (
           INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id)
           SELECT $7::uuid,'worker','job.dead',id::text,$6::text,'job-queue'
           FROM updated WHERE state='DEAD'
         )
         SELECT state FROM updated`,
        [
          job.id,
          job.workerId,
          job.leaseToken,
          error.retryable,
          retryDelayMs(job.attempt),
          error.code,
          randomUUID(),
        ],
      );
      const state = rows[0]?.state;
      return state === "QUEUED" ? "RETRY" : state === "DEAD" ? "DEAD" : "STALE";
    },
    async stats() {
      const { rows } = await pool.query<{
        queued: number;
        leased: number;
        dead: number;
      }>(
        `SELECT count(*) FILTER (WHERE state='QUEUED')::int AS queued,
                count(*) FILTER (WHERE state='LEASED')::int AS leased,
                count(*) FILTER (WHERE state='DEAD')::int AS dead
         FROM operations.jobs`,
      );
      return rows[0]!;
    },
  };
}

/** The worker may only be a plain blink_worker login: no owner, admin or other runtime role. */
export async function assertWorkerRuntimeRole(client: Db) {
  await assertRuntimeRole(
    client,
    "blink_worker",
    "UNSAFE_WORKER_DATABASE_ROLE",
  );
}

export async function assertJobsMigrationInstalled(client: Db) {
  try {
    await client.query("SELECT max_attempts FROM operations.jobs LIMIT 0");
  } catch (error) {
    const code = (error as { code?: string }).code;
    // 42703 undefined column, 42P01 undefined table, 3F000 undefined schema.
    if (code === "42703" || code === "42P01" || code === "3F000")
      throw new Error("JOBS_BUDGETS_MIGRATION_REQUIRED");
    throw error;
  }
}
