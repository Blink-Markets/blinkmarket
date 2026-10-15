import {
  postgresResolutionJobsStore,
  fileObjectStore,
  resolutionEvidenceReader,
} from "@blink/adapters";
import {
  createResolutionParseHandler,
  createResolutionAlertHandler,
} from "@blink/application";
import { JobError } from "@blink/domain";
import type { Pool } from "pg";
import { postgresEvaluationStore, postgresJobQueue } from "@blink/adapters";
import { createEvaluationHandler, schedulePeriodic } from "@blink/application";
import type { JobType } from "@blink/domain";
import type { JobHandler } from "@blink/ports";
import type { OutboxEvent, OutboxMapping } from "@blink/adapters";
import { postgresTradingStore } from "@blink/adapters";
import {
  createQuoteReconcileHandler,
  createQuoteReconciler,
} from "@blink/application";

// Worker tasks register their job handlers and outbox-event mappings here.
export const handlers: Partial<Record<JobType, JobHandler>> = {};
export const outboxMapping: OutboxMapping = {};

export function registerEvaluationHandler(pool: Pool): void {
  handlers["evaluation.score"] = createEvaluationHandler(
    postgresEvaluationStore(pool),
  );
}
outboxMapping["market.indexed"] = () => [
  {
    type: "evaluation.score",
    dedupeKey: "evaluation.score",
    payload: {},
  },
];
// FINAL eligibility is checked against the projection, never trusted from an event payload.
export async function scheduleEvaluation(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ now: Date }>("SELECT blink.now() AS now");
  await schedulePeriodic(
    postgresJobQueue(pool),
    "evaluation.score",
    600_000,
    {},
    rows[0]!.now,
  );
}

export function registerResolutionHandlers(
  pool: Pool,
  evidenceDirectory?: string,
): void {
  const store = postgresResolutionJobsStore(pool);
  const readText = evidenceDirectory
    ? resolutionEvidenceReader(fileObjectStore(evidenceDirectory))
    : async () => {
        throw new JobError("EVIDENCE_OBJECT_DIRECTORY_REQUIRED", false);
      };
  handlers["resolution.parse"] = createResolutionParseHandler(store, readText);
  handlers["resolution.alerts"] = createResolutionAlertHandler(store);
}
export async function scheduleResolution(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ now: Date }>("SELECT blink.now() AS now");
  const queue = postgresJobQueue(pool);
  for (const type of ["resolution.parse", "resolution.alerts"] as const)
    await schedulePeriodic(queue, type, 60_000, {}, rows[0]!.now);
}
// Research jobs (evidence, discovery, forecasts) are composed in ./research.ts.
export { buildResearch } from "./research.js";

export { buildExecution } from "./execution.js";
export { buildTrader } from "./trader.js";
// --- quote.reconcile (RFQ reservations against the canonical chain, Task 9) ---
export function registerQuoteReconcile(pool: Pool): void {
  handlers["quote.reconcile"] = createQuoteReconcileHandler(
    createQuoteReconciler(postgresTradingStore(pool)),
  );
}
// chain.synced arrives with every block the indexer advances: one job per deployment and time
// bucket serves all of them, and it starts after the bucket ends so it sees the newest cursor.
export const QUOTE_RECONCILE_BUCKET_MS = 2000;
export function quoteReconcileJobs(event: OutboxEvent, now = Date.now()) {
  const deploymentId = event.payload.deploymentId;
  if (typeof deploymentId !== "string" || deploymentId === "") return [];
  const bucket = Math.floor(now / QUOTE_RECONCILE_BUCKET_MS);
  return [
    {
      type: "quote.reconcile" as const,
      dedupeKey: `quote.reconcile:${deploymentId}:${bucket}`,
      payload: { deploymentId },
      runAt: new Date((bucket + 1) * QUOTE_RECONCILE_BUCKET_MS),
      coalesce: true,
    },
  ];
}
// Added next to any mapping another task registered for the same event.
for (const type of ["chain.synced", "chain.reorged"]) {
  const other = outboxMapping[type];
  outboxMapping[type] = (event) => [
    ...(other?.(event) ?? []),
    ...quoteReconcileJobs(event),
  ];
}
// Backstop for lost events and for the gate that only a later pass clears: every 5 seconds, for
// each deployment that still holds reservations or a gated pool.
export async function scheduleQuoteReconcile(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ deployment_id: string; now: Date }>(
    `SELECT d.deployment_id, blink.now() AS now FROM (
       SELECT deployment_id FROM trading.collateral_reservations WHERE state IN ('HELD','RECONCILE_REQUIRED')
       UNION SELECT deployment_id FROM trading.maker_pools WHERE gate_reason IS NOT NULL) d`,
  );
  const queue = postgresJobQueue(pool);
  for (const row of rows)
    await schedulePeriodic(
      queue,
      "quote.reconcile",
      5000,
      { deploymentId: row.deployment_id },
      row.now,
    );
}
