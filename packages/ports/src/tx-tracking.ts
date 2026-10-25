import type { ProtocolDeployment } from "@blink/schemas";

/** The protocol contracts a tracked transaction may target: the current generation, faucet, anchor. */
export type TrackedContract =
  | "registry"
  | "jurors"
  | "markets"
  | "resolution"
  | "faucet"
  | "anchor";
export type TrackedStatus =
  "UNKNOWN" | "INCLUDED" | "FINALIZED" | "REVERTED" | "REORGED";

export interface TrackedTransaction {
  id: string;
  deploymentId: string;
  txHash: string;
  agentId: string;
  wallet: string;
  /** The function name decoded from the protocol ABI; null until the tracker has seen the transaction. */
  action: string | null;
  marketId: string | null;
  status: TrackedStatus;
  rejectReason: string | null;
  receiptBlockHash: string | null;
  receiptBlockNumber: string | null;
  version: string;
}
export type TrackedUpdate = Pick<
  TrackedTransaction,
  | "action"
  | "status"
  | "rejectReason"
  | "receiptBlockHash"
  | "receiptBlockNumber"
  | "marketId"
>;
export interface TxTrackingStore {
  pending(limit: number): Promise<TrackedTransaction[]>;
  update(row: TrackedTransaction, next: TrackedUpdate): Promise<boolean>;
  /**
   * Registers a hash for tracking. A hash that is already tracked keeps its row: the result names
   * the row that exists, so the caller can tell its own hint from another agent's.
   */
  track(input: {
    id: string;
    deploymentId: string;
    txHash: string;
    agentId: string;
    wallet: string;
  }): Promise<{ id: string; agentId: string; status: TrackedStatus }>;
}
export interface TxObservation {
  chainId: number;
  transaction: {
    from: string;
    to: string | null;
    /** The contract `to` is, among the current generation, faucet and anchor; null for any other target. */
    contract: TrackedContract | null;
    /** The decoded function name; null when the calldata matches no function of that contract's ABI. */
    action: string | null;
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
    manifest: ProtocolDeployment,
  ): Promise<TxObservation>;
}
