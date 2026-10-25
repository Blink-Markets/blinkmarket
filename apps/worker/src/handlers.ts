import type { Pool } from "pg";
import {
  postgresEvaluationStore,
  postgresJobQueue,
  pruneOperations,
} from "@blink/adapters";
import { createEvaluationHandler, schedulePeriodic } from "@blink/application";
import type { JobType } from "@blink/domain";
import type { JobHandler, ProtocolReader } from "@blink/ports";
import type { OutboxMapping } from "@blink/adapters";
import { postgresAlertEvaluateStore, httpRpcProbe } from "@blink/adapters";
import { createAlertEvaluateHandler } from "@blink/application";
import type { AlertEvaluateConfig } from "./config.js";

// Worker tasks register their job handlers and outbox-event mappings here.
export const handlers: Partial<Record<JobType, JobHandler>> = {};
export const outboxMapping: OutboxMapping = {};

/** Without a deployment (empty id) there is no market to read, so scoring finds nothing to do. */
export function registerEvaluationHandler(
  pool: Pool,
  reader: Pick<ProtocolReader, "markets" | "proposal">,
  deploymentId: string | null,
): void {
  const id = deploymentId ?? "";
  handlers["evaluation.score"] = createEvaluationHandler({
    store: postgresEvaluationStore(pool, id),
    reader,
    deploymentId: id,
  });
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

// --- alert.evaluate (pause, RPC, indexer lag, dead jobs) ---
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
// The forecast window scheduler is composed in ./research.ts.
export { buildResearch } from "./research.js";
