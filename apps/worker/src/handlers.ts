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
import type { OutboxMapping } from "@blink/adapters";

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
