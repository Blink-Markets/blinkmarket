// Forecaster credit and the credit-weighted consensus (spec §5.7). Read models only: nothing here
// touches funds or any on-chain rule.

/** A forecaster needs this many scored LIVE submissions before it carries any weight. */
export const MIN_SCORED_FOR_WEIGHT = 5;
/** The stats come from the latest this many scored LIVE submissions. */
export const CREDIT_WINDOW_SUBMISSIONS = 50;
/** A mean Brier at or above this (the score of always answering 50%) earns no weight. */
export const BRIER_BASELINE = 0.25;
const MICROS = 1_000_000;

/** weight = n < 5 ? 0 : max(0, 0.25 - meanBrier), to six decimals so float noise cannot tip a tie. */
export function forecasterWeight(stats: {
  n: number;
  meanBrier: number | null;
}): number {
  if (stats.n < MIN_SCORED_FOR_WEIGHT || stats.meanBrier === null) return 0;
  return Math.max(0, Math.round((BRIER_BASELINE - stats.meanBrier) * MICROS) / MICROS);
}

/**
 * The weighted mean of the answers in basis points, rounded half up to an integer. When every
 * weight is 0 it is the plain mean; no answers give null. `weights` is keyed by forecaster address
 * (lowercase); a forecaster without an entry weighs 0.
 */
export function consensus(
  submissions: readonly { forecaster: string; probabilityBps: number }[],
  weights: Readonly<Record<string, number>>,
): number | null {
  if (submissions.length === 0) return null;
  const weigh = (forecaster: string) =>
    BigInt(Math.round((weights[forecaster.toLowerCase()] ?? 0) * MICROS));
  let total = submissions.reduce((sum, s) => sum + weigh(s.forecaster), 0n);
  const weight = total > 0n ? weigh : () => 1n;
  if (total === 0n) total = BigInt(submissions.length);
  const sum = submissions.reduce(
    (acc, s) => acc + weight(s.forecaster) * BigInt(s.probabilityBps),
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
