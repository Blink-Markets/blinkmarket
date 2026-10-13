import { JobError, type JobType } from "@blink/domain";
import type { JobHandler, JobQueue, LeasedJob } from "@blink/ports";

/**
 * Runs one job at a time. A job is acknowledged only while its lease is still
 * ours: a failed heartbeat aborts the handler's signal and nothing is acked,
 * so the job is re-leased after expiry (handlers must honor the signal).
 * Aborting `options.signal` stops claiming and cancels the running handler;
 * `stop()` stops claiming and lets the running handler finish.
 */
export function startWorker(options: {
  queue: JobQueue;
  handlers: Partial<Record<JobType, JobHandler>>;
  workerId: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
  onError?: (code: string) => void;
}): { stop(): Promise<void>; running(): boolean } {
  const { queue, handlers, workerId } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const leaseMs = options.leaseMs ?? 60_000;
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  if (heartbeatMs >= leaseMs) throw new Error("INVALID_WORKER_HEARTBEAT");
  const types = (Object.keys(handlers) as JobType[]).filter(
    (type) => handlers[type] !== undefined,
  );
  const report = (code: string) => {
    try {
      options.onError?.(code);
    } catch {
      // A broken logger must not stop the worker.
    }
  };

  let stopping = false;
  let isRunning = true;
  let active: AbortController | null = null;
  let wake: (() => void) | null = null;

  const pause = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollIntervalMs);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  const shutdown = () => {
    stopping = true;
    active?.abort(new JobError("WORKER_STOPPING", true));
    wake?.();
  };
  if (options.signal?.aborted) shutdown();
  else options.signal?.addEventListener("abort", shutdown, { once: true });

  async function run(job: LeasedJob) {
    const controller = new AbortController();
    active = controller;
    let leaseLost = false;
    let finished = false;
    let beating = false;
    const lose = () => {
      if (finished || leaseLost) return;
      leaseLost = true;
      controller.abort(new JobError("LEASE_LOST", true));
    };
    const heartbeat = setInterval(() => {
      if (beating || leaseLost) return;
      beating = true;
      queue
        .heartbeat(job, leaseMs)
        .then((ok) => ok || lose(), lose)
        .finally(() => {
          beating = false;
        });
    }, heartbeatMs);
    let failure: { error: unknown } | null = null;
    try {
      await handlers[job.type]!({ job, signal: controller.signal });
    } catch (error) {
      failure = { error };
    } finally {
      finished = true;
      clearInterval(heartbeat);
      active = null;
    }
    if (leaseLost) return report("LEASE_LOST");
    try {
      if (!failure) {
        if (!(await queue.complete(job))) report("LEASE_LOST");
        return;
      }
      const error = failure.error;
      const code = error instanceof JobError ? error.code : "INTERNAL_ERROR";
      report(code);
      const outcome = await queue.fail(job, {
        code,
        retryable: error instanceof JobError ? error.retryable : true,
      });
      if (outcome === "STALE") report("LEASE_LOST");
    } catch {
      // The lease will expire and the job will be offered again.
      report("JOB_ACK_FAILED");
    }
  }

  const loop = (async () => {
    try {
      while (!stopping) {
        let job: LeasedJob | null = null;
        try {
          if (types.length > 0)
            job = await queue.lease(workerId, types, leaseMs);
        } catch {
          report("JOB_LEASE_FAILED");
        }
        if (job) await run(job);
        else if (!stopping) await pause();
      }
    } finally {
      isRunning = false;
    }
  })();

  return {
    async stop() {
      stopping = true;
      wake?.();
      await loop;
    },
    running: () => isRunning,
  };
}

/**
 * Enqueues a recurring job at most once per `everyMs` bucket. The bucket comes
 * from the caller's clock, so hosts with skewed clocks can each enqueue near a boundary.
 */
export async function schedulePeriodic(
  queue: JobQueue,
  type: JobType,
  everyMs: number,
  payload: Record<string, unknown>,
  now = new Date(),
): Promise<void> {
  await queue.enqueue({
    type,
    dedupeKey: `${type}:${JSON.stringify(payload)}:${Math.floor(now.getTime() / everyMs)}`,
    payload,
  });
}
