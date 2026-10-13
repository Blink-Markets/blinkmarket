import type { ChainCursor, DeploymentManifest } from "@blink/schemas";
import type { IdentityPrincipal, IdentityResponse } from "./identity.js";

export interface IndexCursorRow {
  blockNumber: string;
  blockHash: string;
  finalizedNumber: string | null;
  gateReason: string | null;
  stale: boolean;
}
export interface IndexedMarketRow {
  deploymentId: string;
  marketId: string;
  mode: "LIVE" | "REPLAY";
  specHash: string;
  specUri: string;
  storedState: "OPEN" | "PROPOSED" | "DISPUTED" | "FINAL";
  effectiveState: "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL";
  paused: boolean;
  createdBlockNumber: string;
  cursor: IndexCursorRow | null;
  proposedOutcome: "YES" | "NO" | "INVALID" | null;
  finalOutcome: "YES" | "NO" | "INVALID" | null;
  proposalEvidenceHash: string | null;
  finalEvidenceHash: string | null;
  proposedAt: string | null;
  challengeSeconds: number;
  hardDeadline: string;
}
export interface MarketListQuery {
  deploymentId?: string;
  mode?: string;
  status?: string;
  entity?: string;
  limit?: number;
  cursor?: string;
}
export interface PositionReadRow {
  market: IndexedMarketRow;
  yesShares: string;
  noShares: string;
  pendingIntentIds: string[];
}
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
export interface MarketReadStore {
  list(
    query: MarketListQuery,
  ): Promise<{ items: IndexedMarketRow[]; nextCursor: string | null }>;
  market(
    deploymentId: string,
    marketId: string,
  ): Promise<IndexedMarketRow | null>;
  positions(
    deploymentId: string,
    wallet: string,
    query: MarketListQuery,
  ): Promise<{ items: PositionReadRow[]; nextCursor: string | null }>;
  integrityFailure(market: IndexedMarketRow, requestId: string): Promise<void>;
  hint(
    principal: IdentityPrincipal & { wallet: string | null },
    body: TransactionHint,
    key: string,
  ): Promise<IdentityResponse>;
  transaction(
    deploymentId: string,
    hash: string,
  ): Promise<(TrackedTransaction & { chainCursor: ChainCursor | null }) | null>;
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
