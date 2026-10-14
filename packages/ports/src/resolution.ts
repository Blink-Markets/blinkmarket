import type { IdentityTransaction, IdentityPrincipal } from "./identity.js";
export type ReportState = "RECEIVED" | "TRIAGED" | "DISMISSED" | "ACTIONED";
export interface ResolutionReportInput {
  outcome: "YES" | "NO" | "INVALID";
  evidenceIds: string[];
  reason: string;
}
export interface ResolutionTransaction extends IdentityTransaction {
  marketExists(deploymentId: string, marketId: string): Promise<boolean>;
  evidenceAllowed(ids: string[], operatorId: string): Promise<boolean>;
  submitReport(
    id: string,
    deploymentId: string,
    marketId: string,
    principal: IdentityPrincipal,
    input: ResolutionReportInput,
  ): Promise<void>;
  reportExists(id: string): Promise<boolean>;
  appendEvent(
    id: string,
    state: ReportState,
    actor: string,
    reason: string,
  ): Promise<void>;
  auditResolution(
    actor: string,
    action: "resolution.report_received" | "resolution.report_triaged",
    reportId: string,
    reason: string,
    requestId: string,
  ): Promise<void>;
  reports(
    deploymentId: string,
    marketId: string | null,
    state: ReportState | null,
    limit: number,
    after: string | null,
  ): Promise<Record<string, unknown>[]>;
}
export interface ResolutionStore {
  run<T>(work: (tx: ResolutionTransaction) => Promise<T>): Promise<T>;
}
export type ResolutionParseResult =
  | {
      valueBps: number;
      outcome: "YES" | "NO";
      locator: { start: number; end: number; excerpt: string };
    }
  | { ambiguous: true; reason: string };
export interface ResolutionJobsStore {
  parseEvidence(
    version: string,
    parse: (evidence: {
      uri: string;
      hash: string;
      thresholdBps: number;
    }) => Promise<ResolutionParseResult>,
    signal: AbortSignal,
  ): Promise<void>;
  alertDeadlines(
    thresholds: { LIVE: readonly number[]; REPLAY: readonly number[] },
    signal: AbortSignal,
  ): Promise<void>;
}
