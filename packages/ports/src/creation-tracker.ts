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
  ): Promise<CreationChainStatus>;
}
export interface CreationReceiptReader {
  observe(
    creation: TrackedCreation,
    txHash: string,
  ): Promise<CreationObservation>;
}
