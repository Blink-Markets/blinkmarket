// Integer arithmetic with the contracts' rules (spec 4.0): uint256 values on BigInt, explicit rounding
// direction on every multiplication-then-division, and an `Overflow` wherever the contracts would revert.

/** W: the fixed-point scale of every WAD value (1.0 = W). */
export const WAD = 10n ** 18n;

/** The largest uint256. */
export const UINT256_MAX = 2n ** 256n - 1n;

/** `maxAllowance`: the most one allowance or request may hold, in base units (spec 4.0, 6). */
export const MAX_ALLOWANCE = 2n ** 96n;

/** The rounding direction of a quotient: toward zero (`Floor`) or away from it (`Ceil`), for non-negative values. */
export type Rounding = "Floor" | "Ceil";

/** A value left uint256, or went below zero (Solidity's checked-arithmetic panic). */
export class Overflow extends Error {
  override readonly name = "Overflow";
}

/** A division by zero (Solidity's checked-arithmetic panic, or `Math.mulDiv` with a zero denominator). */
export class DivisionByZero extends Error {
  override readonly name = "DivisionByZero";
}

function asUint256(value: bigint): bigint {
  if (typeof value !== "bigint") throw new TypeError(`expected a bigint, got ${typeof value}`);
  if (value < 0n || value > UINT256_MAX) throw new Overflow(`${value} is not a uint256`);
  return value;
}

/**
 * `Math.mulDiv(a, b, c, rounding)` of OpenZeppelin: floor or ceil of a * b / c.
 * The product a * b is held at full precision (it may exceed 2^256); the operands, the denominator and the
 * result must be uint256, otherwise `Overflow`. A zero denominator throws `DivisionByZero`.
 * The direction is mandatory: spec 4.0 fixes it for every formula, so no call may rely on a default.
 */
export function mulDiv(a: bigint, b: bigint, c: bigint, rounding: Rounding): bigint {
  if (rounding !== "Floor" && rounding !== "Ceil") throw new TypeError(`rounding must be Floor or Ceil, got ${String(rounding)}`);
  asUint256(a);
  asUint256(b);
  asUint256(c);
  if (c === 0n) throw new DivisionByZero("mulDiv by zero");
  const product = a * b;
  const quotient = product / c;
  const result = rounding === "Ceil" && product % c !== 0n ? quotient + 1n : quotient;
  if (result > UINT256_MAX) throw new Overflow(`mulDiv result ${result} exceeds uint256`);
  return result;
}

/** Checked addition on uint256. */
export function add256(a: bigint, b: bigint): bigint {
  const sum = asUint256(a) + asUint256(b);
  if (sum > UINT256_MAX) throw new Overflow(`${a} + ${b} exceeds uint256`);
  return sum;
}

/** Checked subtraction on uint256: a result below zero is an `Overflow` (underflow). */
export function sub256(a: bigint, b: bigint): bigint {
  const difference = asUint256(a) - asUint256(b);
  if (difference < 0n) throw new Overflow(`${a} - ${b} is below zero`);
  return difference;
}

/** Checked multiplication on uint256. */
export function mul256(a: bigint, b: bigint): bigint {
  const product = asUint256(a) * asUint256(b);
  if (product > UINT256_MAX) throw new Overflow(`${a} * ${b} exceeds uint256`);
  return product;
}
