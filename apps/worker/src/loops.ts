import type { JobType } from "@blink/domain";
import type { JobHandler, JobQueue } from "@blink/ports";
import { startWorker } from "@blink/application";

/**
 * Alert delivery retries forever and may block on a slow sink, so it gets its own loop: the other
 * jobs (keeper.finalize, tx.dispatch, quote.reconcile, ...) never wait behind a hung alert.
 * Each loop leases only the types it has handlers for.
 */
export function startJobLoops(options: {
  queue: JobQueue;
  handlers: Partial<Record<JobType, JobHandler>>;
  alertHandler: JobHandler;
  workerId: string;
  pollIntervalMs?: number;
  onError?: (code: string) => void;
}): { stop(): Promise<void>; running(): boolean } {
  const { alertHandler, handlers, ...shared } = options;
  const { "alert.deliver": _alert, ...others } = handlers;
  const main = startWorker({ ...shared, handlers: others });
  const alerts = startWorker({
    ...shared,
    workerId: options.workerId + ":alerts",
    handlers: { "alert.deliver": alertHandler },
  });
  return {
    async stop() {
      await Promise.all([main.stop(), alerts.stop()]);
    },
    running: () => main.running() && alerts.running(),
  };
}
