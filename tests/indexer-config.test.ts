import { test } from "node:test";
import assert from "node:assert/strict";
import {
  creationObservationReady,
  indexerFetchWithTimeout,
} from "../apps/indexer/src/config.js";

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
