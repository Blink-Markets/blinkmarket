import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DivisionByZero,
  MAX_ALLOWANCE,
  Overflow,
  Rational,
  UINT256_MAX,
  WAD,
  add256,
  mul256,
  mulDiv,
  sub256,
} from "../packages/mechanism-model/src/index.ts";

const TWO_96 = 2n ** 96n;
const TWO_255 = 2n ** 255n;
const TWO_256 = 2n ** 256n;

// Reference: the same quotient from plain BigInt division, which has no 256-bit limit.
function reference(a: bigint, b: bigint, c: bigint, direction: "Floor" | "Ceil"): bigint {
  const floor = (a * b) / c;
  return direction === "Ceil" && (a * b) % c !== 0n ? floor + 1n : floor;
}

test("constants: W, maxAllowance and the uint256 maximum", () => {
  assert.equal(WAD, 10n ** 18n);
  assert.equal(MAX_ALLOWANCE, TWO_96);
  assert.equal(UINT256_MAX, TWO_256 - 1n);
});

test("mulDiv: zero operands give zero in both directions", () => {
  for (const direction of ["Floor", "Ceil"] as const) {
    assert.equal(mulDiv(0n, 5n, 7n, direction), 0n);
    assert.equal(mulDiv(5n, 0n, 7n, direction), 0n);
    assert.equal(mulDiv(0n, 0n, 1n, direction), 0n);
    assert.equal(mulDiv(0n, TWO_255, TWO_255, direction), 0n);
  }
});

test("mulDiv: one as the divisor or an operand", () => {
  for (const direction of ["Floor", "Ceil"] as const) {
    assert.equal(mulDiv(1n, 1n, 1n, direction), 1n);
    assert.equal(mulDiv(TWO_96, 1n, 1n, direction), TWO_96);
    assert.equal(mulDiv(1n, TWO_255, 1n, direction), TWO_255);
  }
});

test("mulDiv: Floor and Ceil differ by exactly one base unit when the division is inexact", () => {
  assert.equal(mulDiv(1n, 1n, 2n, "Floor"), 0n);
  assert.equal(mulDiv(1n, 1n, 2n, "Ceil"), 1n);
  assert.equal(mulDiv(7n, 5n, 3n, "Floor"), 11n);
  assert.equal(mulDiv(7n, 5n, 3n, "Ceil"), 12n);
  // 750 / 2000 = 0.375 of W: the spec's baseline example, floored to a base unit.
  assert.equal(mulDiv(750n, WAD, 2000n, "Floor"), 375n * 10n ** 15n);
  // The baseline 30.0001% case: a non-terminating quotient rounds apart.
  assert.equal(mulDiv(1n, WAD, 3n, "Floor"), 333333333333333333n);
  assert.equal(mulDiv(1n, WAD, 3n, "Ceil"), 333333333333333334n);
});

test("mulDiv: an exact division is the same in both directions", () => {
  assert.equal(mulDiv(6n, 5n, 3n, "Floor"), 10n);
  assert.equal(mulDiv(6n, 5n, 3n, "Ceil"), 10n);
  assert.equal(mulDiv(TWO_96, WAD, WAD, "Floor"), TWO_96);
  assert.equal(mulDiv(TWO_96, WAD, WAD, "Ceil"), TWO_96);
});

test("mulDiv: edge values 2^96 and 2^255", () => {
  assert.equal(mulDiv(TWO_96, TWO_96, TWO_96, "Floor"), TWO_96);
  assert.equal(mulDiv(TWO_96, TWO_96, 3n, "Floor"), reference(TWO_96, TWO_96, 3n, "Floor"));
  assert.equal(mulDiv(TWO_96, TWO_96, 3n, "Ceil"), reference(TWO_96, TWO_96, 3n, "Ceil"));
  // A request at maxAllowance times a WAD-squared factor stays far below 2^256 (spec 4.0).
  const product = mulDiv(TWO_96 - 1n, 2n * WAD * WAD, WAD * WAD, "Ceil");
  assert.equal(product, 2n * (TWO_96 - 1n));
  assert.equal(mulDiv(TWO_255, 2n, 2n, "Floor"), TWO_255);
  assert.equal(mulDiv(TWO_255, 1n, 3n, "Floor"), TWO_255 / 3n);
  assert.equal(mulDiv(TWO_255, 1n, 3n, "Ceil"), TWO_255 / 3n + 1n);
});

test("mulDiv: the intermediate product may exceed 2^256 when the result fits (full precision)", () => {
  // 2^255 * 2^255 is 2^510, far above uint256, but the quotient fits.
  assert.equal(mulDiv(TWO_255, TWO_255, TWO_255, "Floor"), TWO_255);
  assert.equal(mulDiv(TWO_255, TWO_255, TWO_255, "Ceil"), TWO_255);
  assert.equal(mulDiv(TWO_255, TWO_255, TWO_255 + 1n, "Floor"), reference(TWO_255, TWO_255, TWO_255 + 1n, "Floor"));
  assert.equal(mulDiv(TWO_255, TWO_255, TWO_255 + 1n, "Ceil"), reference(TWO_255, TWO_255, TWO_255 + 1n, "Ceil"));
});

test("mulDiv: a result of 2^256 or more throws Overflow", () => {
  for (const direction of ["Floor", "Ceil"] as const) {
    assert.throws(() => mulDiv(TWO_255, 2n, 1n, direction), Overflow);
    assert.throws(() => mulDiv(UINT256_MAX, UINT256_MAX, 1n, direction), Overflow);
    assert.throws(() => mulDiv(UINT256_MAX, 3n, 2n, direction), Overflow);
  }
  // The largest result is still allowed.
  assert.equal(mulDiv(UINT256_MAX, 1n, 1n, "Floor"), UINT256_MAX);
  assert.equal(mulDiv(UINT256_MAX, UINT256_MAX, UINT256_MAX, "Ceil"), UINT256_MAX);
});

test("mulDiv: rounding up past the uint256 maximum throws Overflow, rounding down does not", () => {
  // MAX = 2^256 - 1 leaves remainder 1 modulo 7, so with s = (MAX - 1) / 7 and a = MAX - s:
  // a * 7 = 7 * MAX - (MAX - 1) = 6 * MAX + 1, and the quotient by 6 is MAX with remainder 1.
  const s = (UINT256_MAX - 1n) / 7n;
  const a = UINT256_MAX - s;
  assert.equal(a * 7n, 6n * UINT256_MAX + 1n);
  assert.equal(mulDiv(a, 7n, 6n, "Floor"), UINT256_MAX);
  assert.throws(() => mulDiv(a, 7n, 6n, "Ceil"), Overflow);
});

test("mulDiv: an operand or the divisor outside uint256 throws Overflow; a zero divisor throws DivisionByZero", () => {
  assert.throws(() => mulDiv(TWO_256, 1n, 1n, "Floor"), Overflow);
  assert.throws(() => mulDiv(1n, TWO_256, 1n, "Floor"), Overflow);
  assert.throws(() => mulDiv(1n, 1n, TWO_256, "Ceil"), Overflow);
  assert.throws(() => mulDiv(-1n, 1n, 1n, "Floor"), Overflow);
  assert.throws(() => mulDiv(1n, 1n, 0n, "Floor"), DivisionByZero);
  assert.throws(() => mulDiv(0n, 0n, 0n, "Ceil"), DivisionByZero);
});

test("mulDiv: the direction is mandatory and must be Floor or Ceil", () => {
  assert.throws(() => (mulDiv as (a: bigint, b: bigint, c: bigint, d?: string) => bigint)(1n, 1n, 2n));
  assert.throws(() => mulDiv(1n, 1n, 2n, "Round" as "Floor"));
});

test("mulDiv: agrees with plain BigInt division on a grid of edge values", () => {
  const values = [0n, 1n, 2n, 3n, 7n, WAD, WAD - 1n, TWO_96 - 1n, TWO_96, TWO_96 + 1n, TWO_255 - 1n, TWO_255];
  const divisors = values.filter((v) => v !== 0n);
  for (const a of values)
    for (const b of values)
      for (const c of divisors)
        for (const direction of ["Floor", "Ceil"] as const) {
          const expected = reference(a, b, c, direction);
          if (expected > UINT256_MAX) assert.throws(() => mulDiv(a, b, c, direction), Overflow);
          else assert.equal(mulDiv(a, b, c, direction), expected, `${a} ${b} ${c} ${direction}`);
        }
});

test("checked uint256 helpers throw Overflow like Solidity 0.8", () => {
  assert.equal(add256(1n, 2n), 3n);
  assert.equal(sub256(5n, 5n), 0n);
  assert.equal(mul256(TWO_96, TWO_96), 2n ** 192n);
  assert.throws(() => add256(UINT256_MAX, 1n), Overflow);
  assert.throws(() => sub256(0n, 1n), Overflow);
  assert.throws(() => mul256(TWO_255, 2n), Overflow);
  assert.throws(() => add256(-1n, 1n), Overflow);
});

test("Rational: construction normalizes sign, common factors and zero", () => {
  const half = Rational.of(2n, 4n);
  assert.equal(half.numerator, 1n);
  assert.equal(half.denominator, 2n);
  const negative = Rational.of(3n, -6n);
  assert.equal(negative.numerator, -1n);
  assert.equal(negative.denominator, 2n);
  const zero = Rational.of(0n, 17n);
  assert.equal(zero.numerator, 0n);
  assert.equal(zero.denominator, 1n);
  assert.ok(Rational.of(-0n, -5n).equals(Rational.ZERO));
  assert.equal(Rational.of(10n).denominator, 1n);
  assert.throws(() => Rational.of(1n, 0n), DivisionByZero);
});

test("Rational: addition and subtraction are exact", () => {
  const sum = Rational.of(1n, 3n).add(Rational.of(1n, 6n));
  assert.equal(sum.numerator, 1n);
  assert.equal(sum.denominator, 2n);
  assert.ok(Rational.of(1n, 3n).add(Rational.of(2n, 3n)).equals(Rational.ONE));
  assert.ok(Rational.of(1n, 3n).add(Rational.of(-1n, 3n)).equals(Rational.ZERO));
  assert.ok(Rational.of(1n, 2n).sub(Rational.of(3n, 4n)).equals(Rational.of(-1n, 4n)));
  // Exactness at the edges: 2^255 + 1/2^96 does not lose the fraction.
  const big = Rational.of(TWO_255).add(Rational.of(1n, TWO_96));
  assert.equal(big.numerator, TWO_255 * TWO_96 + 1n);
  assert.equal(big.denominator, TWO_96);
});

test("Rational: multiplication and division are exact and normalized", () => {
  const product = Rational.of(2n, 3n).mul(Rational.of(9n, 4n));
  assert.equal(product.numerator, 3n);
  assert.equal(product.denominator, 2n);
  assert.ok(Rational.of(5n, 7n).mul(Rational.ZERO).equals(Rational.ZERO));
  assert.ok(Rational.of(5n, 7n).mul(Rational.ONE).equals(Rational.of(5n, 7n)));
  assert.ok(Rational.of(-2n, 3n).mul(Rational.of(-3n, 2n)).equals(Rational.ONE));
  assert.ok(Rational.of(1n, 2n).div(Rational.of(1n, 4n)).equals(Rational.of(2n)));
  assert.throws(() => Rational.ONE.div(Rational.ZERO), DivisionByZero);
  // Worked example: P / R = 750 / 2000 is exactly 3/8 (37.5%).
  const baseline = Rational.of(750n).div(Rational.of(2000n));
  assert.equal(baseline.numerator, 3n);
  assert.equal(baseline.denominator, 8n);
});

test("Rational: comparison is a total order and works on negatives and the edge values", () => {
  const third = Rational.of(1n, 3n);
  const half = Rational.of(1n, 2n);
  assert.equal(third.compare(half), -1);
  assert.equal(half.compare(third), 1);
  assert.equal(half.compare(Rational.of(2n, 4n)), 0);
  assert.ok(third.lt(half) && half.gt(third) && third.lte(third) && third.gte(third));
  assert.equal(Rational.of(-1n, 2n).compare(Rational.of(-1n, 3n)), -1);
  assert.equal(Rational.of(-1n, 2n).compare(Rational.ZERO), -1);
  assert.equal(Rational.of(TWO_255).compare(Rational.of(TWO_255 - 1n)), 1);
  assert.equal(Rational.of(1n, TWO_96).compare(Rational.of(1n, TWO_96 + 1n)), 1);
  assert.equal(Rational.of(0n).compare(Rational.of(0n, 5n)), 0);
});

test("Rational: floor and ceil round toward minus and plus infinity", () => {
  assert.equal(Rational.of(7n, 2n).floor(), 3n);
  assert.equal(Rational.of(7n, 2n).ceil(), 4n);
  assert.equal(Rational.of(-7n, 2n).floor(), -4n);
  assert.equal(Rational.of(-7n, 2n).ceil(), -3n);
  assert.equal(Rational.of(6n, 2n).floor(), 3n);
  assert.equal(Rational.of(6n, 2n).ceil(), 3n);
  assert.equal(Rational.ZERO.floor(), 0n);
});

test("Rational: floor and ceil of an exact product match mulDiv Floor and Ceil", () => {
  const values = [0n, 1n, 2n, 7n, WAD, TWO_96 - 1n, TWO_96, TWO_255];
  for (const a of values)
    for (const b of values)
      for (const c of [1n, 2n, 3n, WAD, TWO_96]) {
        const exact = Rational.of(a).mul(Rational.of(b)).div(Rational.of(c));
        if (reference(a, b, c, "Floor") <= UINT256_MAX) assert.equal(exact.floor(), mulDiv(a, b, c, "Floor"));
        if (reference(a, b, c, "Ceil") <= UINT256_MAX) assert.equal(exact.ceil(), mulDiv(a, b, c, "Ceil"));
      }
});

test("Rational: values are immutable and print as n/d", () => {
  const value = Rational.of(3n, 8n);
  assert.equal(value.toString(), "3/8");
  assert.equal(Rational.of(4n).toString(), "4");
  assert.throws(() => {
    (value as unknown as { numerator: bigint }).numerator = 9n;
  });
  assert.equal(value.numerator, 3n);
});
