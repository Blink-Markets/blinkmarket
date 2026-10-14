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
