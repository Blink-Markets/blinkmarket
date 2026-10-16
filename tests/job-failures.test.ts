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
const context = (): Parameters<JobHandler>[0] =>
  ({
    job: { id: "job", payload: {} },
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

test("a failed job ends the run naming its type and error code, and still fails for the worker", async () => {
  for (const [type, error, named] of [
    [
      "faucet.mint",
      new JobError("SIGN_UNKNOWN", true),
      "faucet.mint SIGN_UNKNOWN",
    ],
    [
      "keeper.finalize",
      new JobError("OPERATION_ABORTED", true),
      "keeper.finalize OPERATION_ABORTED",
    ],
    [
      "tx.dispatch",
      new TxDispatchError("SIGN_REJECTED:POLICY", false),
      "tx.dispatch SIGN_REJECTED:POLICY",
    ],
    [
      "keeper.finalize",
      new Error("connect ECONNREFUSED"),
      "keeper.finalize INTERNAL_ERROR: connect ECONNREFUSED",
    ],
  ] as const) {
    let thrown: unknown;
    const outcome = await ending(
      { [type]: failing(error) },
      async (wrapped) => {
        thrown = await wrapped[type]!(context()).catch((e: unknown) => e);
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

test("a transaction that is only waiting for finality is not a failed job", async () => {
  const outcome = await ending(
    {
      "tx.dispatch": failing(new TxDispatchError("TX_PENDING", true)),
      "faucet.mint": async () => {},
    },
    async (wrapped) => {
      await assert.rejects(wrapped["tx.dispatch"]!(context()), /TX_PENDING/);
      await wrapped["faucet.mint"]!(context());
    },
  );
  assert.equal(outcome, "completed");
});

test("a job failing in the real worker ends the run naming its type and code", async () => {
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
          "faucet.mint": failing(new JobError("SIGN_UNKNOWN", true)),
        }),
        workerId: "w",
        pollIntervalMs: 5,
      });
      life.add("worker", () => worker.stop());
      await never();
    }).catch((error: unknown) => String(error));
    assert.equal(
      outcome,
      "Error: LIFECYCLE_ABORTED during scenario dispute: external agent: ALPHA_JOB_FAILED: faucet.mint SIGN_UNKNOWN",
    );
    // The queue records the failure as it always did.
    const { rows } = await s.pool.query(
      "SELECT last_error_code FROM operations.jobs WHERE id=$1",
      [jobId],
    );
    assert.equal(rows[0].last_error_code, "SIGN_UNKNOWN");
  } finally {
    await s.db.close();
  }
});
