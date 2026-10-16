import type { JobHandler } from "../../packages/ports/src/index.js";
import type { Lifecycle } from "./lifecycle.js";

// Wraps job handlers so a job that throws ends the run with its type and error code (a
// `JobError` or `TxDispatchError` carries one; anything else is the worker's INTERNAL_ERROR,
// named with its message). The error still reaches the worker, so queue behavior is unchanged.
// A `tx.dispatch` job answers TX_PENDING until its transaction is FINALIZED, and Anvil's
// finalized block stays 0: that is waiting, not failing.
export function reportJobFailures<H extends Record<string, JobHandler>>(
  life: Pick<Lifecycle, "fail">,
  handlers: H,
): H {
  return Object.fromEntries(
    Object.entries(handlers).map(([type, handler]) => [
      type,
      (async (context) => {
        try {
          await handler(context);
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          const named = typeof code === "string" ? code : "INTERNAL_ERROR";
          const message =
            error instanceof Error ? error.message : String(error);
          if (!(type === "tx.dispatch" && named === "TX_PENDING"))
            life.fail(
              new Error(
                `ALPHA_JOB_FAILED: ${type} ${named}${message === named ? "" : ": " + message}`,
                { cause: error },
              ),
            );
          throw error;
        }
      }) satisfies JobHandler,
    ]),
  ) as H;
}
