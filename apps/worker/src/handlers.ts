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
import {
  postgresEvaluationStore,
  postgresJobQueue,
  pruneOperations,
} from "@blink/adapters";
import { createEvaluationHandler, schedulePeriodic } from "@blink/application";
import type { JobType } from "@blink/domain";
import type { JobHandler } from "@blink/ports";
import type { OutboxMapping } from "@blink/adapters";
import { postgresAlertEvaluateStore, httpRpcProbe } from "@blink/adapters";
import { createAlertEvaluateHandler } from "@blink/application";
import type { AlertEvaluateConfig } from "./config.js";

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

export function registerOperationsPrune(pool: Pool): void {
  handlers["operations.prune"] = async () => {
    await pruneOperations(pool);
  };
}
export async function scheduleOperationsPrune(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ now: Date }>("SELECT blink.now() AS now");
  await schedulePeriodic(
    postgresJobQueue(pool),
    "operations.prune",
    3_600_000,
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
// --- alert.evaluate (budget, pause, RPC, indexer lag, dead jobs: Task A4b) ---
export function registerAlertEvaluate(
  pool: Pool,
  config: AlertEvaluateConfig,
  /** Test seam: a single-connection pool cannot hold the job lock. */
  storeOptions: { jobLock?: boolean } = {},
): void {
  handlers["alert.evaluate"] = createAlertEvaluateHandler({
    store: postgresAlertEvaluateStore(pool, {
      onError: (code) => console.error(code),
      ...storeOptions,
    }),
    rpc: config.rpcUrl ? httpRpcProbe(config.rpcUrl) : null,
    policy: { reAlertMs: config.reAlertMs, rpcFailures: config.rpcFailures },
    deploymentIds: config.deploymentIds,
    onSkip: (code) => console.error(code),
  });
}
// Every minute (a bucket of the business clock); RPC failures are counted one per evaluation.
export async function scheduleAlertEvaluate(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ now: Date }>("SELECT blink.now() AS now");
  await schedulePeriodic(
    postgresJobQueue(pool),
    "alert.evaluate",
    60_000,
    {},
    rows[0]!.now,
  );
}
// Research jobs (evidence, discovery, forecasts) are composed in ./research.ts.
export { buildResearch } from "./research.js";
