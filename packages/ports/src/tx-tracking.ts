import type { DeploymentManifest } from "@blink/schemas";

export interface TransactionHint {
  deploymentId: string;
  txHash: string;
  action: "APPROVE" | "FILL" | "REDEEM";
  quoteId?: string;
}
export interface TrackedTransaction extends TransactionHint {
  id: string;
  agentId: string;
  wallet: string;
  marketId: string | null;
  status: "UNKNOWN" | "INCLUDED" | "FINALIZED" | "REVERTED" | "REORGED";
  rejectReason: string | null;
  receiptBlockHash: string | null;
  receiptBlockNumber: string | null;
  version: string;
}
export interface TxTrackingStore {
  pending(limit: number): Promise<TrackedTransaction[]>;
  update(
    row: TrackedTransaction,
    next: Pick<
      TrackedTransaction,
      | "status"
      | "rejectReason"
      | "receiptBlockHash"
      | "receiptBlockNumber"
      | "marketId"
    >,
  ): Promise<boolean>;
}
export interface TxObservation {
  chainId: number;
  transaction: {
    from: string;
    to: string | null;
    action: TransactionHint["action"] | null;
    spender?: string;
    quoteDigest?: string;
    marketId?: string;
  } | null;
  receipt: {
    blockHash: string;
    blockNumber: string;
    success: boolean;
    canonical: boolean;
  } | null;
  previousCanonical: boolean | null;
  finalizedNumber: string | null;
}
export interface TxReceiptReader {
  read(
    row: TrackedTransaction,
    manifest: DeploymentManifest,
  ): Promise<TxObservation>;
}
