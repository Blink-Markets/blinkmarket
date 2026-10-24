import type { TransactionHint, TrackedTransaction } from "./tx-tracking.js";
import type { ChainCursor } from "@blink/schemas";
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
  limit?: number;
  cursor?: string;
}
export interface PositionReadRow {
  market: IndexedMarketRow;
  yesShares: string;
  noShares: string;
  pendingIntentIds: string[];
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
