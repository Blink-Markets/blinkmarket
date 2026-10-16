import type { Pool } from "pg";
import type { HealthReader } from "@blink/ports";
import { AdminMetricsResponse } from "@blink/schemas";
import { DeploymentManifest } from "@blink/schemas";
import { indexerStaleSql } from "./market-read-store.js";
import { createUnitOfWork } from "./database.js";

const DEFAULT_ALERT_STALL_MS = 15 * 60_000;

// The conditions behind INDEXER_LAG, BUDGET_GATE_CLOSED and POOL_GATE_CLOSED. alert.evaluate
// judges the same SQL, so an alert and a health reason can never disagree.
export const INDEXER_FRESH_SQL = `(NOT (${indexerStaleSql("c")}) AND gate_reason IS NULL AND head_number-block_number<=3)`;
/** A budgets.daily row `d` whose gate is closed or whose cap is used up. */
export const DAILY_BUDGET_CLOSED_SQL = `(d.gate_closed_reason IS NOT NULL OR d.cap_usd_micros <= COALESCE((
               SELECT SUM(CASE r.state WHEN 'RECONCILED' THEN r.actual_usd_micros WHEN 'RELEASED' THEN 0 ELSE r.max_usd_micros END)
               FROM budgets.reservations r WHERE r.day=d.day),0))`;
export const POOL_GATE_CLOSED_SQL =
  "SELECT gate_reason FROM trading.maker_pools WHERE deployment_id=$1 AND gate_reason IS NOT NULL";

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
        const poolClosed =
          (
            await db.query(
              POOL_GATE_CLOSED_SQL,
              [deploymentId],
            )
          ).rows.length > 0;
        const reconcile =
          (
            await db.query(
              `SELECT 1 FROM trading.collateral_reservations r WHERE deployment_id=$1 AND
          (state='RECONCILE_REQUIRED' OR (state IN ('ACCOUNTED','RELEASED') AND state_block_hash IS NOT NULL AND
            NOT EXISTS (SELECT 1 FROM chain.blocks b WHERE b.deployment_id=r.deployment_id AND b.hash=r.state_block_hash AND b.canonical))) LIMIT 1`,
              [deploymentId],
            )
          ).rows.length > 0;
        const queue = (
          await db.query<Count>(
            `SELECT 'DEAD' AS name,count(*)::text AS count FROM operations.jobs WHERE state='DEAD'
             UNION ALL SELECT 'LEASED',count(*)::text FROM operations.jobs WHERE state='LEASED'
             UNION ALL SELECT 'QUEUED',count(*)::text FROM operations.jobs WHERE state='QUEUED'`,
          )
        ).rows;
        const budget = (
          await db.query<{ daily_closed: boolean; questions_closed: string }>(
            `SELECT EXISTS(SELECT 1 FROM budgets.daily d WHERE d.day=(blink.now() AT TIME ZONE 'UTC')::date
             AND ${DAILY_BUDGET_CLOSED_SQL}) AS daily_closed,
           (SELECT count(*)::text FROM budgets.questions WHERE gate_closed_reason IS NOT NULL) AS questions_closed`,
          )
        ).rows[0]!;
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
        if (
          !deployment?.enabled ||
          !manifest.success ||
          !manifest.data.tradingEnabled
        )
          reasons.push("TRADING_DISABLED");
        if (!fresh) reasons.push("INDEXER_LAG");
        if (poolClosed) reasons.push("POOL_GATE_CLOSED");
        if (reconcile) reasons.push("RECONCILE_REQUIRED");
        // Research budgets are reported, but question-specific gates do not close all trading.
        if (budget.daily_closed) reasons.push("BUDGET_GATE_CLOSED");
        return {
          reasons,
          details: {
            queue,
            chainIndex: {
              blockNumber: cursor?.block_number ?? null,
              headNumber: cursor?.head_number ?? null,
              fresh,
            },
            budgetGates: {
              dailyClosed: budget.daily_closed,
              questionsClosed: budget.questions_closed,
            },
            poolGate: { closed: poolClosed, reconcileRequired: reconcile },
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
        const latency = async (sql: string) => {
          const row = (
            await db.query<{
              samples: string;
              p50: number | null;
              p95: number | null;
            }>(
              `SELECT count(*)::text AS samples, percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95 FROM (${sql}) samples`,
            )
          ).rows[0]!;
          return { samples: row.samples, p50Ms: row.p50, p95Ms: row.p95 };
        };
        const rfqLatency = await latency(
          "SELECT EXTRACT(EPOCH FROM (signed_at-created_at))*1000 AS ms FROM trading.quotes WHERE signed_at>=created_at",
        );
        const txInclusionLatency = await latency(
          "SELECT EXTRACT(EPOCH FROM (included_at-submitted_at))*1000 AS ms FROM signing.tx_attempts WHERE included_at>=submitted_at AND status IN ('INCLUDED','FINALIZED','REVERTED')",
        );
        const counts = async (sql: string) => (await db.query<Count>(sql)).rows;
        return AdminMetricsResponse.parse({
          rfqLatency,
          txInclusionLatency,
          counts: {
            quotes: await counts(
              "SELECT status AS name,count(*)::text AS count FROM trading.quotes GROUP BY status ORDER BY status",
            ),
            transactions: await counts(
              "SELECT status AS name,count(*)::text AS count FROM signing.tx_attempts GROUP BY status ORDER BY status",
            ),
            jobs: await counts(
              "SELECT state AS name,count(*)::text AS count FROM operations.jobs GROUP BY state ORDER BY state",
            ),
            errors: await counts(`SELECT name,count(*)::text AS count FROM (
              SELECT 'signer:' || reject_code AS name FROM signing.sign_requests WHERE reject_code IS NOT NULL
              UNION ALL SELECT 'job:' || last_error_code FROM operations.jobs WHERE last_error_code IS NOT NULL
              UNION ALL SELECT 'transaction:' || reject_reason FROM chain.transactions WHERE reject_reason IS NOT NULL
            ) errors GROUP BY name ORDER BY name`),
          },
          gasSpent: (
            await db.query(
              'SELECT role,day::text AS day,spent_wei::text AS "spentWei",reserved_wei::text AS "reservedWei" FROM signing.gas_spend ORDER BY day,role',
            )
          ).rows,
        });
      });
    },
  };
}
