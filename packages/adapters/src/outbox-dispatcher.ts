import type { Pool } from "pg";
import type { JobSpec } from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import { alertPayload } from "./alert-payload.js";
import { insertJob } from "./job-queue.js";

export interface OutboxEvent {
  id: string;
  type: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}
/**
 * A mapped job normally gets its own `outbox:<id>:<jobType>` dedupe key. `coalesce` keeps the
 * spec's own key instead, so a burst of events (one per block) can share one pending job.
 */
export type OutboxJobSpec = JobSpec & { coalesce?: boolean };
export type OutboxMapping = Record<
  string,
  (event: OutboxEvent) => OutboxJobSpec[]
>;

/**
 * Turns undispatched outbox events into jobs. Jobs and the dispatched mark commit
 * together, and the `outbox:<id>:<jobType>` dedupe key keeps a replay from
 * duplicating a job. All alert.* events route to delivery. Other unmapped events
 * are marked dispatched with no jobs.
 * Returns the number of events dispatched; a result equal to `batch` means more may wait.
 */
export async function dispatchOutbox(
  pool: Pool,
  mapping: OutboxMapping,
  batch = 100,
): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000)
    throw new Error("INVALID_OUTBOX_BATCH");
  const uow = createUnitOfWork(pool);
  return uow.run(async (tx) => {
    const db = uow.client(tx);
    const { rows } = await db.query<{
      id: string;
      event_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id,event_type,aggregate_id,payload FROM operations.outbox
       WHERE dispatched_at IS NULL
       ORDER BY created_at,id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [batch],
    );
    for (const row of rows) {
      const map = Object.hasOwn(mapping, row.event_type)
        ? mapping[row.event_type]
        : undefined;
      const specs = row.event_type.startsWith("alert.")
        ? [
            {
              type: "alert.deliver" as const,
              dedupeKey: `alert:${row.id}`,
              payload: { ...alertPayload(row.id, row.event_type, row.payload) },
            },
          ]
        : (map?.({
            id: row.id,
            type: row.event_type,
            aggregateId: row.aggregate_id,
            payload: row.payload,
          }) ?? []);
      for (const { coalesce, ...spec } of specs)
        await insertJob(
          db,
          coalesce
            ? spec
            : { ...spec, dedupeKey: `outbox:${row.id}:${spec.type}` },
          row.id,
        );
    }
    if (rows.length > 0)
      await db.query(
        "UPDATE operations.outbox SET dispatched_at=blink.now() WHERE id=ANY($1::uuid[])",
        [rows.map((row) => row.id)],
      );
    return rows.length;
  });
}
