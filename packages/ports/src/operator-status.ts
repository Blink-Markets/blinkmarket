import type { AdminPauseState, AdminJobsResponse } from "@blink/schemas";
export interface OperatorStatusStore {
  pause(): Promise<AdminPauseState>;
  jobs(state?: string): Promise<AdminJobsResponse>;
}
