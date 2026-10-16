import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresJobQueue } from "../packages/adapters/src/job-queue.js";
import { startWorker } from "../packages/application/src/worker-runtime.js";
import { TxDispatchError } from "../packages/application/src/tx-dispatcher.js";
import { JobError } from "../packages/domain/src/jobs.js";
import type { JobHandler } from "../packages/ports/src/index.js";
import { reportJobFailures } from "./helpers/job-failures.js";
import { runWithCleanup } from "./helpers/lifecycle.js";
import { migratedPglite } from "./helpers/serial-pglite-pool.js";

const never = () => new Promise<never>(() => {});
// The job as the worker leases it: `attempt` counts leases so far, and the queue dead-letters
// a failure on the last one.
const context = (attempt = 1, maxAttempts = 3): Parameters<JobHandler>[0] =>
  ({
    job: { id: "job", payload: {}, attempt, maxAttempts },
    signal: new AbortController().signal,
  }) as Parameters<JobHandler>[0];
const failing =
  (error: unknown): JobHandler =>
  async () => {
    throw error;
  };

// Runs `work` against handlers that report to the run; resolves with how the run ended.
const ending = (
  handlers: Record<string, JobHandler>,
  work: (wrapped: Record<string, JobHandler>) => Promise<void>,
) =>
  runWithCleanup({}, async (life) => {
    life.stage("scenario normal: external agent");
    await work(reportJobFailures(life, handlers));
    return "completed";
  }).then(
    (value) => value,
    (error: unknown) => String(error),
  );

test("a job that will not be retried ends the run at once naming its type and error code, and still fails for the worker", async () => {
  for (const [type, error, attempt, named] of [
    [
      "faucet.mint",
      new JobError("INVALID_JOB_PAYLOAD", false),
      1,
      "faucet.mint INVALID_JOB_PAYLOAD",
    ],
    // The dispatcher's own flag says it will not be retried, though the worker would retry it.
    [
      "tx.dispatch",
      new TxDispatchError("SIGN_REJECTED:POLICY", false),
      1,
      "tx.dispatch SIGN_REJECTED:POLICY",
    ],
    // Retryable, but on its last attempt: the queue dead-letters it.
    [
      "keeper.finalize",
      new JobError("SIGN_UNKNOWN", true),
      3,
      "keeper.finalize SIGN_UNKNOWN",
    ],
    [
      "keeper.finalize",
      new Error("connect ECONNREFUSED"),
      3,
      "keeper.finalize INTERNAL_ERROR: connect ECONNREFUSED",
    ],
  ] as const) {
    let thrown: unknown;
    const outcome = await ending(
      { [type]: failing(error) },
      async (wrapped) => {
        thrown = await wrapped[type]!(context(attempt)).catch(
          (e: unknown) => e,
        );
        await never(); // the run is waiting on something else when the job fails
      },
    );
    assert.equal(
      outcome,
      `Error: LIFECYCLE_ABORTED during scenario normal: external agent: ALPHA_JOB_FAILED: ${named}`,
    );
    assert.equal(thrown, error, "the worker still sees the original error");
  }
});

test("a retryable job failure followed by success does not fail the run", async () => {
  let calls = 0;
  const outcome = await ending(
    {
      "faucet.mint": async () => {
        if (++calls === 1) throw new JobError("SIGN_UNKNOWN", true);
      },
      "tx.dispatch": failing(
        new TxDispatchError("ATTEMPT_UPDATE_CONFLICT", true),
      ),
      "keeper.finalize": failing(new Error("connect ECONNREFUSED")),
    },
    async (wrapped) => {
      await assert.rejects(wrapped["faucet.mint"]!(context(1)), /SIGN_UNKNOWN/);
      await wrapped["faucet.mint"]!(context(2));
      await assert.rejects(wrapped["tx.dispatch"]!(context(1)));
      await assert.rejects(wrapped["keeper.finalize"]!(context(2)));
    },
  );
  assert.equal(outcome, "completed");
});

test("retryable job failures are named, counted once per kind, in a later failure of the run", async () => {
  const outcome = await ending(
    {
      "keeper.finalize": failing(new JobError("SIGN_UNKNOWN", true)),
      "tx.dispatch": failing(new Error("connect ECONNREFUSED")),
    },
    async (wrapped) => {
      for (const attempt of [1, 2])
        await assert.rejects(wrapped["keeper.finalize"]!(context(attempt)));
      await assert.rejects(wrapped["tx.dispatch"]!(context(1)));
      throw new Error("ALPHA_KEEPER_DID_NOT_FINALIZE");
    },
  );
  assert.equal(
    outcome,
    "Error: ALPHA_KEEPER_DID_NOT_FINALIZE; recorded: keeper.finalize SIGN_UNKNOWN (retryable) x2, tx.dispatch INTERNAL_ERROR: connect ECONNREFUSED (retryable)",
  );
});

test("a transaction that is only waiting for finality is neither a failure nor recorded", async () => {
  const outcome = await ending(
    {
      "tx.dispatch": failing(new TxDispatchError("TX_PENDING", true)),
      "faucet.mint": async () => {},
    },
    async (wrapped) => {
      // Not even its last attempt: Anvil never finalizes, so every dispatch job runs out.
      await assert.rejects(
        wrapped["tx.dispatch"]!(context(10, 10)),
        /TX_PENDING/,
      );
      await wrapped["faucet.mint"]!(context());
      throw new Error("ALPHA_KEEPER_DID_NOT_FINALIZE");
    },
  );
  assert.equal(outcome, "Error: ALPHA_KEEPER_DID_NOT_FINALIZE");
});

test("a job that dies in the real worker ends the run naming its type and code", async () => {
  const s = await migratedPglite();
  try {
    const queue = postgresJobQueue(s.pool);
    const { jobId } = await queue.enqueue({
      type: "faucet.mint",
      dedupeKey: "mint",
      payload: {},
    });
    const outcome = await runWithCleanup({}, async (life) => {
      life.stage("scenario dispute: external agent");
      const worker = startWorker({
        queue,
        handlers: reportJobFailures(life, {
          "faucet.mint": failing(new JobError("INVALID_JOB_PAYLOAD", false)),
        }),
        workerId: "w",
        pollIntervalMs: 5,
      });
      life.add("worker", () => worker.stop());
      await never();
    }).catch((error: unknown) => String(error));
    assert.equal(
      outcome,
      "Error: LIFECYCLE_ABORTED during scenario dispute: external agent: ALPHA_JOB_FAILED: faucet.mint INVALID_JOB_PAYLOAD",
    );
    // The queue dead-letters it as it always did.
    const { rows } = await s.pool.query(
      "SELECT state,last_error_code FROM operations.jobs WHERE id=$1",
      [jobId],
    );
    assert.deepEqual(rows[0], {
      state: "DEAD",
      last_error_code: "INVALID_JOB_PAYLOAD",
    });
  } finally {
    await s.db.close();
  }
});

test("a job the real worker retries is recorded, not failed, until its last attempt", async () => {
  const s = await migratedPglite();
  try {
    const queue = postgresJobQueue(s.pool);
    await queue.enqueue({
      type: "faucet.mint",
      dedupeKey: "mint",
      payload: {},
    });
    const outcome = await runWithCleanup({}, async (life) => {
      const worker = startWorker({
        queue,
        handlers: reportJobFailures(life, {
          "faucet.mint": failing(new JobError("SIGN_UNKNOWN", true)),
        }),
        workerId: "w",
        pollIntervalMs: 5,
      });
      life.add("worker", () => worker.stop());
      // The queue retries the job after its first lease.
      for (let n = 0; n < 400; n++) {
        const { rows } = await s.pool.query(
          "SELECT state,attempt FROM operations.jobs",
        );
        if (rows[0].attempt >= 1 && rows[0].state === "QUEUED") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("ALPHA_AGENT_FAILED");
    }).catch((error: unknown) => String(error));
    assert.match(
      outcome,
      /^Error: ALPHA_AGENT_FAILED; recorded: faucet\.mint SIGN_UNKNOWN \(retryable\)( x\d+)?$/,
    );
  } finally {
    await s.db.close();
  }
});

test("a job aborted because the harness stopped its worker does not fail the run, even on its last attempt", async () => {
  const stopped = new AbortController();
  stopped.abort();
  const ended = await ending(
    { "tx.dispatch": failing(new TxDispatchError("DISPATCH_ABORTED", false)) },
    async (wrapped) => {
      await assert.rejects(
        wrapped["tx.dispatch"]!({
          ...context(3, 3),
          signal: stopped.signal,
        }),
      );
    },
  );
  assert.equal(ended, "completed");
});
