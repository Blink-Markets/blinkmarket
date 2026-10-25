import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";
import {
  assertJobsMigrationInstalled,
  assertWorkerRuntimeRole,
  assertProductionClock,
  dispatchOutbox,
  postgresJobQueue,
  postgresProtocolReader,
  staleProtocolReader,
} from "@blink/adapters";
import { createAlertDeliveryHandler } from "@blink/application";
import { createService, startService } from "@blink/runtime";
import { alertSinkFor } from "./alerts.js";
import {
  alertConfig,
  alertEvaluateConfig,
  forecastWorkerConfig,
  workerConfig,
} from "./config.js";
import {
  buildResearch,
  handlers,
  outboxMapping,
  registerAlertEvaluate,
  registerEvaluationHandler,
  registerOperationsPrune,
  scheduleAlertEvaluate,
  scheduleEvaluation,
  scheduleOperationsPrune,
} from "./handlers.js";
import { startJobLoops } from "./loops.js";
import { jobs } from "./registry.js";

const OUTBOX_DISPATCH_INTERVAL_MS = 1000;
const PERIODIC_SCHEDULE_INTERVAL_MS = 15_000;

let pool: pg.Pool | null = null;
let worker: ReturnType<typeof startJobLoops> | null = null;
let outboxTimer: ReturnType<typeof setInterval> | null = null;
let outboxRun: Promise<unknown> = Promise.resolve();
let scheduleTimer: ReturnType<typeof setInterval> | null = null;
let scheduleRun: Promise<unknown> = Promise.resolve();

try {
  const config = workerConfig(process.env);
  // Validated before anything connects: a bad window schedule stops the worker at startup.
  const forecast = forecastWorkerConfig(process.env);
  // Not ready until the job loop is actually running; disabled means liveness only.
  const app = createService("worker", "m3-jobs", async () => {
    if (!pool) return false;
    await assertProductionClock(pool, false);
    return worker?.running() === true;
  });
  app.get("/jobs", async () => ({ enabled: config.enabled, planned: jobs }));
  if (config.enabled) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl!,
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 10000,
    });
    const database = pool;
    database.on("error", () =>
      console.error("WORKER_DATABASE_CONNECTION_ERROR"),
    );
    await assertWorkerRuntimeRole(database);
    await assertProductionClock(database, false);
    await assertJobsMigrationInstalled(database);
    const queue = postgresJobQueue(database);
    const alerts = alertConfig(process.env);
    const alertHandler = createAlertDeliveryHandler(alertSinkFor(alerts));
    registerAlertEvaluate(database, alertEvaluateConfig(process.env));
    // The same index reader the API uses; a worker without a deployment sees no market.
    const reader = forecast.deploymentId
      ? postgresProtocolReader(database, forecast.deploymentId)
      : staleProtocolReader;
    registerEvaluationHandler(database, reader, forecast.deploymentId);
    registerOperationsPrune(database);
    const research = buildResearch({
      pool: database,
      queue,
      reader,
      deploymentId: forecast.deploymentId,
      schedule: forecast.schedule,
    });
    worker = startJobLoops({
      queue,
      alertHandler,
      handlers: {
        ...handlers,
        ...research.handlers,
      },
      workerId: hostname() + ":" + process.pid + ":" + randomUUID(),
      onError: (code) => console.error("WORKER_JOB_ERROR:" + code),
    });
    let dispatching = false;
    outboxTimer = setInterval(() => {
      if (dispatching) return;
      dispatching = true;
      outboxRun = dispatchOutbox(database, outboxMapping)
        .catch(() => console.error("WORKER_OUTBOX_DISPATCH_FAILED"))
        .finally(() => {
          dispatching = false;
        });
    }, OUTBOX_DISPATCH_INTERVAL_MS);
    let scheduling = false;
    const schedule = () => {
      if (scheduling) return;
      scheduling = true;
      // Each periodic family enqueues independently, deduplicated per time bucket.
      scheduleRun = Promise.allSettled([
        research.tick(),
        scheduleEvaluation(database),
        scheduleOperationsPrune(database),
        scheduleAlertEvaluate(database),
      ])
        .then((results) => {
          if (results.some((result) => result.status === "rejected"))
            console.error("WORKER_SCHEDULE_FAILED");
        })
        .finally(() => {
          scheduling = false;
        });
    };
    schedule();
    scheduleTimer = setInterval(schedule, PERIODIC_SCHEDULE_INTERVAL_MS);
    app.get("/health/jobs", async (_request, reply) => {
      try {
        await assertProductionClock(database, false);
        return await queue.stats();
      } catch {
        return reply.code(503).send({ status: "health-query-failed" });
      }
    });
    app.addHook("onClose", async () => {
      if (scheduleTimer) clearInterval(scheduleTimer);
      await scheduleRun;
      if (outboxTimer) clearInterval(outboxTimer);
      await outboxRun;
      await worker?.stop();
      await database.end();
    });
  }
  await startService(app, 3002);
} catch (error) {
  if (scheduleTimer) clearInterval(scheduleTimer);
  await scheduleRun;
  if (outboxTimer) clearInterval(outboxTimer);
  await outboxRun;
  await worker?.stop().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
      ? error.message
      : "WORKER_STARTUP_FAILED";
  console.error(code);
  process.exitCode = 1;
}
