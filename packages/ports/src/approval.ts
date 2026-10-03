import type { DeploymentManifest } from "@blink/schemas";
import type { PreparationTransaction } from "./preparation.js";
import type { IdentityResponse } from "./identity.js";

export interface CreationIntent {
  creationIntentId: string;
  approvalId: string;
  deploymentId: string;
  state: "AWAITING_ADMIN_SIGNATURE";
  chainId: 84532;
  to: string;
  requiredSender: string;
  value: "0";
  specHash: string;
  specUri: string;
  calldata: string;
}
export interface ApprovalWrite {
  approvalId: string;
  candidateId: string;
  revision: number;
  deploymentId: string;
  actorKeyId: string;
  budgetMicros: string;
  reason: string;
  specHash: string;
  objectUri: string;
  publicUri: string;
  intent: CreationIntent;
}
export interface ApprovalTransaction extends PreparationTransaction {
  evidenceObject(id: string): Promise<{ uri: string; hash: string } | null>;
  cached(
    operatorId: string,
    scope: string,
    key: string,
    hash: string,
  ): Promise<IdentityResponse | null>;
  deployment(
    id: string,
  ): Promise<{
    manifest: DeploymentManifest;
    verifiedAt: Date;
    enabled: boolean;
  } | null>;
  reserveSlot(
    slot: string,
    canonical: string,
    intentId: string,
  ): Promise<boolean>;
  saveApproval(write: ApprovalWrite): Promise<void>;
  intent(id: string): Promise<CreationIntent | null>;
  spec(hash: string): Promise<{ objectUri: string } | null>;
}
export interface ApprovalStore {
  run<T>(work: (tx: ApprovalTransaction) => Promise<T>): Promise<T>;
}
