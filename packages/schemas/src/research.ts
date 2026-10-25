import { z } from "zod";
import { Address, CHAIN_ID, Hash } from "./core.ts";
import { Anchor, IndexHealth } from "./protocol.ts";

// Signed forecasts (spec §5.10). An agent signs the Forecast struct below with its own wallet; the
// platform admits, seals and scores the answers and computes window Merkle roots, but never signs
// or anchors anything.

/** horizon in the signed struct: DAILY = 0, PRE_CLOSE = 1. */
export const FORECAST_HORIZONS = { DAILY: 0, PRE_CLOSE: 1 } as const;
export const ForecastHorizon = z.union([z.literal(0), z.literal(1)]);
export const HorizonName = z.enum(["DAILY", "PRE_CLOSE"]);
export const FORECAST_DOMAIN_NAME = "Blink Forecast";
export const FORECAST_DOMAIN_VERSION = "1";
/** The contentHash of a forecast that carries no content. */
export const NO_CONTENT_HASH = "0x" + "00".repeat(32);

/** Plain data, so any EIP-712 library can use it. */
export const forecastTypes = {
  Forecast: [
    { name: "forecaster", type: "address" },
    { name: "markets", type: "address" },
    { name: "marketId", type: "uint256" },
    { name: "horizon", type: "uint8" },
    { name: "scheduledAt", type: "uint64" },
    { name: "probabilityBps", type: "uint16" },
    { name: "contentHash", type: "bytes32" },
  ],
} as const;

export type ForecastMessage = {
  forecaster: string;
  /** The generation's BlinkMarkets, so a signature cannot be replayed on another deployment. */
  markets: string;
  marketId: string | bigint;
  horizon: 0 | 1;
  /** The window's scheduledAt, in unix seconds. */
  scheduledAt: number | bigint;
  probabilityBps: number;
  contentHash: string;
};

/**
 * The EIP-712 typed data of a forecast: domain "Blink Forecast" 1 on chain 84532, verified by the
 * deployment's BlinkAnchor (`shared.anchor` of the manifest).
 */
export function forecastTypedData(input: {
  anchor: string;
  message: ForecastMessage;
}) {
  const m = input.message;
  return {
    domain: {
      name: FORECAST_DOMAIN_NAME,
      version: FORECAST_DOMAIN_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: input.anchor as `0x${string}`,
    },
    types: forecastTypes,
    primaryType: "Forecast" as const,
    message: {
      forecaster: m.forecaster as `0x${string}`,
      markets: m.markets as `0x${string}`,
      marketId: BigInt(m.marketId),
      horizon: m.horizon,
      scheduledAt: BigInt(m.scheduledAt),
      probabilityBps: m.probabilityBps,
      contentHash: m.contentHash as `0x${string}`,
    },
  };
}

/** Room for a signature of up to 8192 bytes (a contract wallet may sign long). */
export const SignatureHex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2}){1,8192}$/);
const UnixSeconds = z.number().int().min(0);
const Id = z.uuid();

export const ForecastSubmission = z.strictObject({
  horizon: ForecastHorizon,
  scheduledAt: UnixSeconds,
  probabilityBps: z.number().int().min(1).max(9999),
  contentHash: Hash,
  signature: SignatureHex,
});
export type ForecastSubmission = z.infer<typeof ForecastSubmission>;
export const ForecastReceipt = z.strictObject({ digest: Hash, leaf: Hash });

export const ForecastWindowView = z.strictObject({
  windowId: Id,
  horizon: ForecastHorizon,
  horizonType: HorizonName,
  scheduledAt: UnixSeconds,
  openAt: UnixSeconds,
  deadline: UnixSeconds,
  status: z.enum(["UPCOMING", "OPEN", "CLOSED"]),
  /** The window's Merkle root once the worker stored it; null before, and for a window with no answers. */
  root: Hash.nullable(),
  rootAt: UnixSeconds.nullable(),
});
export const ForecastWindowRecord = ForecastWindowView.extend({
  marketId: z.string(),
  /** Empty until the deadline: nobody reads the answers of an open window. */
  leaves: z.array(Hash),
  anchor: Anchor.nullable(),
  index: IndexHealth,
});
export const ForecastProof = z.strictObject({
  root: Hash,
  leaf: Hash,
  proof: z.array(Hash),
});

export const ForecastView = z.strictObject({
  submissionId: Id,
  windowId: Id,
  forecaster: Address,
  probabilityBps: z.number().int().min(1).max(9999),
  contentHash: Hash,
  digest: Hash,
  leaf: Hash,
  signature: SignatureHex,
  /** The block the signature check ran at; a contract wallet's answer can change later. */
  verifiedBlock: z.number().int().min(0),
  receivedAt: UnixSeconds,
  withdrawnAt: UnixSeconds.nullable(),
});
export type ForecastView = z.infer<typeof ForecastView>;
export const ForecastWithdrawal = z.strictObject({
  submissionId: Id,
  withdrawnAt: UnixSeconds,
});

export const ConsensusItem = z.strictObject({
  windowId: Id,
  horizon: ForecastHorizon,
  horizonType: HorizonName,
  scheduledAt: UnixSeconds,
  deadline: UnixSeconds,
  /** The credit-weighted mean; null when the window has no answers. */
  probabilityBps: z.number().int().min(1).max(9999).nullable(),
  submissions: z.number().int().min(0),
  /** A proposal existed at or before the deadline: the outcome was already public. */
  contaminated: z.boolean(),
});

export const ForecasterView = z.strictObject({
  address: Address,
  /** Scored LIVE submissions among the latest 50 that count toward credit. */
  n: z.number().int().min(0),
  meanBrier: z.number().min(0).max(1).nullable(),
  /**
   * The weight as an exact fraction in lowest terms ("0" / "1" for none): 0 below 5 scored answers,
   * else 1/4 - meanBrier. Decimal integer strings, so nothing is rounded on the way out.
   */
  weightNumerator: z.string().regex(/^(0|[1-9][0-9]*)$/),
  weightDenominator: z.string().regex(/^[1-9][0-9]*$/),
});
