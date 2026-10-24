import type { Pool } from "pg";
import type { JobType } from "@blink/domain";
import type { JobHandler, JobQueue } from "@blink/ports";
import { postgresForecastStore } from "@blink/adapters";
import {
  createForecastScheduleHandler,
  createWindowScheduler,
  schedulePeriodic,
} from "@blink/application";

const FORECAST_SCHEDULE_EVERY_MS = 5 * 60_000;

/**
 * Forecast window scheduling: it needs only the database, so it always runs. Agents submit their
 * own forecasts through the public API; the platform runs no forecaster of its own. `tick`
 * enqueues the periodic job (deduplicated per interval, so any number of workers may call it).
 */
export function buildResearch(deps: { pool: Pool; queue: JobQueue }): {
  handlers: Partial<Record<JobType, JobHandler>>;
  tick(): Promise<void>;
} {
  const { pool, queue } = deps;
  return {
    handlers: {
      "forecast.schedule": createForecastScheduleHandler(
        createWindowScheduler(postgresForecastStore(pool)),
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
