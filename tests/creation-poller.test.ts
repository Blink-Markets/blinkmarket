import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  CreationTrackingLease,
  CreationTrackingSchedule,
} from "../packages/ports/src/creation-tracker.js";
import {
  startCreationPoller,
  type CreationPollerTracker,
} from "../packages/application/src/creation-poller.js";
import { createCreationTracker } from "../packages/application/src/creation-tracker.js";
import type {
  CreationReceiptReader,
  CreationTrackerStore,
} from "../packages/ports/src/creation-tracker.js";

const lease = (
  intentId: string,
  attempt = 0,
): CreationTrackingLease => ({
  intentId,
  txHash: `0x${"1".repeat(64)}`,
  workerId: "worker-test",
  leaseToken: `token-${intentId}-${attempt}`,
  attempt,
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(predicate(), message);
}

function harness(
  leases: CreationTrackingLease[],
  reconcile: CreationPollerTracker["reconcile"],
  reconciliationDeadlineMs = 25,
) {
  let claims = 0;
  const completed: Array<[CreationTrackingLease, number]> = [];
  const failed: Array<[CreationTrackingLease, string, number]> = [];
  const schedule: CreationTrackingSchedule = {
    async claim(workerId, leaseMs) {
      assert.equal(workerId, "worker-test");
      assert.equal(leaseMs, 16_000);
      return leases[claims++] ?? null;
    },
    async complete(owned, delay) {
      completed.push([owned, delay]);
      return true;
    },
    async fail(owned, code, delay) {
      failed.push([owned, code, delay]);
      return true;
    },
    async health() {
      return {
        tracked: leases.length,
        due: 0,
        leased: 0,
        failing: 0,
        oldestDueAt: null,
      };
    },
  };
  const poller = startCreationPoller({
    tracker: { reconcile },
    schedule,
    workerId: "worker-test",
    pollIntervalMs: 5,
    leaseMs: 16_000,
    reconciliationDeadlineMs,
    retryBaseMs: 10,
    retryMaxMs: 40,
    pendingPollMs: 101,
    confirmedPollMs: 303,
    revertedPollMs: 707,
  });
  return { poller, completed, failed, claims: () => claims };
}

test("creation poller processes one bounded lease per tick and uses state-specific cadence", async () => {
  const s = harness(
    [lease("1"), lease("2"), lease("3")],
    async (id) => ({
      state: id === "1" ? "INCLUDED" : id === "2" ? "CONFIRMED" : "REVERTED",
    }),
  );
  try {
    await until(() => s.completed.length === 3, "three leases should complete");
    assert.deepEqual(
      s.completed.map(([item, delay]) => [item.intentId, delay]),
      [["1", 101], ["2", 303], ["3", 707]],
    );
    assert.equal(s.claims(), 3);
  } finally {
    await s.poller.stop();
  }
});

test("creation poller deadline bounds stop when a reader ignores abort; late result cannot save", async () => {
  const enteredReader = deferred();
  const releaseReader = deferred<{ txHash: string }>();
  let saves = 0;
  const hash = "0x" + "1".repeat(64);
  const store = {
    async load(id: string) {
      return {
        intent: { creationIntentId: id },
        manifest: {},
        status: { txHash: null, version: 0 },
      };
    },
    async save() {
      saves += 1;
      return {};
    },
  } as unknown as CreationTrackerStore;
  const reader = {
    async observe() {
      enteredReader.resolve();
      // Deliberately ignore AbortSignal to exercise the caller's deadline race.
      return releaseReader.promise;
    },
  } as unknown as CreationReceiptReader;
  const tracker = createCreationTracker(store, reader);
  const s = harness(
    [lease("deadline")],
    (id, txHash, owned, signal) =>
      tracker.reconcile(id, txHash, owned, signal),
    10,
  );
  await enteredReader.promise;
  await until(() => s.failed.length === 1, "deadline should fail the lease");
  assert.equal(s.failed[0]![1], "CREATION_RECONCILIATION_DEADLINE");
  assert.equal(s.completed.length, 0);
  assert.equal(s.poller.health().lastErrorCode, "CREATION_RECONCILIATION_DEADLINE");

  let stopTimedOut = false;
  await Promise.race([
    s.poller.stop(),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        stopTimedOut = true;
        reject(new Error("POLLER_STOP_DID_NOT_DRAIN"));
      }, 100),
    ),
  ]);
  assert.equal(stopTimedOut, false, "stop must finish after the bounded deadline");
  assert.equal(s.claims(), 1, "stop must prevent another claim");

  releaseReader.resolve({ txHash: hash });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves, 0, "a late reader result must not write a projection");
  assert.equal(s.completed.length, 0);
});

test("creation tracker checks cancellation after an RPC result before saving", async () => {
  const enteredReader = deferred();
  const releaseReader = deferred<{ txHash: string }>();
  let saves = 0;
  const hash = "0x" + "1".repeat(64);
  const store = {
    async load(id: string) {
      return {
        intent: { creationIntentId: id },
        manifest: {},
        status: { txHash: null },
      };
    },
    async save() {
      saves += 1;
      return {};
    },
  } as unknown as CreationTrackerStore;
  const reader = {
    async observe(_creation: unknown, _hash: string, _signal?: AbortSignal) {
      enteredReader.resolve();
      return releaseReader.promise;
    },
  } as unknown as CreationReceiptReader;
  const tracker = createCreationTracker(store, reader);
  const controller = new AbortController();
  const work = tracker.reconcile("intent-1", hash, undefined, controller.signal);
  await enteredReader.promise;
  controller.abort(new Error("CREATION_RECONCILIATION_DEADLINE"));
  releaseReader.resolve({ txHash: hash });
  await assert.rejects(work, /CREATION_RECONCILIATION_DEADLINE/);
  assert.equal(saves, 0, "a late RPC result must never commit after cancellation");
});

test("creation poller backs off transient failures and resets after the same intent succeeds", async () => {
  const calls: string[] = [];
  const s = harness(
    [lease("a", 0), lease("a", 1), lease("a", 2), lease("a", 3)],
    async (id) => {
      calls.push(id);
      if (calls.length < 4) throw new Error("RPC_UNAVAILABLE");
      return { state: "UNKNOWN" };
    },
  );
  try {
    await until(() => s.claims() === 4 && (s.completed.length + s.failed.length) >= 4, "poller should settle four attempts");
    assert.deepEqual(
      s.failed.map(([, code, delay]) => [code, delay]),
      [["RPC_UNAVAILABLE", 10], ["RPC_UNAVAILABLE", 20], ["RPC_UNAVAILABLE", 40]],
    );
    assert.equal(s.completed.length, 1);
    assert.deepEqual(calls, ["a", "a", "a", "a"]);
    assert.equal(s.poller.health().consecutiveFailures, 0);
    assert.equal(s.poller.health().lastErrorCode, null);
  } finally {
    await s.poller.stop();
  }
});

test("empty claims preserve per-intent lease and schedule-write failures", async () => {
  for (const [failure, expected] of [
    ["lost", "CREATION_POLL_LEASE_LOST"],
    ["write", "CREATION_SCHEDULE_WRITE_FAILED"],
  ] as const) {
    let claims = 0;
    const errors: string[] = [];
    const schedule: CreationTrackingSchedule = {
      async claim() {
        return claims++ === 0 ? lease(failure) : null;
      },
      async complete() {
        return true;
      },
      async fail() {
        if (failure === "write") throw new Error("database unavailable");
        return false;
      },
      async health() {
        return {
          tracked: 1,
          due: 0,
          leased: 0,
          failing: 1,
          oldestDueAt: null,
        };
      },
    };
    const poller = startCreationPoller({
      tracker: {
        async reconcile() {
          throw new Error("RPC_UNAVAILABLE");
        },
      },
      schedule,
      workerId: "worker-test",
      pollIntervalMs: 5,
      leaseMs: 16_000,
      reconciliationDeadlineMs: 25,
      retryBaseMs: 10,
      retryMaxMs: 40,
      pendingPollMs: 101,
      confirmedPollMs: 303,
      revertedPollMs: 707,
      onError: (code) => errors.push(code),
    });
    try {
      await until(() => claims >= 2, "poller should perform a subsequent empty claim");
      assert.equal(poller.health().lastErrorCode, expected);
      assert.ok(errors.includes(expected), "the operational failure should be logged");
    } finally {
      await poller.stop();
    }
  }
});

test("another intent's success does not clear the failing intent's health", async () => {
  const s = harness(
    [lease("failed"), lease("other"), lease("failed", 1)],
    async (id) => {
      if (id === "failed" && s.failed.length === 0)
        throw new Error("RPC_UNAVAILABLE");
      return { state: "INCLUDED" };
    },
  );
  try {
    await until(() => s.claims() >= 2, "second intent should be claimed");
    await until(() => s.completed.length === 1, "unrelated intent should complete");
    assert.equal(s.poller.health().lastErrorCode, "RPC_UNAVAILABLE");
    await until(() => s.completed.length === 2, "failed intent should recover");
    assert.equal(s.poller.health().lastErrorCode, null);
    assert.equal(s.poller.health().consecutiveFailures, 0);
  } finally {
    await s.poller.stop();
  }
});

test("creation poller stop aborts an in-flight RPC and starts no later poll", async () => {
  const entered = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  const s = harness([lease("1"), lease("2")], async (_id, _hash, _lease, activeSignal) => {
    signal = activeSignal;
    entered.resolve();
    await release.promise;
    return { state: "INCLUDED" };
  });
  await entered.promise;
  let stopTimedOut = false;
  await Promise.race([
    s.poller.stop(),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        stopTimedOut = true;
        reject(new Error("POLLER_STOP_DID_NOT_ABORT"));
      }, 100),
    ),
  ]);
  assert.equal(stopTimedOut, false);
  assert.equal(signal?.aborted, true, "stop must abort the active reconciliation");
  assert.equal(s.claims(), 1, "stop must prevent a subsequent claim");
  assert.equal(s.completed.length, 0);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.completed.length, 0, "a late result must not complete the lease");
  assert.equal(s.poller.health().running, false);
});

test("creation poller does not overlap timer ticks while a bounded RPC is pending", async () => {
  const entered = deferred();
  const release = deferred();
  const s = harness([lease("1"), lease("2")], async () => {
    entered.resolve();
    await release.promise;
    return { state: "INCLUDED" };
  });
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(s.claims(), 1);
  release.resolve();
  try {
    await until(() => s.completed.length === 2, "second lease should run after first settles");
    assert.equal(s.claims(), 2);
  } finally {
    await s.poller.stop();
  }
});
