import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chainIndexerConfig,
  indexerConfig,
  indexerFetchWithTimeout,
} from "../apps/indexer/src/config.js";
import { registerChainIndexHealth } from "../apps/indexer/src/chain-health.js";
import { createService } from "../packages/runtime/src/index.js";

test("indexer RPC fetch enforces its own timeout", async () => {
  const originalFetch = globalThis.fetch;
  const requestSignals: AbortSignal[] = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) requestSignals.push(init.signal);
    return new Promise<Response>((_resolve, reject) => {
      requestSignals[0]?.addEventListener(
        "abort",
        () => reject(requestSignals[0]?.reason),
        { once: true },
      );
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      indexerFetchWithTimeout(10)("http://rpc.invalid"),
      /INDEXER_RPC_TIMEOUT/,
    );
    assert.equal(requestSignals[0]?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("indexer RPC fetch propagates parent cancellation and removes timeout after success", async () => {
  const originalFetch = globalThis.fetch;
  const requestSignals: AbortSignal[] = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) requestSignals.push(init.signal);
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const response = await indexerFetchWithTimeout(10)("http://rpc.invalid", {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(requestSignals[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      requestSignals[0]?.aborted,
      false,
      "successful fetch must clear its timeout",
    );

    const pendingController = new AbortController();
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      })) as typeof fetch;
    const pending = indexerFetchWithTimeout(1000)("http://rpc.invalid", {
      signal: pendingController.signal,
    });
    pendingController.abort(new Error("PARENT_STOP"));
    await assert.rejects(pending, /PARENT_STOP/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transaction tracking is independently enabled and requires RPC/database configuration", () => {
  assert.equal(indexerConfig({}).txTrackingEnabled, false);
  assert.throws(
    () => indexerConfig({ INDEXER_TX_TRACKING_ENABLED: "yes" }),
    /INVALID_INDEXER_TX_TRACKING_ENABLED/,
  );
  assert.throws(
    () => indexerConfig({ INDEXER_TX_TRACKING_ENABLED: "true" }),
    /INDEXER_TRACKER_CONFIGURATION_REQUIRED/,
  );
  const config = indexerConfig({
    INDEXER_TX_TRACKING_ENABLED: "true",
    INDEXER_DATABASE_URL: "postgres://local.invalid/blink",
    BASE_SEPOLIA_RPC_URL: "http://rpc.invalid",
  });
  assert.equal(config.txTrackingEnabled, true);
});

const chainEnv = {
  CHAIN_INDEXER_ENABLED: "true",
  INDEXER_DATABASE_URL: "postgresql://indexer@127.0.0.1/blink",
  BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
  INDEXER_DEPLOYMENT_ID: "base-sepolia-1",
};

test("the chain indexer is its own opt-in", () => {
  const off = chainIndexerConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.pollIntervalMs, 1000);
  assert.equal(off.rangeSize, 500);
  const on = chainIndexerConfig({
    ...chainEnv,
    INDEXER_CHAIN_POLL_MS: "250",
    INDEXER_CHAIN_RANGE: "100",
  });
  assert.deepEqual(on, {
    enabled: true,
    databaseUrl: chainEnv.INDEXER_DATABASE_URL,
    rpcUrl: chainEnv.BASE_SEPOLIA_RPC_URL,
    deploymentId: "base-sepolia-1",
    pollIntervalMs: 250,
    rangeSize: 100,
  });
  // The transaction tracker and the chain indexer are enabled independently.
  assert.equal(indexerConfig(chainEnv).txTrackingEnabled, false);
  assert.equal(
    chainIndexerConfig({ INDEXER_TX_TRACKING_ENABLED: "true" }).enabled,
    false,
  );
});

test("the chain indexer refuses incomplete or malformed configuration", () => {
  for (const missing of [
    "INDEXER_DATABASE_URL",
    "BASE_SEPOLIA_RPC_URL",
    "INDEXER_DEPLOYMENT_ID",
  ]) {
    const env: NodeJS.ProcessEnv = { ...chainEnv };
    delete env[missing];
    assert.throws(
      () => chainIndexerConfig(env),
      /INDEXER_CHAIN_CONFIGURATION_REQUIRED/,
    );
  }
  assert.throws(
    () => chainIndexerConfig({ CHAIN_INDEXER_ENABLED: "yes" }),
    /INVALID_CHAIN_INDEXER_ENABLED/,
  );
  assert.throws(
    () => chainIndexerConfig({ ...chainEnv, INDEXER_DEPLOYMENT_ID: "../etc" }),
    /INVALID_INDEXER_DEPLOYMENT_ID/,
  );
  for (const key of ["INDEXER_CHAIN_POLL_MS", "INDEXER_CHAIN_RANGE"]) {
    assert.throws(
      () => chainIndexerConfig({ ...chainEnv, [key]: "0" }),
      /INVALID_INDEXER_/,
    );
    assert.throws(
      () => chainIndexerConfig({ ...chainEnv, [key]: "1.5" }),
      /INVALID_INDEXER_/,
    );
  }
  assert.throws(
    () => chainIndexerConfig({ ...chainEnv, INDEXER_CHAIN_RANGE: "10001" }),
    /INVALID_INDEXER_CHAIN_RANGE/,
  );
});

test("GET /health/chain-index is 200 only while the index is ready", async () => {
  const health = (ready: boolean) => async () => ({
    deploymentId: "base-sepolia-1",
    blockNumber: "100",
    headNumber: ready ? "100" : "110",
    lagBlocks: ready ? "0" : "10",
    syncedAt: "2026-10-14T00:00:00.000Z",
    ageMs: 20,
    gateReason: null,
    ready,
  });
  const request = async (
    provider: Parameters<typeof registerChainIndexHealth>[1],
  ) => {
    const app = createService("indexer");
    registerChainIndexHealth(app, provider);
    try {
      const response = await app.inject("/health/chain-index");
      return { status: response.statusCode, body: response.json() };
    } finally {
      await app.close();
    }
  };
  const ready = await request(health(true));
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ready, true);
  assert.equal(ready.body.lagBlocks, "0");
  const behind = await request(health(false));
  assert.equal(behind.status, 503);
  assert.equal(behind.body.lagBlocks, "10");
  assert.deepEqual((await request(null)).body, {
    component: "chain-indexer",
    ready: false,
    status: "disabled",
  });
  const broken = await request(async () => {
    throw new Error("database down");
  });
  assert.equal(broken.status, 503);
  assert.equal(broken.body.status, "health-query-failed");
});
