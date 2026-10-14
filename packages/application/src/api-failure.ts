import { JobError } from "@blink/domain";

/**
 * The public API's error envelope as @blink/client reports it (status plus body),
 * recognized structurally because application code never imports the client.
 * Null means the call did not get an API answer at all (network, bad response).
 */
export function apiFailure(
  error: unknown,
): { status: number; code: string; retryable: boolean } | null {
  if (typeof error !== "object" || error === null) return null;
  const { status, body } = error as { status?: unknown; body?: unknown };
  if (typeof status !== "number" || typeof body !== "object" || body === null)
    return null;
  const { code, retryable } = body as { code?: unknown; retryable?: unknown };
  if (typeof code !== "string") return null;
  return { status, code, retryable: retryable === true };
}

/** An API refusal keeps its code and retryability; no answer at all is worth a retry. */
export function apiJobError(error: unknown): JobError {
  const failure = apiFailure(error);
  return failure
    ? new JobError(failure.code, failure.retryable)
    : new JobError("API_UNAVAILABLE", true);
}
