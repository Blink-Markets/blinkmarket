import type { CandidateRecord, EvidenceMetadata } from "@blink/schemas";
import type { IdentityTransaction } from "./identity.js";

export interface EvidenceRecord {
  metadata: EvidenceMetadata;
  operatorId: string;
  entityId: string;
  enabled: boolean;
}
export interface CandidateHistory {
  operatorId: string;
  candidate: CandidateRecord;
  revisions: CandidateRecord[];
}
export interface PreparationTransaction extends IdentityTransaction {
  evidence(id: string): Promise<EvidenceRecord | null>;
  candidate(id: string, lock: boolean): Promise<CandidateHistory | null>;
  appendCandidate(
    operatorId: string,
    record: CandidateRecord,
    create: boolean,
  ): Promise<void>;
  recordAudit(
    actor: string,
    action: string,
    resource: string,
    reason: string,
    requestId: string,
  ): Promise<void>;
}
export interface PreparationStore {
  run<T>(work: (tx: PreparationTransaction) => Promise<T>): Promise<T>;
}
