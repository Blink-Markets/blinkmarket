import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";
import { createPublicClient, http } from "viem";
import {
  assertCreationTrackingMigrationsInstalled,
  assertCreationTrackingRuntimeRole,
  creationReceiptReader,
  postgresCreationTrackerStore,
  postgresCreationTrackingSchedule,
} from "@blink/adapters";
import { createCreationTracker, startCreationPoller } from "@blink/application";
import { createService, startService } from "@blink/runtime";
import {
  creationObservationReady,
  indexerConfig,
  indexerFetchWithTimeout,
} from "./config.js";

const config = indexerConfig(process.env);
const pool = config.enabled
  ? new pg.Pool({
      connectionString: config.databaseUrl!,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 5000,
      idle_in_transaction_session_timeout: 10000,
    })
  : null;
const app = createService("indexer", "m2-creation-receipt-poller");
let poller: ReturnType<typeof startCreationPoller> | null = null;

pool?.on("error", () => console.error("INDEXER_DATABASE_CONNECTION_ERROR"));

try {
  if (pool) {
    await assertCreationTrackingRuntimeRole(pool);
    await assertCreationTrackingMigrationsInstalled(pool);
    const schedule = postgresCreationTrackingSchedule(pool);
    const tracker = createCreationTracker(
      postgresCreationTrackerStore(pool),
      creationReceiptReader((signal) =>
        createPublicClient({
          transport: http(config.rpcUrl!, {
            timeout: config.rpcTimeoutMs,
            retryCount: 0,
            fetchFn: indexerFetchWithTimeout(config.rpcTimeoutMs),
            ...(signal ? { fetchOptions: { signal } } : {}),
          }),
        }),
      ),
    );
    poller = startCreationPoller({
      tracker,
      schedule,
      workerId: hostname() + ":" + process.pid + ":" + randomUUID(),
      pollIntervalMs: config.pollIntervalMs,
      leaseMs: config.leaseMs,
      reconciliationDeadlineMs: config.reconciliationDeadlineMs,
      retryBaseMs: config.retryBaseMs,
      retryMaxMs: config.retryMaxMs,
      pendingPollMs: config.pendingPollMs,
      confirmedPollMs: config.confirmedPollMs,
      revertedPollMs: config.revertedPollMs,
      onError: (code) => console.error("INDEXER_CREATION_POLLER_ERROR:" + code),
    });
    app.get("/health/creation-observer", async (_request, reply) => {
      try {
        const processHealth = poller!.health();
        const backlog = await schedule.health();
        const observationReady = creationObservationReady(
          processHealth,
          backlog,
        );
        return reply
          .code(observationReady ? 200 : 503)
          .send({
            component: "creation-receipt-poller",
            observationReady,
            poller: processHealth,
            backlog,
          });
      } catch {
        return reply.code(503).send({
          component: "creation-receipt-poller",
          observationReady: false,
          status: "health-query-failed",
        });
      }
    });
    app.addHook("onClose", async () => {
      await poller?.stop();
      await pool.end();
    });
  } else {
    app.get("/health/creation-observer", async (_request, reply) =>
      reply.code(503).send({
        component: "creation-receipt-poller",
        observationReady: false,
        status: "disabled",
      }),
    );
  }
  // Existing global readiness remains 503: this component only observes creation receipts.
  await startService(app, config.port, config.host);
} catch (error) {
  await poller?.stop().catch(() => undefined);
  await pool?.end();
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
      ? error.message
      : "INDEXER_STARTUP_FAILED";
  console.error(code);
  process.exitCode = 1;
}
