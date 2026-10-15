import type { MandateRefusal } from "@blink/domain";
import type { SignedQuoteResponse } from "@blink/schemas";
import type { Hex, IntentState } from "./signing.js";
import type { QuoteStatus, TradingCursor } from "./trading.js";

export type TraderRole = "FORECASTER_A" | "FORECASTER_B";

/** One row of `trading.mandates`: what the internal trader may do, and with whose forecasts. */
export interface TraderMandate {
  agentId: string;
  wallet: Hex;
  forecasterRole: TraderRole;
  dailyNotionalCapMicros: bigint;
  openNotionalCapMicros: bigint;
  maxFillShares: number;
  sharesPerTrade: number;
  edgeThresholdBps: number;
  enabled: boolean;
  policyVersion: string;
}

/** One market as the trader's decision sees it. */
export interface TraderMarketView {
  marketId: string;
  specHash: Hex;
  state: "OPEN" | "PROPOSED" | "DISPUTED" | "FINAL";
  paused: boolean;
  closeAt: bigint;
  /** Reasons of every open quote gate on the market. */
  gates: string[];
  /**
   * The latest closed forecast window the RFQ would price from (same rule: closed within 24 hours,
   * both platform forecasters answered, none of the answers annotated), with the mandate's own
   * forecaster's answer. Null when there is none.
   */
  snapshot: {
    windowId: string;
    probabilitySumMillionths: number;
    ownProbabilityMillionths: number;
  } | null;
}
export interface TraderContext {
  deployment: { manifest: unknown; enabled: boolean } | null;
  cursor: TradingCursor | null;
  /** Business clock (blink.now()) in whole seconds. */
  nowSeconds: bigint;
  globalPaused: boolean;
  /** The maker pool's gate reason, if the pool is gated. */
  poolGate: string | null;
  takerAllowed: boolean;
  markets: TraderMarketView[];
}

export type RiskReservationState = "HELD" | "ACCOUNTED" | "RELEASED";
export interface TraderReservation {
  id: string;
  agentId: string;
  intentId: string;
  day: string;
  notionalMicros: bigint;
  state: RiskReservationState;
  deploymentId: string;
  marketId: string;
  windowId: string;
  side: "YES" | "NO";
  shares: number;
  askBps: number;
  ownProbabilityMillionths: number;
  /** Seconds since it was reserved, on the business clock. */
  ageSeconds: number;
}
/** What the signer and dispatcher persisted about one of the trader's transactions. */
export interface TraderIntentFact {
  intentId: string;
  state: IntentState;
  /** The receipt status of the newest attempt a block holds, when one does. */
  mined: "success" | "reverted" | null;
}
/** A reservation with everything the canonical projection and the signing tables say about it. */
export interface TraderTrade {
  reservation: TraderReservation;
  quote: {
    digest: Hex;
    status: QuoteStatus;
    expiresAt: bigint;
    epoch: bigint;
    envelope: Record<string, unknown> | null;
  } | null;
  /** The quote digest in the indexer's projection. */
  digest: "FILLED" | "CANCELLED" | null;
  makerEpoch: bigint | null;
  approve: TraderIntentFact | null;
  fill: TraderIntentFact | null;
  /** Read in the same statement as the rest, so expiry and fill are judged at one canonical block. */
  cursor: TradingCursor | null;
}

export interface NewTraderReservation {
  mandate: TraderMandate;
  intentId: string;
  deploymentId: string;
  marketId: string;
  windowId: string;
  side: "YES" | "NO";
  shares: number;
  askBps: number;
  ownProbabilityMillionths: number;
}
export type TraderReserveResult =
  | { state: "RESERVED"; reservationId: string }
  | { state: "EXISTS"; reservationState: RiskReservationState }
  | { state: "SKIPPED"; reason: MandateRefusal | "MANDATE_DISABLED" };

export interface PrepareTraderIntent {
  deploymentId: string;
  kind: "APPROVE" | "FILL" | "REDEEM";
  dedupeKey: string;
  /** Recorded on the economic intent. */
  payload: Record<string, unknown>;
  /** The call the signer will check and sign: exactly {to, functionName, args}. */
  unsignedPayload: Record<string, unknown>;
}

export interface TraderStore {
  /** The mandate that follows this forecaster; null when none exists, throws when several do. */
  mandate(role: TraderRole): Promise<TraderMandate | null>;
  context(input: {
    deploymentId: string;
    mandate: TraderMandate;
  }): Promise<TraderContext>;
  /**
   * Under the mandate's lock: idempotent on `intentId`; checks the mandate as stored now against
   * what is already occupied and either inserts a HELD reservation or records why not.
   */
  reserve(input: NewTraderReservation): Promise<TraderReserveResult>;
  /** HELD reservations and ACCOUNTED ones whose fill is not yet final. */
  trades(input: {
    agentId: string;
    deploymentId: string;
  }): Promise<TraderTrade[]>;
  trade(intentId: string): Promise<TraderTrade | null>;
  release(reservationId: string, reason: string): Promise<void>;
  /** HELD to ACCOUNTED when `accounted`, ACCOUNTED back to HELD when not (the fill's block was reorged away). */
  setAccounted(reservationId: string, accounted: boolean): Promise<void>;
  /** Creates the economic intent and its first sign request; the same dedupe key returns the same intent. */
  prepare(input: PrepareTraderIntent): Promise<{ intentId: string }>;
  intent(intentId: string): Promise<TraderIntentFact | null>;
  /** FINAL markets where the wallet still holds shares, with its redeem intent if one exists. */
  redeemable(input: {
    deploymentId: string;
    wallet: Hex;
  }): Promise<{ marketId: string; intent: TraderIntentFact | null }[]>;
  /** One audit row per (action, resource, reason). */
  audit(input: {
    action: string;
    resource: string;
    reason: string;
  }): Promise<void>;
}

/** The public RFQ API as the trader calls it, with the trader's own key. */
export type TraderSignedQuote = ReturnType<typeof SignedQuoteResponse.parse>;
export type TraderQuoteResult =
  | { ok: true; quote: TraderSignedQuote }
  | { ok: false; status: number; code: string; retryable: boolean };
export interface TraderQuoteApi {
  requestQuote(
    input: {
      deploymentId: string;
      marketId: string;
      side: "YES" | "NO";
      quantity: string;
      maxCostMicros: string;
    },
    idempotencyKey: string,
  ): Promise<TraderQuoteResult>;
}

// Adapters may import only schemas and ports, so the mandate rule they apply under the lock is re-exported.
export { mandateAdmission, type MandateRefusal } from "@blink/domain";
