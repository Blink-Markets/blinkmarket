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
