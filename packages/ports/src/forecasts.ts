import type { IdentityPrincipal, IdentityTransaction } from "./identity.js";

export interface ForecastWindow {
  id: string;
  deploymentId: string;
  marketId: string;
  horizonType: "DAILY" | "PRE_CLOSE";
  scheduledAt: Date;
  openAt: Date;
  deadline: Date;
}
export interface ForecastInput {
  horizonKey: { horizonType: "DAILY" | "PRE_CLOSE"; scheduledAt: string };
  probability: number;
  evidenceIds: string[];
  rationale: string;
  agentVersion: string;
}
export interface ForecastSnapshot {
  snapshotId: string;
  windowId: string;
  deadline: Date;
  probabilitySumMillionths: number;
}
export interface ForecastTransaction extends IdentityTransaction {
  windows(
    deploymentId: string,
    marketId: string,
    limit: number,
    after: { scheduledAt: string; horizonType: string } | null,
  ): Promise<ForecastWindow[]>;
  window(
    deploymentId: string,
    marketId: string,
    selector: string | ForecastInput["horizonKey"],
    lock: boolean,
  ): Promise<ForecastWindow | null>;
  marketOpen(
    deploymentId: string,
    marketId: string,
    now: Date,
  ): Promise<boolean>;
  evidenceAllowed(ids: string[], operatorId: string): Promise<boolean>;
  submitted(windowId: string, agentId: string): Promise<boolean>;
  submit(
    id: string,
    window: ForecastWindow,
    principal: IdentityPrincipal,
    input: ForecastInput,
  ): Promise<Date | null>;
  auditForecast(
    actor: string,
    submissionId: string,
    requestId: string,
  ): Promise<void>;
  submissions(
    windowId: string,
    agentId: string | null,
    limit: number,
    after: string | null,
  ): Promise<Record<string, unknown>[]>;
  openMarkets(): Promise<
    { deploymentId: string; marketId: string; closeAt: Date }[]
  >;
  addWindow(window: Omit<ForecastWindow, "id">): Promise<boolean>;
  latestSnapshot(
    deploymentId: string,
    marketId: string,
  ): Promise<ForecastSnapshot | null>;
}
export interface ForecastStore {
  run<T>(work: (tx: ForecastTransaction) => Promise<T>): Promise<T>;
}
