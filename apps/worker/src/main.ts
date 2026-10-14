import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";
import {
  assertJobsMigrationInstalled,
  assertWorkerRuntimeRole,
  dispatchOutbox,
  postgresJobQueue,
} from "@blink/adapters";
import { startWorker } from "@blink/application";
import { createService, startService } from "@blink/runtime";
import { workerConfig } from "./config.js";
import { handlers, outboxMapping, registerEvaluationHandler, scheduleEvaluation, registerResolutionHandlers, scheduleResolution } from "./handlers.js";
import { jobs } from "./registry.js";

const OUTBOX_DISPATCH_INTERVAL_MS = 1000;

let pool: pg.Pool | null = null;
let worker: ReturnType<typeof startWorker> | null = null;
let outboxTimer: ReturnType<typeof setInterval> | null = null;
let outboxRun: Promise<unknown> = Promise.resolve();

try {
  const config = workerConfig(process.env);
  // Not ready until the job loop is actually running; disabled means liveness only.
  const app = createService(
    "worker",
    "m3-jobs",
    () => worker?.running() === true,
  );
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
    await assertJobsMigrationInstalled(database);
    const queue = postgresJobQueue(database);
    registerEvaluationHandler(database);
    registerResolutionHandlers(database, process.env.EVIDENCE_OBJECT_DIRECTORY);
    await scheduleResolution(database);
    await scheduleEvaluation(database);
    worker = startWorker({
      queue,
      handlers,
      workerId: hostname() + ":" + process.pid + ":" + randomUUID(),
      onError: (code) => console.error("WORKER_JOB_ERROR:" + code),
    });
    let dispatching = false;
    outboxTimer = setInterval(() => {
      if (dispatching) return;
      dispatching = true;
      outboxRun = dispatchOutbox(database, outboxMapping)
        .then(() => scheduleEvaluation(database))
        .then(() => scheduleResolution(database))
        .catch(() => console.error("WORKER_OUTBOX_DISPATCH_FAILED"))
        .finally(() => {
          dispatching = false;
        });
    }, OUTBOX_DISPATCH_INTERVAL_MS);
    app.get("/health/jobs", async (_request, reply) => {
      try {
        return await queue.stats();
      } catch {
        return reply.code(503).send({ status: "health-query-failed" });
      }
    });
    app.addHook("onClose", async () => {
      if (outboxTimer) clearInterval(outboxTimer);
      await outboxRun;
      await worker?.stop();
      await database.end();
    });
  }
  await startService(app, 3002);
} catch (error) {
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
