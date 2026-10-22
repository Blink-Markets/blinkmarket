import type { Pool } from "pg";

// Finished jobs are pruned after 7 days (SUCCEEDED) or 30 days (DEAD). Outbox rows go after 30
// days once dispatched, unreferenced by any job, and superseded by a newer version of the same
// aggregate and event type (a restore reads the newest to continue the version sequence).
const JOBS = `DELETE FROM operations.jobs WHERE id IN (
  SELECT id FROM operations.jobs
  WHERE (state='SUCCEEDED' AND finished_at < blink.now() - interval '7 days')
     OR (state='DEAD' AND finished_at < blink.now() - interval '30 days')
  LIMIT $1)`;
const OUTBOX = `DELETE FROM operations.outbox WHERE id IN (
  SELECT o.id FROM operations.outbox o
  WHERE o.dispatched_at < blink.now() - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM operations.jobs j WHERE j.outbox_id = o.id)
    AND EXISTS (SELECT 1 FROM operations.outbox n
                WHERE n.aggregate_id = o.aggregate_id AND n.event_type = o.event_type
                  AND n.event_version > o.event_version)
  LIMIT $1)`;

export async function pruneOperations(
  pool: Pool,
  options: { batch?: number; maxBatches?: number } = {},
): Promise<{ jobs: number; outbox: number }> {
  const batch = options.batch ?? 1000;
  const maxBatches = options.maxBatches ?? 20;
  const run = async (sql: string) => {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const { rowCount } = await pool.query(sql, [batch]);
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < batch) break;
    }
    return total;
  };
  const jobs = await run(JOBS);
  return { jobs, outbox: await run(OUTBOX) };
}
