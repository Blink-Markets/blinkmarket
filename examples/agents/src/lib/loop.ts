import { BlinkApiError } from "@blink/client";
import type { AgentContext } from "./env.ts";

export type RoleTick = (ctx: AgentContext) => Promise<void>;

export type RunOptions = {
  /** Pause between rounds of ticks. */
  tickMs: number;
  /** Aborted by SIGTERM: the loop ends after the tick that is running. */
  signal?: AbortSignal;
  /** Replaced in tests. Resolves early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULT_RETRY_AFTER_SECONDS = 5;

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });

/** The API is asking the agent to slow down: the index lags (503 INDEX_STALE) or it is rate limited (429). */
const isBackoff = (error: unknown): error is BlinkApiError =>
  error instanceof BlinkApiError &&
  (error.status === 429 || (error.status === 503 && error.body.code === "INDEX_STALE"));

/**
 * Runs every tick, in order, each round. A backoff answer skips the rest of that round and waits
 * for the server's Retry-After (5 seconds without one); any other error is logged and the loop
 * goes on, so one failing role never stops the others.
 */
export async function runAgent(
  ctx: AgentContext,
  ticks: RoleTick[],
  { tickMs, signal, sleep = abortableSleep }: RunOptions,
): Promise<void> {
  while (!signal?.aborted) {
    let waitMs = tickMs;
    for (const tick of ticks) {
      try {
        await tick(ctx);
      } catch (error) {
        if (isBackoff(error)) {
          // The server's own figure, however long: asking sooner would only be refused again.
          const seconds = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
          ctx.log("backoff", { status: error.status, code: error.body.code, retryAfterSeconds: seconds });
          waitMs = seconds * 1000;
          break;
        }
        ctx.log("tick_error", {
          code: error instanceof BlinkApiError ? error.body.code : errorCode(error),
        });
      }
      // The tick that was running has finished; do not start the next role's.
      if (signal?.aborted) return;
    }
    await sleep(waitMs, signal);
  }
}

/** A short code for the log: the message when it is a code (`NO_USABLE_QUOTE`), otherwise the error name. */
function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const match = /^[A-Z][A-Z0-9_]{2,63}/.exec(error.message);
    return match ? match[0] : error.name;
  }
  return "UNKNOWN";
}
