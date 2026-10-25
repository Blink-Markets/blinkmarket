// Forecaster credit and the credit-weighted consensus (spec §5.7). Read models only: nothing here
// touches funds or any on-chain rule.

/** A forecaster needs this many scored LIVE submissions before it carries any weight. */
export const MIN_SCORED_FOR_WEIGHT = 5;
/** The stats come from the latest this many scored LIVE submissions. */
export const CREDIT_WINDOW_SUBMISSIONS = 50;
/** A mean Brier at or above this (the score of always answering 50%) earns no weight. */
export const BRIER_BASELINE = 0.25;

/** An exact non-negative fraction: weights never pass through a rounded decimal. */
export interface Weight {
  num: bigint;
  den: bigint;
}
/** The latest scored LIVE answers of a forecaster: how many, and the exact decimal sum of their Briers. */
export interface CreditStats {
  n: number;
  brierSum: string | null;
}
const ZERO: Weight = { num: 0n, den: 1n };
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/** A decimal text ("0.1249", "3") as an integer over a power of ten. */
function decimal(text: string): Weight {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error("INVALID_DECIMAL");
  const fraction = m[2] ?? "";
  return { num: BigInt(m[1]! + fraction), den: 10n ** BigInt(fraction.length) };
}

/**
 * weight = n < 5 ? 0 : max(0, 1/4 - meanBrier), where meanBrier = brierSum / n. Exact: the result is
 * (n * den - 4 * sum) / (4 * n * den) over the decimal's denominator.
 */
export function forecasterWeight(stats: CreditStats): Weight {
  if (stats.n < MIN_SCORED_FOR_WEIGHT || stats.brierSum === null) return ZERO;
  const sum = decimal(stats.brierSum);
  const n = BigInt(stats.n);
  const num = n * sum.den - 4n * sum.num;
  if (num <= 0n) return ZERO;
  const den = 4n * n * sum.den;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}
/** Orders weights, highest first, by exact cross-multiplication. */
export const compareWeightsDesc = (a: Weight, b: Weight): number => {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left === right ? 0 : left > right ? -1 : 1;
};
/** For display only: never feed this back into the consensus. */
export const weightValue = (w: Weight): number => Number(w.num) / Number(w.den);
export const meanBrier = (stats: CreditStats): number | null => {
  if (stats.brierSum === null || stats.n === 0) return null;
  const sum = decimal(stats.brierSum);
  return Number(sum.num) / Number(sum.den) / stats.n;
};

/**
 * The weighted mean of the answers in basis points, rounded half up to an integer. When every
 * weight is 0 it is the plain mean; no answers give null. `weights` is keyed by forecaster address
 * (lowercase); a forecaster without an entry weighs 0. Exact in integers over a common denominator.
 */
export function consensus(
  submissions: readonly { forecaster: string; probabilityBps: number }[],
  weights: Readonly<Record<string, Weight>>,
): number | null {
  if (submissions.length === 0) return null;
  const used = submissions.map((s) => weights[s.forecaster.toLowerCase()] ?? ZERO);
  const common = used.reduce((d, w) => (d * w.den) / gcd(d, w.den), 1n);
  let scaled = used.map((w) => w.num * (common / w.den));
  if (scaled.every((w) => w === 0n)) scaled = scaled.map(() => 1n);
  const total = scaled.reduce((a, b) => a + b, 0n);
  const sum = submissions.reduce(
    (acc, s, i) => acc + scaled[i]! * BigInt(s.probabilityBps),
    0n,
  );
  // floor(sum / total + 1/2) in exact integers.
  return Number((2n * sum + total) / (2n * total));
}

/** The outcome was public when the window closed: a proposal exists at or before the deadline. */
export const windowContaminated = (
  proposal: { proposedAt: number } | null,
  deadlineSeconds: number,
): boolean => proposal !== null && proposal.proposedAt <= deadlineSeconds;
