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
  postgresTxTrackingStore,
  txReceiptReader,
  txTrackingManifest,
} from "@blink/adapters";
import {
  createCreationTracker,
  startCreationPoller,
  createTxTracker,
} from "@blink/application";
import { createService, startService } from "@blink/runtime";
import {
  assertChainIndexInstalled,
  assertProductionClock,
  chainLogReader,
  loadChainDeployment,
  postgresChainIndexStore,
} from "@blink/adapters";
import {
  assertBaseSepolia,
  createChainIndexer,
  startChainIndexer,
} from "@blink/application";
import { registerChainIndexHealth } from "./chain-health.js";
import {
  chainIndexerConfig,
  creationObservationReady,
  indexerConfig,
  indexerFetchWithTimeout,
} from "./config.js";

const config = indexerConfig(process.env);
const chainConfig = chainIndexerConfig(process.env);
const chainPool = chainConfig.enabled
  ? new pg.Pool({
      connectionString: chainConfig.databaseUrl!,
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      query_timeout: 15000,
      idle_in_transaction_session_timeout: 20000,
    })
  : null;
let chainLoop: ReturnType<typeof startChainIndexer> | null = null;
chainPool?.on("error", () =>
  console.error("INDEXER_DATABASE_CONNECTION_ERROR"),
);
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
const clockPools = [pool, chainPool].filter((p) => p !== null);
const checkClocks = async () => {
  for (const database of clockPools)
    await assertProductionClock(
      database,
      process.env.BLINK_ALLOW_TEST_CLOCK === "1",
    );
};
const app = createService("indexer", "m2-creation-receipt-poller", async () => {
  await checkClocks();
  return false;
});
let poller: ReturnType<typeof startCreationPoller> | null = null;
let stopTxTracking: (() => Promise<void>) | null = null;

pool?.on("error", () => console.error("INDEXER_DATABASE_CONNECTION_ERROR"));

try {
  if (pool) {
    await assertCreationTrackingRuntimeRole(pool);
    await assertProductionClock(
      pool,
      process.env.BLINK_ALLOW_TEST_CLOCK === "1",
    );
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
        await checkClocks();
        const processHealth = poller!.health();
        const backlog = await schedule.health();
        const observationReady = creationObservationReady(
          processHealth,
          backlog,
        );
        return reply.code(observationReady ? 200 : 503).send({
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
  // Independent of creation polling and the sibling chain projection indexer.
  if (config.txTrackingEnabled) {
    const txPool = new pg.Pool({
      connectionString: config.databaseUrl!,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 5000,
    });
    txPool.on("error", () =>
      console.error("INDEXER_TX_DATABASE_CONNECTION_ERROR"),
    );
    const abort = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    let inFlight: Promise<void> | null = null;
    let stopped = false;
    stopTxTracking = async () => {
      stopped = true;
      clearInterval(timer);
      abort.abort();
      await inFlight;
      await txPool.end();
    };
    clockPools.push(txPool);
    await assertCreationTrackingRuntimeRole(txPool);
    await assertProductionClock(
      txPool,
      process.env.BLINK_ALLOW_TEST_CLOCK === "1",
    );
    await txPool.query("SELECT id FROM chain.transactions LIMIT 0");
    const tracker = createTxTracker({
      store: postgresTxTrackingStore(txPool),
      reader: txReceiptReader(
        createPublicClient({
          transport: http(config.rpcUrl!, {
            timeout: config.rpcTimeoutMs,
            retryCount: 0,
            fetchFn: indexerFetchWithTimeout(config.rpcTimeoutMs),
            fetchOptions: { signal: abort.signal },
          }),
        }),
      ),
      manifest: (deploymentId) => txTrackingManifest(txPool, deploymentId),
    });
    const tick = () => {
      if (stopped || inFlight) return;
      inFlight = tracker
        .trackOnce(50)
        .then(() => undefined)
        .catch((error: unknown) => {
          if (!stopped)
            console.error(
              error instanceof Error && error.message === "MAINNET_REFUSED"
                ? "MAINNET_REFUSED"
                : "INDEXER_TX_TRACKING_FAILED",
            );
        })
        .finally(() => {
          inFlight = null;
        });
    };
    timer = setInterval(tick, 2000);
    tick();
    app.addHook("onClose", async () => {
      await stopTxTracking?.();
      stopTxTracking = null;
    });
  }
  if (chainPool) {
    await assertCreationTrackingRuntimeRole(chainPool);
    await assertChainIndexInstalled(chainPool);
    await assertProductionClock(
      chainPool,
      process.env.BLINK_ALLOW_TEST_CLOCK === "1",
    );
    const deployment = await loadChainDeployment(
      chainPool,
      chainConfig.deploymentId!,
    );
    const reader = chainLogReader(
      createPublicClient({
        transport: http(chainConfig.rpcUrl!, {
          timeout: config.rpcTimeoutMs,
          retryCount: 0,
          fetchFn: indexerFetchWithTimeout(config.rpcTimeoutMs),
        }),
      }),
    );
    assertBaseSepolia(await reader.chainId());
    const indexer = createChainIndexer({
      store: postgresChainIndexStore(chainPool),
      reader,
      deploymentId: chainConfig.deploymentId!,
      marketAddress: deployment.marketAddress,
      deploymentBlock: deployment.deploymentBlock,
      workerId:
        hostname().slice(0, 64) + ":" + process.pid + ":" + randomUUID(),
      rangeSize: chainConfig.rangeSize,
    });
    chainLoop = startChainIndexer({
      indexer,
      pollIntervalMs: chainConfig.pollIntervalMs,
      onError: (code) => console.error("INDEXER_CHAIN_SYNC_ERROR:" + code),
    });
    registerChainIndexHealth(app, async () => {
      await checkClocks();
      return chainLoop!.health();
    });
    app.addHook("onClose", async () => {
      await chainLoop?.stop();
      await chainPool.end();
    });
  } else {
    registerChainIndexHealth(app, null);
  }
  // Existing global readiness remains 503: this component only observes creation receipts.
  await startService(app, config.port, config.host);
} catch (error) {
  await stopTxTracking?.().catch(() => undefined);
  await poller?.stop().catch(() => undefined);
  await pool?.end();
  await chainLoop?.stop().catch(() => undefined);
  await chainPool?.end();
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
      ? error.message
      : "INDEXER_STARTUP_FAILED";
  console.error(code);
  process.exitCode = 1;
}
