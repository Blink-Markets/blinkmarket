import type { IdentityTransaction } from "./identity.js";
import type { Hex } from "./signing.js";

// --- the chain, read at one canonical block -------------------------------------------------

export interface ChainHead {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}
/** Everything an RFQ needs from the contract, all read at the same block hash. */
export interface TradingChainView {
  market: {
    state: "OPEN" | "PROPOSED" | "DISPUTED" | "FINAL";
    paused: boolean;
    closeAt: bigint;
    maxPairs: bigint;
    maxTakerShares: bigint;
    totalMintedPairs: bigint;
  };
  globalTradingPaused: boolean;
  makerFreeMicros: bigint;
  makerEpoch: bigint;
  takerAllowed: boolean;
  cumulativeTakerShares: bigint;
}
/** The RFQ's view of the chain: the RPC head, then contract reads pinned to that head's hash. */
export interface ChainSnapshotReader {
  chainId(): Promise<number>;
  head(): Promise<ChainHead>;
  /** Fails when the block is no longer canonical, so a read never mixes two branches. */
  read(input: {
    blockHash: Hex;
    marketId: bigint;
    taker: Hex;
  }): Promise<TradingChainView>;
}

// --- records --------------------------------------------------------------------------------

export type QuoteStatus =
  | "SIGN_REQUESTED"
  | "SIGNED"
  | "SIGN_UNKNOWN"
  | "SIGN_REJECTED"
  | "EXPIRED"
  | "CANCELLED"
  | "CONSUMED";
export type ReservationState =
  "HELD" | "RECONCILE_REQUIRED" | "ACCOUNTED" | "RELEASED";

/** The indexer's cursor as the trading code reads it; `stale` is judged on the database clock. */
export interface TradingCursor {
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: bigint;
  headNumber: bigint;
  finalizedNumber: bigint | null;
  gateReason: string | null;
  stale: boolean;
}
export interface TradingMarket {
  mode: "LIVE" | "REPLAY";
  specHash: Hex;
  closeAt: bigint;
}
export interface NewQuote {
  id: string;
  reservationId: string;
  operatorId: string;
  idempotencyKey: string;
  deploymentId: string;
  marketId: bigint;
  agentId: string;
  keyId: string;
  taker: Hex;
  side: "YES" | "NO";
  quantity: bigint;
  priceBps: number;
  takerCostMicros: bigint;
  makerCostMicros: bigint;
  maxCostMicros: bigint;
  validAfter: bigint;
  expiresAt: bigint;
  nonce: bigint;
  epoch: bigint;
  specHash: Hex;
  digest: Hex;
  forecastSnapshotId: string;
  snapshotBlockNumber: bigint;
  snapshotBlockHash: Hex;
  /** The Quote struct with decimal-string integers: the signer's unsigned payload. */
  message: Record<string, string>;
  policyVersion: string;
}
export interface QuoteRecord extends Omit<
  NewQuote,
  "reservationId" | "message" | "policyVersion"
> {
  signRequestId: string;
  updatedAt: Date;
  status: QuoteStatus;
  envelope: Record<string, unknown> | null;
}
/** A held reservation together with what the canonical projection says about its digest. */
export interface OpenReservation {
  reservationId: string;
  quoteId: string;
  amountMicros: bigint;
  quoteEpoch: bigint;
  expiresAt: bigint;
  digest: {
    state: "FILLED" | "CANCELLED";
    blockNumber: bigint;
    blockHash: Hex;
  } | null;
}
export interface ReservationSettlement {
  reservationId: string;
  quoteId: string;
  to: "ACCOUNTED" | "RELEASED";
  quoteStatus: "CONSUMED" | "CANCELLED" | "EXPIRED";
  blockNumber: bigint;
  blockHash: Hex;
  reason: string;
}

// --- the store ------------------------------------------------------------------------------

/**
 * One database transaction of the trading code. RFQ requests and reconciliation take the pool lock
 * before they touch reservations; the other lock orders are in docs/M2_RFQ.md.
 */
export interface TradingTransaction extends IdentityTransaction {
  /** Committed payload hash, checked before an RFQ resumes a busy idempotency key. */
  requestPayloadHash(
    operatorId: string,
    scope: string,
    key: string,
  ): Promise<string | null>;
  deployment(
    deploymentId: string,
  ): Promise<{ manifest: unknown; enabled: boolean } | null>;
  market(deploymentId: string, marketId: bigint): Promise<TradingMarket | null>;
  cursor(deploymentId: string): Promise<TradingCursor | null>;
  /** Reasons of every open quote gate on the market. */
  openGates(deploymentId: string, marketId: bigint): Promise<string[]>;
  /** The pool's gate without locking it (creates nothing). */
  poolGate(deploymentId: string): Promise<string | null>;
  /** Creates the pool row if missing and locks it until the transaction ends. */
  lockPool(
    deploymentId: string,
  ): Promise<{ gateReason: string | null; version: bigint }>;
  /** A settled reservation whose block left the canonical chain still waits for reconciliation. */
  needsReconcile(deploymentId: string): Promise<boolean>;
  /** Quotes of this taker that can still be filled at the given canonical block time. */
  outstandingQuotes(
    deploymentId: string,
    taker: string,
    blockTimestamp: bigint,
  ): Promise<number>;
  /**
   * HELD and RECONCILE_REQUIRED amounts, plus fills accounted above `headNumber`: those are not in
   * the free balance read at that head yet.
   */
  reservedMicros(deploymentId: string, headNumber: bigint): Promise<bigint>;
  /** The intent, sign request, quote and HELD reservation, and the pool version bump. */
  createQuote(input: NewQuote): Promise<{ signRequestId: string }>;
  quoteByKey(
    operatorId: string,
    idempotencyKey: string,
  ): Promise<QuoteRecord | null>;
  quoteByDigest(
    deploymentId: string,
    digest: string,
  ): Promise<QuoteRecord | null>;
  /** Locks the quote row until the transaction ends. */
  lockQuote(id: string): Promise<QuoteRecord | null>;
  /** What the canonical projection says about a signed quote. */
  quoteChainState(
    deploymentId: string,
    digest: string,
  ): Promise<{
    digest: "FILLED" | "CANCELLED" | null;
    makerEpoch: bigint | null;
  }>;
  /** False when the quote is no longer waiting for a signature. */
  markSigned(
    quoteId: string,
    envelope: Record<string, unknown>,
  ): Promise<boolean>;
  markSignUnknown(quoteId: string): Promise<void>;
  /** Never signed, so the reservation is released at once. */
  markSignRejected(quoteId: string, code: string): Promise<void>;
  // --- reconciliation ---
  /** ACCOUNTED/RELEASED reservations whose block is no longer canonical go back to RECONCILE_REQUIRED. */
  reopenOrphaned(deploymentId: string): Promise<number>;
  openReservations(deploymentId: string): Promise<OpenReservation[]>;
  /** False when the reservation had already left HELD/RECONCILE_REQUIRED. */
  settle(settlement: ReservationSettlement): Promise<boolean>;
  /** The maker's free balance and epoch at the indexer's cursor. */
  makerState(
    deploymentId: string,
  ): Promise<{ freeMicros: bigint; epoch: bigint } | null>;
  heldMicros(deploymentId: string): Promise<bigint>;
  /** Sets or clears the gate; the pool version moves only when the gate does. */
  setPoolGate(deploymentId: string, reason: string | null): Promise<void>;
  /** Moves the pool version after reservations changed. */
  bumpPool(deploymentId: string): Promise<void>;
}
export interface TradingStore {
  run<T>(work: (tx: TradingTransaction) => Promise<T>): Promise<T>;
}

/** What the signer's quote check needs: the quote with this digest and its reservation. */
export interface ReservationReader {
  /** Reads inside the signer's own transaction (`client` is that transaction's database client). */
  reservationFor(
    client: unknown,
    digest: string,
  ): Promise<{
    quoteStatus: QuoteStatus;
    reservationState: ReservationState;
    amountMicros: bigint;
  } | null>;
}
