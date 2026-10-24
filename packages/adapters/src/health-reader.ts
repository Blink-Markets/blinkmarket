import type { Pool } from "pg";
import type { HealthReader } from "@blink/ports";
import { AdminMetricsResponse } from "@blink/schemas";
import { DeploymentManifest } from "@blink/schemas";
import { indexerStaleSql } from "./market-read-store.js";
import { createUnitOfWork } from "./database.js";

const DEFAULT_ALERT_STALL_MS = 15 * 60_000;

// The condition behind INDEXER_LAG. alert.evaluate
// judges the same SQL, so an alert and a health reason can never disagree.
export const INDEXER_MAX_LAG_BLOCKS = 3;
export const INDEXER_FRESH_SQL = `(NOT (${indexerStaleSql("c")}) AND gate_reason IS NULL AND head_number-block_number<=${INDEXER_MAX_LAG_BLOCKS})`;
export const INDEXER_LAGGING_SQL = `head_number-block_number>${INDEXER_MAX_LAG_BLOCKS}`;
type Count = { name: string; count: string };
export function postgresHealthReader(
  pool: Pool,
  deploymentId: string,
  options: { alertStallMs?: number } = {},
): HealthReader {
  const alertStallMs = options.alertStallMs ?? DEFAULT_ALERT_STALL_MS;
  if (!Number.isSafeInteger(alertStallMs) || alertStallMs < 1)
    throw new Error("INVALID_ALERT_STALL_MS");
  const uow = createUnitOfWork(pool);
  return {
    async health() {
      return uow.run(async (tx) => {
        const db = uow.client(tx);
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const deployment = (
          await db.query(
            "SELECT manifest,enabled FROM markets.deployments WHERE id=$1",
            [deploymentId],
          )
        ).rows[0];
        const manifest = DeploymentManifest.safeParse(deployment?.manifest);
        const cursor = (
          await db.query(
            `SELECT block_number::text,head_number::text,
          ${INDEXER_FRESH_SQL} AS fresh
          FROM chain.cursors c WHERE deployment_id=$1`,
            [deploymentId],
          )
        ).rows[0];
        const fresh = cursor?.fresh === true;
        const queue = (
          await db.query<Count>(
            `SELECT 'DEAD' AS name,count(*)::text AS count FROM operations.jobs WHERE state='DEAD'
             UNION ALL SELECT 'LEASED',count(*)::text FROM operations.jobs WHERE state='LEASED'
             UNION ALL SELECT 'QUEUED',count(*)::text FROM operations.jobs WHERE state='QUEUED'`,
          )
        ).rows;
        // Undelivered (counted from creation) after the threshold, with or without a recorded error, so a
        // hung first attempt counts too: informational only.
        const alerts = (
          await db.query<{ count: string; oldest: string | null }>(
            `SELECT count(*)::text AS count,
                    floor(extract(epoch FROM blink.now()-min(created_at)))::text AS oldest
             FROM operations.jobs WHERE type='alert.deliver' AND state IN ('QUEUED','LEASED')
               AND created_at<=blink.now()-$1::bigint*interval '1 millisecond'`,
            [alertStallMs],
          )
        ).rows[0]!;
        const reasons: Awaited<ReturnType<HealthReader["health"]>>["reasons"] =
          [];
        if (!deployment?.enabled || !manifest.success)
          reasons.push("SERVICE_NOT_READY");
        if (!fresh) reasons.push("INDEXER_LAG");
        return {
          reasons,
          details: {
            queue,
            chainIndex: {
              blockNumber: cursor?.block_number ?? null,
              headNumber: cursor?.head_number ?? null,
              fresh,
            },
            alerts: {
              stalled: alerts.count !== "0",
              stalledCount: alerts.count,
              oldestStalledSeconds: alerts.oldest,
            },
          },
        };
      });
    },
    async metrics() {
      // Related counters in one transaction; no payloads, addresses, keys or signed bytes are selected.
      return uow.run(async (tx) => {
        const db = uow.client(tx);
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const counts = async (sql: string) => (await db.query<Count>(sql)).rows;
        return AdminMetricsResponse.parse({
          counts: {
            jobs: await counts(
              "SELECT state AS name,count(*)::text AS count FROM operations.jobs GROUP BY state ORDER BY state",
            ),
            errors: await counts(`SELECT name,count(*)::text AS count FROM (
              SELECT 'job:' || last_error_code AS name FROM operations.jobs WHERE last_error_code IS NOT NULL
              UNION ALL SELECT 'transaction:' || reject_reason FROM chain.transactions WHERE reject_reason IS NOT NULL
            ) errors GROUP BY name ORDER BY name`),
          },
        });
      });
    },
  };
}
