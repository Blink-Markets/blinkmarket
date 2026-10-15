import { snapshotPriceBase } from "./forecast-windows.ts";

// Integer pricing only (spec 7.2, 8.4): millionths in, basis points and micro-bUSD out.
const UNIT_MICROS = 1_000_000n;
/** A quote that would live less than this many seconds is not worth signing. */
export const MIN_QUOTE_SECONDS = 5n;

/** clamp(snapshotPriceBase + spread, 1, 9999): the price of the chosen side in basis points. */
export function askPriceBps(input: {
  probabilitySumMillionths: number;
  side: "YES" | "NO";
  spreadBps: number;
}): number {
  if (
    !Number.isInteger(input.spreadBps) ||
    input.spreadBps < 0 ||
    input.spreadBps > 10_000
  )
    throw new Error("INVALID_SPREAD");
  const base = snapshotPriceBase({
    probabilitySumMillionths: input.probabilitySumMillionths,
    side: input.side,
  });
  return Math.min(9999, Math.max(1, base + input.spreadBps));
}

/** taker = q * price * 100, maker = q * 1e6 - taker (spec 7.2). */
export function quoteCosts(
  quantity: bigint,
  priceBps: number,
): { takerCostMicros: bigint; makerCostMicros: bigint } {
  if (
    quantity < 1n ||
    !Number.isInteger(priceBps) ||
    priceBps < 1 ||
    priceBps > 9999
  )
    throw new Error("INVALID_QUOTE_COST_INPUT");
  const takerCostMicros = quantity * BigInt(priceBps) * 100n;
  return {
    takerCostMicros,
    makerCostMicros: quantity * UNIT_MICROS - takerCostMicros,
  };
}

/**
 * validAfter is the canonical head block's timestamp, never a host clock; the quote lives
 * `ttlSeconds` and never past the market close.
 */
export function quoteValidity(input: {
  headTimestamp: bigint;
  closeAt: bigint;
  ttlSeconds: bigint;
}): { validAfter: bigint; expiresAt: bigint; usable: boolean } {
  const validAfter = input.headTimestamp;
  const expiresAt =
    validAfter + input.ttlSeconds < input.closeAt
      ? validAfter + input.ttlSeconds
      : input.closeAt;
  return {
    validAfter,
    expiresAt,
    usable: expiresAt - validAfter >= MIN_QUOTE_SECONDS,
  };
}
