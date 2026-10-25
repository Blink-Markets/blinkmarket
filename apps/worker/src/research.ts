import type { Pool } from "pg";
import type { JobType, WindowSchedule } from "@blink/domain";
import type { JobHandler, JobQueue, ProtocolReader } from "@blink/ports";
import { postgresForecastStore } from "@blink/adapters";
import {
  createForecastScheduleHandler,
  createWindowScheduler,
  schedulePeriodic,
} from "@blink/application";

// Windows close (and their roots appear) within this long after their deadline.
const FORECAST_SCHEDULE_EVERY_MS = 30_000;

/**
 * Forecast window scheduling and closing: agents submit their own signed forecasts through the
 * public API; the platform runs no forecaster of its own, and it computes and stores window roots
 * but never anchors them. `tick` enqueues the periodic job (deduplicated per interval, so any
 * number of workers may call it).
 */
export function buildResearch(deps: {
  pool: Pool;
  queue: JobQueue;
  /** The deployment's index reader; markets and their state come from it. */
  reader: Pick<ProtocolReader, "markets">;
  /** Windows belong to one deployment; without one there is nothing to schedule. */
  deploymentId: string | null;
  schedule: WindowSchedule;
}): {
  handlers: Partial<Record<JobType, JobHandler>>;
  tick(): Promise<void>;
} {
  const { pool, queue } = deps;
  return {
    handlers: {
      "forecast.schedule": createForecastScheduleHandler(
        createWindowScheduler(
          postgresForecastStore(pool, deps.deploymentId ?? ""),
          deps.reader,
          deps.schedule,
        ),
      ),
    },
    // Business time is the database clock, also for the interval buckets.
    async tick() {
      const { rows } = await pool.query("SELECT blink.now() AS now");
      await schedulePeriodic(
        queue,
        "forecast.schedule",
        FORECAST_SCHEDULE_EVERY_MS,
        {},
        new Date(rows[0].now),
      );
    },
  };
}
