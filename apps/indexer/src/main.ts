import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";
import { createPublicClient, http } from "viem";
import {
  assertIndexerRuntimeRole,
  postgresTxTrackingStore,
  txReceiptReader,
  txTrackingManifest,
} from "@blink/adapters";
import { createTxTracker } from "@blink/application";
import { createService, startService } from "@blink/runtime";
import {
  assertChainIndexInstalled,
  assertProductionClock,
  protocolLogReader,
  loadProtocolDeployment,
  postgresProtocolIndexStore,
} from "@blink/adapters";
import {
  assertBaseSepolia,
  createChainIndexer,
  startChainIndexer,
} from "@blink/application";
import { registerChainIndexHealth } from "./chain-health.js";
import {
  chainIndexerConfig,
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
const clockPools = [chainPool].filter((p) => p !== null);
const checkClocks = async () => {
  for (const database of clockPools)
    await assertProductionClock(
      database,
      process.env.BLINK_ALLOW_TEST_CLOCK === "1",
    );
};
const app = createService("indexer", "p2-indexer", async () => {
  await checkClocks();
  return false;
});
let stopTxTracking: (() => Promise<void>) | null = null;

try {
  // Independent of the sibling chain projection indexer.
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
    await assertIndexerRuntimeRole(txPool);
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
    await assertIndexerRuntimeRole(chainPool);
    await assertChainIndexInstalled(chainPool);
    await assertProductionClock(
      chainPool,
      process.env.BLINK_ALLOW_TEST_CLOCK === "1",
    );
    const deployment = await loadProtocolDeployment(
      chainPool,
      chainConfig.deploymentId!,
    );
    const reader = protocolLogReader(
      createPublicClient({
        transport: http(chainConfig.rpcUrl!, {
          timeout: config.rpcTimeoutMs,
          retryCount: 0,
          fetchFn: indexerFetchWithTimeout(config.rpcTimeoutMs),
        }),
      }),
      deployment,
    );
    assertBaseSepolia(await reader.chainId());
    const indexer = createChainIndexer({
      store: postgresProtocolIndexStore(chainPool),
      reader,
      deploymentId: chainConfig.deploymentId!,
      marketAddress: deployment.generation.markets,
      deploymentBlock: BigInt(deployment.startBlock),
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
  // Global readiness remains 503: transaction tracking and the chain index report on their own.
  await startService(app, config.port, config.host);
} catch (error) {
  await stopTxTracking?.().catch(() => undefined);
  await chainLoop?.stop().catch(() => undefined);
  await chainPool?.end();
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
      ? error.message
      : "INDEXER_STARTUP_FAILED";
  console.error(code);
  process.exitCode = 1;
}
