import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chainIndexerConfig,
  creationObservationReady,
  indexerConfig,
  indexerFetchWithTimeout,
} from "../apps/indexer/src/config.js";
import { registerChainIndexHealth } from "../apps/indexer/src/chain-health.js";
import { createService } from "../packages/runtime/src/index.js";

test("creation observer readiness follows durable backlog, not historical errors", () => {
  const recoveredPollerHealth = {
    running: true,
    lastErrorCode: "RPC_UNAVAILABLE",
    lastSuccessAt: null,
  };
  assert.equal(
    creationObservationReady(recoveredPollerHealth, {
      due: 0,
      failing: 0,
    }),
    true,
    "a stale local diagnostic must not keep readiness latched after durable recovery",
  );
  assert.equal(
    creationObservationReady(recoveredPollerHealth, { due: 1, failing: 0 }),
    false,
  );
  assert.equal(
    creationObservationReady(recoveredPollerHealth, { due: 0, failing: 1 }),
    false,
  );
  assert.equal(
    creationObservationReady({ running: false }, { due: 0, failing: 0 }),
    false,
  );
});

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
    assert.equal(requestSignals[0]?.aborted, false, "successful fetch must clear its timeout");

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

const chainEnv = {
  CHAIN_INDEXER_ENABLED: "true",
  INDEXER_DATABASE_URL: "postgresql://indexer@127.0.0.1/blink",
  BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
  INDEXER_DEPLOYMENT_ID: "base-sepolia-1",
};

test("the chain indexer is its own opt-in and leaves the creation poller configuration alone", () => {
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
  // Enabling only the chain indexer does not enable creation polling, and vice versa.
  assert.equal(indexerConfig(chainEnv).enabled, false);
  const creationOnly = {
    INDEXER_CREATION_POLLING_ENABLED: "true",
    INDEXER_DATABASE_URL: chainEnv.INDEXER_DATABASE_URL,
    BASE_SEPOLIA_RPC_URL: chainEnv.BASE_SEPOLIA_RPC_URL,
  };
  assert.equal(indexerConfig(creationOnly).enabled, true);
  assert.equal(chainIndexerConfig(creationOnly).enabled, false);
  assert.equal(indexerConfig({ ...chainEnv, ...creationOnly }).enabled, true);
  assert.equal(chainIndexerConfig({ ...chainEnv, ...creationOnly }).enabled, true);
});

test("the chain indexer refuses incomplete or malformed configuration", () => {
  for (const missing of ["INDEXER_DATABASE_URL", "BASE_SEPOLIA_RPC_URL", "INDEXER_DEPLOYMENT_ID"]) {
    const env: NodeJS.ProcessEnv = { ...chainEnv };
    delete env[missing];
    assert.throws(() => chainIndexerConfig(env), /INDEXER_CHAIN_CONFIGURATION_REQUIRED/);
  }
  assert.throws(() => chainIndexerConfig({ CHAIN_INDEXER_ENABLED: "yes" }), /INVALID_CHAIN_INDEXER_ENABLED/);
  assert.throws(
    () => chainIndexerConfig({ ...chainEnv, INDEXER_DEPLOYMENT_ID: "../etc" }),
    /INVALID_INDEXER_DEPLOYMENT_ID/,
  );
  for (const key of ["INDEXER_CHAIN_POLL_MS", "INDEXER_CHAIN_RANGE"]) {
    assert.throws(() => chainIndexerConfig({ ...chainEnv, [key]: "0" }), /INVALID_INDEXER_/);
    assert.throws(() => chainIndexerConfig({ ...chainEnv, [key]: "1.5" }), /INVALID_INDEXER_/);
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
  const request = async (provider: Parameters<typeof registerChainIndexHealth>[1]) => {
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
