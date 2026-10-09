import type { DeploymentManifest, CreationChainStatus } from "@blink/schemas";
import type { CreationIntent } from "./approval.js";

export interface TrackedCreation {
  intent: CreationIntent;
  manifest: DeploymentManifest;
  status: CreationChainStatus;
}
export type CreationObservation = Omit<
  CreationChainStatus,
  "creationIntentId" | "version" | "observedAt"
>;
export interface CreationTrackerStore {
  load(id: string): Promise<TrackedCreation | null>;
  save(
    id: string,
    expectedVersion: number,
    observation: CreationObservation,
    lease?: CreationTrackingLease,
    signal?: AbortSignal,
  ): Promise<CreationChainStatus>;
}
export interface CreationReceiptReader {
  observe(
    creation: TrackedCreation,
    txHash: string,
    signal?: AbortSignal,
  ): Promise<CreationObservation>;
}

export interface CreationTrackingLease {
  intentId: string;
  txHash: string;
  workerId: string;
  leaseToken: string;
  attempt: number;
}

export interface CreationTrackingBacklog {
  tracked: number;
  due: number;
  leased: number;
  failing: number;
  oldestDueAt: string | null;
}

export interface CreationTrackingSchedule {
  claim(workerId: string, leaseMs: number): Promise<CreationTrackingLease | null>;
  complete(lease: CreationTrackingLease, nextPollDelayMs: number): Promise<boolean>;
  fail(
    lease: CreationTrackingLease,
    errorCode: string,
    retryDelayMs: number,
  ): Promise<boolean>;
  health(): Promise<CreationTrackingBacklog>;
}
