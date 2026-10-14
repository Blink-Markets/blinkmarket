import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Pool } from "pg";
import type { JobType, PlatformRole } from "@blink/domain";
import type { JobHandler, JobQueue } from "@blink/ports";
import {
  allowlistFetcher,
  fileObjectStore,
  httpsTransport,
  keccak256Hex,
  loadModelFixtureGateway,
  postgresBudgetLedger,
  postgresDiscoveryStore,
  postgresEvidenceFetchStore,
  postgresForecastStore,
  postgresPlatformRunStore,
} from "@blink/adapters";
import {
  createBudgetedModelCaller,
  createDiscoveryHandler,
  createDiscoveryScheduler,
  createEvidenceFetchHandler,
  createForecastDispatchHandler,
  createForecastRunHandler,
  createForecastScheduleHandler,
  createWindowScheduler,
  schedulePeriodic,
} from "@blink/application";
import { createBlinkClient } from "@blink/client";
import type { ResearchConfig } from "./config.js";

const FORECAST_SCHEDULE_EVERY_MS = 5 * 60_000;
const FORECAST_DISPATCH_EVERY_MS = 60_000;

/**
 * The research side of the worker: evidence fetching, discovery, forecast scheduling and the
 * platform forecasters. Window scheduling needs only the database, so it always runs; every
 * other job is registered only when its configuration is present. `tick` enqueues the
 * periodic jobs (deduplicated per interval, so any number of workers may call it).
 */
export async function buildResearch(deps: {
  pool: Pool;
  queue: JobQueue;
  config: ResearchConfig;
}): Promise<{
  handlers: Partial<Record<JobType, JobHandler>>;
  tick(): Promise<void>;
}> {
  const { pool, queue, config } = deps;
  const jobs: Partial<Record<JobType, JobHandler>> = {};
  // Business time is the database clock, also for the interval buckets.
  const now = async () =>
    new Date((await pool.query("SELECT blink.now() AS now")).rows[0].now);
  const periodic: (() => Promise<unknown>)[] = [
    async () =>
      schedulePeriodic(
        queue,
        "forecast.schedule",
        FORECAST_SCHEDULE_EVERY_MS,
        {},
        await now(),
      ),
  ];
  jobs["forecast.schedule"] = createForecastScheduleHandler(
    createWindowScheduler(postgresForecastStore(pool)),
  );
  const tick = async () => {
    for (const task of periodic) await task();
  };

  const evidence = config.evidence;
  if (!evidence) return { handlers: jobs, tick };
  const objects = fileObjectStore(evidence.directory);
  const fetchEvidence = createEvidenceFetchHandler({
    store: postgresEvidenceFetchStore(pool),
    fetcher: allowlistFetcher({
      resolve: async (host) =>
        (await lookup(host, { all: true })).map((entry) => ({
          address: entry.address,
          family: entry.family === 6 ? 6 : 4,
        })),
      transport: httpsTransport(),
    }),
    objects,
    hash: keccak256Hex,
    platformOperatorId: evidence.platformOperatorId,
  });
  jobs["evidence.fetch"] = fetchEvidence;

  if (config.api && config.modelFixtures) {
    const apiUrl = config.api.url;
    const model = createBudgetedModelCaller({
      ledger: postgresBudgetLedger(pool),
      gateway: await loadModelFixtureGateway(config.modelFixtures),
    });
    if (config.discovery) {
      const store = postgresDiscoveryStore(pool);
      jobs["discovery.scan"] = createDiscoveryHandler({
        store,
        fetchEvidence: ({ jobId, sourceId, signal }) =>
          fetchEvidence({ job: { id: jobId, payload: { sourceId } }, signal }),
        objects,
        model,
        modelName: config.discovery.model,
        api: createBlinkClient(apiUrl, config.discovery.apiKey),
        hash: keccak256Hex,
        newId: randomUUID,
      });
      const scheduler = createDiscoveryScheduler({ store, queue });
      periodic.push(() => scheduler.scheduleOnce());
    }
    const roles = Object.keys(config.forecasters) as PlatformRole[];
    if (roles.length > 0) {
      const store = postgresPlatformRunStore(pool);
      const apis = Object.fromEntries(
        roles.map((role) => [
          role,
          createBlinkClient(apiUrl, config.forecasters[role]),
        ]),
      );
      const run = (allowed: readonly PlatformRole[]) =>
        createForecastRunHandler({
          roles: allowed,
          store,
          objects,
          model,
          apis,
          hash: keccak256Hex,
          newId: randomUUID,
        });
      // The two forecasters share one job type, so config accepts them only as a pair.
      if (roles.includes("FORECASTER_A") && roles.includes("FORECASTER_B"))
        jobs["forecast.run"] = run(["FORECASTER_A", "FORECASTER_B"]);
      if (roles.includes("BASELINE")) jobs["baseline.run"] = run(["BASELINE"]);
      jobs["forecast.dispatch"] = createForecastDispatchHandler({
        store,
        queue,
        roles,
      });
      periodic.push(async () =>
        schedulePeriodic(
          queue,
          "forecast.dispatch",
          FORECAST_DISPATCH_EVERY_MS,
          {},
          await now(),
        ),
      );
    }
  }
  return { handlers: jobs, tick };
}
