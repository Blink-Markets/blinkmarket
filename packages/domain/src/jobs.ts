/** A job or budget failure the queue can classify: `retryable` decides requeue versus dead-letter. */
export class JobError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

/** Exponential backoff: base * 2^(attempt-1), capped. `attempt` is the attempt that just failed (1-based). */
export function retryDelayMs(
  attempt: number,
  baseMs = 5000,
  maxMs = 300000,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
}

/**
 * Attempts for a `tx.dispatch` job. Attempts 1-19 back off 5 s doubling to a 300 s cap, totalling
 * 4215 s (about 70 minutes). Base Sepolia's finalized head trailed by 836-1968 s (14-33 minutes)
 * when measured on 2026-10-21, and a job that dies first alerts and waits for the sweep.
 */
export const TX_DISPATCH_MAX_ATTEMPTS = 20;
