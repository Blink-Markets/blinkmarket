export * from "./modules.ts";
export * from "./chain-reducer.ts";
export * from "./execution.ts";
export * from "./jobs.ts";
export * from "./costs.ts";
export type { MarketRef, ChainCursor, MarketSpec, Quote } from "@blink/schemas";

export type JobType =
  | "evidence.fetch"
  | "discovery.scan"
  | "candidate.validate"
  | "market.deploy"
  | "forecast.schedule"
  | "forecast.dispatch"
  | "forecast.run"
  | "baseline.run"
  | "budget.reconcile"
  | "resolution.parse"
  | "resolution.alerts"
  | "alert.deliver"
  | "alert.evaluate"
  | "evaluation.score"
  | "operations.prune";
export type Job<T extends JobType = JobType> = {
  id: string;
  type: T;
  dedupeKey: string;
  resourceId: string;
  requestId: string;
  attempt: number;
  nextRunAt: string;
  state: "QUEUED" | "LEASED" | "SUCCEEDED" | "DEAD";
  leaseOwner: string | null;
  leaseUntil: string | null;
  leaseToken: string;
};
export type Unimplemented = { status: "not-implemented"; module: string };
// 不提供成功的預設 adapter；use case 實作前不可產生簽章或資金副作用。
export {
  validateReplayApproval,
  ApprovalPolicyError,
  type ApprovalEvidence,
} from "./approval.ts";
export * from "./network-policy.ts";
export * from "./forecast-windows.ts";
export * from "./brier.ts";

export * from "./gm-parser.ts";
export * from "./prompts.ts";
