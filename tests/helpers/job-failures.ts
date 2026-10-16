import type { JobHandler } from "../../packages/ports/src/index.js";
import type { Lifecycle } from "./lifecycle.js";

// Wraps job handlers so a job failure is named by its type and error code (a `JobError` or
// `TxDispatchError` carries one; anything else is the worker's INTERNAL_ERROR, named with its
// message). The error still reaches the worker, so queue behavior is unchanged.
//
// A failure that ends the job for good ends the run at once (ALPHA_JOB_FAILED): the error says
// it will not be retried, or this was the last attempt, which the queue dead-letters. Any other
// is retried and may succeed, so it is only noted: if the run fails later, whatever the reason,
// its error lists the noted failures. A `tx.dispatch` job answers TX_PENDING until its
// transaction is FINALIZED, and Anvil's finalized block stays 0: that is waiting, not failing.
export function reportJobFailures<H extends Record<string, JobHandler>>(
  life: Pick<Lifecycle, "fail" | "note" | "signal">,
  handlers: H,
): H {
  return Object.fromEntries(
    Object.entries(handlers).map(([type, handler]) => [
      type,
      (async (context) => {
        try {
          await handler(context);
        } catch (error) {
          const { code, retryable } = error as {
            code?: unknown;
            retryable?: unknown;
          };
          const named = typeof code === "string" ? code : "INTERNAL_ERROR";
          const message =
            error instanceof Error ? error.message : String(error);
          const failure = `${type} ${named}${message === named ? "" : ": " + message}`;
          // A run that is already ending, or a worker the harness stops (the restore drill),
          // aborted its jobs itself: those are no failures. The worker retries whatever does not
          // say otherwise.
          if (
            !life.signal.aborted &&
            !context.signal.aborted &&
            !(type === "tx.dispatch" && named === "TX_PENDING")
          ) {
            if (
              retryable === false ||
              context.job.attempt >= context.job.maxAttempts
            )
              life.fail(
                new Error("ALPHA_JOB_FAILED: " + failure, { cause: error }),
              );
            else life.note(failure + " (retryable)");
          }
          throw error;
        }
      }) satisfies JobHandler,
    ]),
  ) as H;
}
