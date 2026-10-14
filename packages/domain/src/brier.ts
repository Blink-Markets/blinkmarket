/** Exact squared error; x is twice the probability in millionths. */
export function brierExact(x: bigint, outcome: 0 | 1): string {
  if (x < 0n || x > 2_000_000n || (outcome !== 0 && outcome !== 1))
    throw new Error("INVALID_BRIER_INPUT");
  const delta = x - 2_000_000n * BigInt(outcome);
  // 1 / 4e12 = 25 / 1e14, so no division or rounding is needed.
  const digits = (delta * delta * 25n).toString().padStart(15, "0");
  const fraction = digits.slice(-14).replace(/0+$/, "");
  return digits.slice(0, -14) + (fraction ? "." + fraction : "");
}
