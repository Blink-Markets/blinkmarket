import type {
  AdminPauseState,
  AdminResolutionsResponse,
  AdminJobsResponse,
  AdminBudgetsResponse,
  AdminCandidatesResponse,
} from "@blink/schemas";
export interface OperatorStatusStore {
  pause(): Promise<AdminPauseState>;
  resolutions(operatorId: string): Promise<AdminResolutionsResponse>;
  jobs(state?: string): Promise<AdminJobsResponse>;
  budgets(): Promise<AdminBudgetsResponse>;
  candidates(
    operatorId: string,
    status?: string,
  ): Promise<AdminCandidatesResponse>;
}
