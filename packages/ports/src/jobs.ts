import type { JobType } from "@blink/domain";
// Adapters may import only schemas and ports (scripts/check-boundaries.mjs), so the
// domain error and backoff they use are re-exported here.
export { JobError, retryDelayMs } from "@blink/domain";

export interface JobSpec {
  type: JobType;
  dedupeKey: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}
export interface LeasedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  leaseToken: string;
  workerId: string;
}
// Every acknowledgement is fenced by the lease owner and token: a stale holder gets false/"STALE".
export interface JobQueue {
  enqueue(spec: JobSpec): Promise<{ jobId: string; created: boolean }>;
  lease(
    workerId: string,
    types: readonly JobType[],
    leaseMs: number,
  ): Promise<LeasedJob | null>;
  heartbeat(job: LeasedJob, leaseMs: number): Promise<boolean>;
  complete(job: LeasedJob): Promise<boolean>;
  fail(
    job: LeasedJob,
    error: { code: string; retryable: boolean },
  ): Promise<"RETRY" | "DEAD" | "STALE">;
  stats(): Promise<{ queued: number; leased: number; dead: number }>;
}
// The signal aborts when the lease is lost or the worker is shut down; handlers must honor it.
export interface JobContext {
  job: LeasedJob;
  signal: AbortSignal;
}
export type JobHandler = (context: JobContext) => Promise<void>;
