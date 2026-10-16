// Spec 9.3 and 12.3. Integer arithmetic only: probabilities are millionths, prices and the
// threshold are basis points (one basis point is 100 millionths), money is micro-bUSD.
const UNIT_MICROS = 1_000_000n;
const BPS_IN_MILLIONTHS = 100;
const MILLION = 1_000_000;

export interface TraderMandateLimits {
  dailyNotionalCapMicros: bigint;
  openNotionalCapMicros: bigint;
  maxFillShares: number;
}
export type MandateRefusal =
  "SHARES_EXCEED_MAX_FILL" | "DAILY_CAP_EXCEEDED" | "OPEN_CAP_EXCEEDED";

const invalid = () => new Error("INVALID_TRADER_INPUT");
const isInt = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

/**
 * Buy the side whose own probability beats its ask by more than the threshold. When both
 * qualify the larger edge wins and a tie goes to YES. The edge is compared in millionths, so
 * "exactly at the threshold" is no trade and the smallest step above it is a trade.
 */
export function traderDecision(input: {
  ownProbabilityMillionths: number;
  askYesBps: number;
  askNoBps: number;
  thresholdBps: number;
}): { side: "YES" | "NO" } | null {
  const { ownProbabilityMillionths: own, askYesBps, askNoBps } = input;
  if (
    !isInt(own, 0, MILLION) ||
    !isInt(askYesBps, 1, 9999) ||
    !isInt(askNoBps, 1, 9999) ||
    !isInt(input.thresholdBps, 0, 10_000)
  )
    throw invalid();
  const threshold = input.thresholdBps * BPS_IN_MILLIONTHS;
  const yesEdge = own - askYesBps * BPS_IN_MILLIONTHS;
  const noEdge = MILLION - own - askNoBps * BPS_IN_MILLIONTHS;
  const yes = yesEdge > threshold;
  const no = noEdge > threshold;
  if (yes && (!no || yesEdge >= noEdge)) return { side: "YES" };
  return no ? { side: "NO" } : null;
}

/** The maximum payout of the shares: the conservative risk a buy occupies, whatever its price. */
export function tradeNotionalMicros(shares: number): bigint {
  if (!isInt(shares, 1, 100)) throw invalid();
  return BigInt(shares) * UNIT_MICROS;
}

/**
 * Whether a buy of `shares` fits the mandate, given what is already occupied: `dailyMicros` is
 * today's HELD and ACCOUNTED notional, `openMicros` the HELD and ACCOUNTED notional of every
 * market that is not FINAL yet (bought and not matured, spec 9.3). Null admits it.
 */
export function mandateAdmission(input: {
  mandate: TraderMandateLimits;
  shares: number;
  dailyMicros: bigint;
  openMicros: bigint;
}): MandateRefusal | null {
  const notional = tradeNotionalMicros(input.shares);
  if (input.shares > input.mandate.maxFillShares)
    return "SHARES_EXCEED_MAX_FILL";
  if (input.dailyMicros + notional > input.mandate.dailyNotionalCapMicros)
    return "DAILY_CAP_EXCEEDED";
  if (input.openMicros + notional > input.mandate.openNotionalCapMicros)
    return "OPEN_CAP_EXCEEDED";
  return null;
}
