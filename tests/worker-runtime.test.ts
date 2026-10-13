import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresJobQueue } from "../packages/adapters/src/job-queue.js";
import {
  schedulePeriodic,
  startWorker,
} from "../packages/application/src/worker-runtime.js";
import { JobError } from "../packages/domain/src/jobs.js";
import type { JobQueue, LeasedJob } from "../packages/ports/src/index.js";
import { createService } from "../packages/runtime/src/index.js";
import { workerConfig } from "../apps/worker/src/config.js";
import { migratedPglite } from "./helpers/serial-pglite-pool.js";

test("the worker is disabled by default and enabling it needs its own database login", () => {
  assert.deepEqual(workerConfig({}), { enabled: false, databaseUrl: null });
  assert.deepEqual(workerConfig({ WORKER_ENABLED: "false" }), {
    enabled: false,
    databaseUrl: null,
  });
  assert.throws(
    () => workerConfig({ WORKER_ENABLED: "true" }),
    /WORKER_CONFIGURATION_REQUIRED/,
  );
  assert.throws(
    () => workerConfig({ WORKER_ENABLED: "yes" }),
    /INVALID_WORKER_ENABLED/,
  );
  assert.deepEqual(
    workerConfig({
      WORKER_ENABLED: "true",
      WORKER_DATABASE_URL: " postgresql://blink_worker@db/blink ",
    }),
    { enabled: true, databaseUrl: "postgresql://blink_worker@db/blink" },
  );
});

test("a service is not ready unless it says so", async () => {
  const idle = createService("worker");
  const running = createService("worker", "m3-jobs", () => true);
  try {
    assert.equal((await idle.inject("/health/ready")).statusCode, 503);
    assert.equal((await idle.inject("/health/live")).statusCode, 200);
    assert.equal((await running.inject("/health/ready")).statusCode, 200);
  } finally {
    await Promise.all([idle.close(), running.close()]);
  }
});

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("TIMEOUT_WAITING_FOR_CONDITION");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const timing = { pollIntervalMs: 5, leaseMs: 60_000, heartbeatMs: 10 };

async function withDb(
  run: (
    s: Awaited<ReturnType<typeof migratedPglite>>,
    queue: JobQueue,
  ) => Promise<void>,
) {
  const s = await migratedPglite();
  try {
    await run(s, postgresJobQueue(s.pool));
  } finally {
    await s.db.close();
  }
}

const jobState = async (
  s: Awaited<ReturnType<typeof migratedPglite>>,
  jobId: string,
) =>
  (
    await s.pool.query(
      "SELECT state, attempt, last_error_code FROM operations.jobs WHERE id=$1",
      [jobId],
    )
  ).rows[0];

function scriptedQueue(
  job: LeasedJob,
  heartbeat: () => Promise<boolean>,
  calls: string[],
): JobQueue {
  let leased = false;
  return {
    enqueue: async () => {
      throw new Error("unused");
    },
    lease: async () => {
      calls.push("lease");
      if (leased) return null;
      leased = true;
      return job;
    },
    heartbeat: async () => {
      calls.push("heartbeat");
      return heartbeat();
    },
    complete: async () => {
      calls.push("complete");
      return true;
    },
    fail: async () => {
      calls.push("fail");
      return "RETRY";
    },
    stats: async () => ({ queued: 0, leased: 0, dead: 0 }),
  };
}

const leasedJob: LeasedJob = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "evidence.fetch",
  payload: {},
  attempt: 1,
  maxAttempts: 3,
  leaseToken: "1",
  workerId: "w",
};

test("a failed heartbeat aborts the handler and nothing is acknowledged", async () => {
  for (const heartbeat of [
    async () => false,
    async (): Promise<boolean> => {
      throw new Error("DATABASE_DOWN");
    },
  ]) {
    const calls: string[] = [];
    const errors: string[] = [];
    let aborted = false;
    const worker = startWorker({
      queue: scriptedQueue(leasedJob, heartbeat, calls),
      handlers: {
        "evidence.fetch": ({ signal }) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                // A handler that surfaces the abort as an error is not failed either.
                reject(new Error("ABORTED"));
              },
              { once: true },
            );
          }),
      },
      workerId: "w",
      ...timing,
      onError: (code) => errors.push(code),
    });
    await eventually(() => aborted);
    await eventually(() => errors.length > 0);
    await worker.stop();
    assert.ok(calls.includes("heartbeat"));
    assert.ok(!calls.includes("complete"));
    assert.ok(!calls.includes("fail"));
    assert.deepEqual(errors, ["LEASE_LOST"]);
    assert.equal(worker.running(), false);
  }
});

test("a successful handler heartbeats while it runs and then completes the job", () =>
  withDb(async (s, queue) => {
    const { jobId } = await queue.enqueue({
      type: "evidence.fetch",
      dedupeKey: "ok",
      payload: { n: 1 },
    });
    let beats = 0;
    let seenPayload: unknown;
    const worker = startWorker({
      queue: {
        ...queue,
        heartbeat: async (job, leaseMs) => {
          beats += 1;
          return queue.heartbeat(job, leaseMs);
        },
      },
      handlers: {
        "evidence.fetch": async ({ job, signal }) => {
          seenPayload = job.payload;
          await new Promise((resolve) => setTimeout(resolve, 80));
          assert.equal(signal.aborted, false);
        },
      },
      workerId: "w",
      ...timing,
    });
    await eventually(
      async () => (await jobState(s, jobId)).state === "SUCCEEDED",
    );
    await worker.stop();
    assert.deepEqual(seenPayload, { n: 1 });
    assert.ok(beats >= 1, "heartbeat ran during the handler");
  }));

test("a non-retryable JobError dead-letters the job", () =>
  withDb(async (s, queue) => {
    const { jobId } = await queue.enqueue({
      type: "evidence.fetch",
      dedupeKey: "dead",
      payload: {},
    });
    const errors: string[] = [];
    const worker = startWorker({
      queue,
      handlers: {
        "evidence.fetch": async () => {
          throw new JobError("SOURCE_REJECTED", false);
        },
      },
      workerId: "w",
      ...timing,
      onError: (code) => errors.push(code),
    });
    await eventually(async () => (await jobState(s, jobId)).state === "DEAD");
    await worker.stop();
    assert.deepEqual(await jobState(s, jobId), {
      state: "DEAD",
      attempt: 1,
      last_error_code: "SOURCE_REJECTED",
    });
    assert.deepEqual(errors, ["SOURCE_REJECTED"]);
  }));

test("any other error is retried as INTERNAL_ERROR", () =>
  withDb(async (s, queue) => {
    const { jobId } = await queue.enqueue({
      type: "evidence.fetch",
      dedupeKey: "boom",
      payload: {},
    });
    const worker = startWorker({
      queue,
      handlers: {
        "evidence.fetch": async () => {
          throw new Error("secret detail must not leak");
        },
      },
      workerId: "w",
      ...timing,
    });
    await eventually(
      async () =>
        (await jobState(s, jobId)).last_error_code === "INTERNAL_ERROR",
    );
    await worker.stop();
    assert.deepEqual(await jobState(s, jobId), {
      state: "QUEUED",
      attempt: 1,
      last_error_code: "INTERNAL_ERROR",
    });
  }));

test("only job types with a handler are leased, and an empty map never polls", async () => {
  const calls: string[] = [];
  const idle = startWorker({
    queue: scriptedQueue(leasedJob, async () => true, calls),
    handlers: {},
    workerId: "w",
    ...timing,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await idle.stop();
  assert.deepEqual(calls, []);

  await withDb(async (s, queue) => {
    const other = await queue.enqueue({
      type: "keeper.finalize",
      dedupeKey: "not-mine",
      payload: {},
    });
    const mine = await queue.enqueue({
      type: "evidence.fetch",
      dedupeKey: "mine",
      payload: {},
    });
    const worker = startWorker({
      queue,
      handlers: { "evidence.fetch": async () => {} },
      workerId: "w",
      ...timing,
    });
    await eventually(
      async () => (await jobState(s, mine.jobId)).state === "SUCCEEDED",
    );
    await worker.stop();
    assert.equal((await jobState(s, other.jobId)).state, "QUEUED");
  });
});

test("stop() lets the current job finish and claims nothing new", () =>
  withDb(async (s, queue) => {
    const first = await queue.enqueue({
      type: "evidence.fetch",
      dedupeKey: "first",
      payload: {},
      runAt: new Date(Date.now() - 2000),
    });
    const second = await queue.enqueue({
      type: "evidence.fetch",
      dedupeKey: "second",
      payload: {},
      runAt: new Date(Date.now() - 1000),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const worker = startWorker({
      queue,
      handlers: {
        "evidence.fetch": async () => {
          started = true;
          await gate;
        },
      },
      workerId: "w",
      ...timing,
    });
    await eventually(() => started);
    const stopped = worker.stop();
    assert.equal(worker.running(), true);
    release();
    await stopped;
    assert.equal(worker.running(), false);
    assert.equal((await jobState(s, first.jobId)).state, "SUCCEEDED");
    assert.equal((await jobState(s, second.jobId)).state, "QUEUED");
  }));

test("aborting the worker's own signal cancels the running handler", () =>
  withDb(async (s, queue) => {
    const { jobId } = await queue.enqueue({
      type: "evidence.fetch",
      dedupeKey: "shutdown",
      payload: {},
    });
    const shutdown = new AbortController();
    let handlerAborted = false;
    let started = false;
    const worker = startWorker({
      queue,
      handlers: {
        "evidence.fetch": ({ signal }) =>
          new Promise<void>((_resolve, reject) => {
            started = true;
            signal.addEventListener(
              "abort",
              () => {
                handlerAborted = true;
                reject(new JobError("SHUTDOWN", true));
              },
              { once: true },
            );
          }),
      },
      workerId: "w",
      signal: shutdown.signal,
      ...timing,
    });
    await eventually(() => started);
    shutdown.abort();
    await eventually(() => !worker.running());
    assert.equal(handlerAborted, true);
    assert.deepEqual(await jobState(s, jobId), {
      state: "QUEUED",
      attempt: 1,
      last_error_code: "SHUTDOWN",
    });
  }));

test("schedulePeriodic enqueues one job per time bucket", () =>
  withDb(async (s, queue) => {
    const start = new Date(1_700_000_000_000);
    const payload = { scope: "all" };
    await schedulePeriodic(queue, "budget.reconcile", 60_000, payload, start);
    await schedulePeriodic(
      queue,
      "budget.reconcile",
      60_000,
      payload,
      new Date(start.getTime() + 30_000),
    );
    assert.deepEqual(await queue.stats(), { queued: 1, leased: 0, dead: 0 });
    await schedulePeriodic(
      queue,
      "budget.reconcile",
      60_000,
      payload,
      new Date(start.getTime() + 45_000),
    );
    assert.deepEqual(await queue.stats(), { queued: 2, leased: 0, dead: 0 });
    const keys = (
      await s.pool.query(
        "SELECT dedupe_key FROM operations.jobs ORDER BY dedupe_key",
      )
    ).rows.map((r) => r.dedupe_key);
    assert.deepEqual(keys, [
      `budget.reconcile:{"scope":"all"}:28333333`,
      `budget.reconcile:{"scope":"all"}:28333334`,
    ]);
  }));
