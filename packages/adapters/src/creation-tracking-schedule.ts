import type { Pool } from "pg";
import { CreationChainStatus } from "@blink/schemas";
import type {
  CreationTrackingBacklog,
  CreationTrackingLease,
  CreationTrackingSchedule,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";

function validateDelay(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000)
    throw new Error("INVALID_CREATION_TRACKING_" + name.toUpperCase());
}

export function postgresCreationTrackingSchedule(
  pool: Pool,
): CreationTrackingSchedule {
  const uow = createUnitOfWork(pool);
  return {
    claim: async (workerId, leaseMs) => {
      if (!workerId || workerId.length > 128)
        throw new Error("INVALID_CREATION_TRACKING_WORKER_ID");
      validateDelay("lease_ms", leaseMs);
      return uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const result = await db.query(
          `SELECT s.intent_id,s.lease_token,s.attempt,p.payload
           FROM chain.creation_tracking_schedule s
           JOIN chain.creation_projections p ON p.intent_id=s.intent_id
           JOIN markets.deployments d ON d.id=p.deployment_id
           WHERE d.enabled
             AND p.payload->>'txHash' IS NOT NULL
             AND s.next_run_at<=clock_timestamp()
             AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp())
           ORDER BY s.next_run_at,s.intent_id
           FOR UPDATE OF s SKIP LOCKED
           LIMIT 1`,
        );
        const row = result.rows[0];
        if (!row) return null;
        const status = CreationChainStatus.parse(row.payload);
        if (!status.txHash) return null;
        const updated = await db.query(
          `UPDATE chain.creation_tracking_schedule
           SET lease_owner=$2,
               lease_until=clock_timestamp()+$3::bigint*interval '1 millisecond',
               lease_token=lease_token+1,
               last_attempt_at=clock_timestamp()
           WHERE intent_id=$1
           RETURNING lease_token`,
          [row.intent_id, workerId, leaseMs],
        );
        return {
          intentId: String(row.intent_id),
          txHash: status.txHash,
          workerId,
          leaseToken: String(updated.rows[0]!.lease_token),
          attempt: Number(row.attempt),
        };
      });
    },
    complete: async (lease, nextPollDelayMs) => {
      validateDelay("next_poll_delay_ms", nextPollDelayMs);
      const result = await pool.query(
        `UPDATE chain.creation_tracking_schedule
         SET next_run_at=clock_timestamp()+$4::bigint*interval '1 millisecond',
             attempt=0,last_error_code=NULL,lease_owner=NULL,lease_until=NULL,
             last_success_at=clock_timestamp()
         WHERE intent_id=$1 AND lease_owner=$2 AND lease_token=$3
           AND lease_until>clock_timestamp()`,
        [lease.intentId, lease.workerId, lease.leaseToken, nextPollDelayMs],
      );
      return result.rowCount === 1;
    },
    fail: async (lease, errorCode, retryDelayMs) => {
      validateDelay("retry_delay_ms", retryDelayMs);
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode))
        throw new Error("INVALID_CREATION_TRACKING_ERROR_CODE");
      const result = await pool.query(
        `UPDATE chain.creation_tracking_schedule
         SET next_run_at=clock_timestamp()+$4::bigint*interval '1 millisecond',
             attempt=attempt+1,last_error_code=$5,lease_owner=NULL,lease_until=NULL
         WHERE intent_id=$1 AND lease_owner=$2 AND lease_token=$3
           AND lease_until>clock_timestamp()`,
        [
          lease.intentId,
          lease.workerId,
          lease.leaseToken,
          retryDelayMs,
          errorCode,
        ],
      );
      return result.rowCount === 1;
    },
    health: async (): Promise<CreationTrackingBacklog> => {
      const result = await pool.query<{
        tracked: string;
        due: string;
        leased: string;
        failing: string;
        oldest_due_at: Date | string | null;
      }>(
        `SELECT count(*)::text AS tracked,
           count(*) FILTER (WHERE s.next_run_at<=clock_timestamp()
             AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp()))::text AS due,
           count(*) FILTER (WHERE s.lease_until>clock_timestamp())::text AS leased,
           count(*) FILTER (WHERE s.attempt>0)::text AS failing,
           min(s.next_run_at) FILTER (WHERE s.next_run_at<=clock_timestamp()
             AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp())) AS oldest_due_at
         FROM chain.creation_tracking_schedule s
         JOIN chain.creation_projections p ON p.intent_id=s.intent_id
         JOIN markets.deployments d ON d.id=p.deployment_id
         WHERE d.enabled AND p.payload->>'txHash' IS NOT NULL`,
      );
      const row = result.rows[0]!;
      return {
        tracked: Number(row.tracked),
        due: Number(row.due),
        leased: Number(row.leased),
        failing: Number(row.failing),
        oldestDueAt: row.oldest_due_at
          ? new Date(row.oldest_due_at).toISOString()
          : null,
      };
    },
  };
}

export async function assertCreationTrackingRuntimeRole(pool: Pool) {
  const result = await pool.query(
    `SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
       AND pg_has_role(current_user,'blink_indexer','USAGE')
       AND NOT pg_has_role(current_user,'blink_api','USAGE')
       AND NOT pg_has_role(current_user,'blink_deployment_admin','USAGE')
       AND NOT pg_has_role(current_user,'blink_identity_admin','USAGE')
       AND NOT pg_has_role(current_user,'blink_evidence_admin','USAGE')
       AND NOT has_schema_privilege(current_user,'chain','CREATE') AS allowed
     FROM pg_roles WHERE rolname=current_user`,
  );
  if (result.rows[0]?.allowed !== true)
    throw new Error("UNSAFE_INDEXER_DATABASE_ROLE");
}

export async function assertCreationTrackingScheduleInstalled(pool: Pool) {
  try {
    await pool.query("SELECT intent_id FROM chain.creation_tracking_schedule LIMIT 0");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "42P01" || error.code === "3F000")
    )
      throw new Error("CREATION_TRACKING_SCHEDULE_MIGRATION_REQUIRED");
    throw error;
  }
}

export async function assertCreationTrackingMigrationsInstalled(pool: Pool) {
  try {
    await pool.query("SELECT intent_id FROM chain.creation_projections LIMIT 0");
  } catch (error) {
    if (isMissingRelation(error))
      throw new Error("CREATION_TRACKING_BASE_MIGRATION_REQUIRED");
    throw error;
  }
  await assertCreationTrackingScheduleInstalled(pool);
}

function isMissingRelation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "42P01" || error.code === "3F000")
  );
}
