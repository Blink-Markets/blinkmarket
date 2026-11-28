import { DivisionByZero } from "./arith.ts";

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * An exact rational number on BigInt: the value of a formula with no rounding (the "exact value" of the plan, section 0).
 * Always normalized: the denominator is positive, numerator and denominator share no factor, and zero is 0/1.
 * Values are immutable.
 */
export class Rational {
  static readonly ZERO = new Rational(0n, 1n);
  static readonly ONE = new Rational(1n, 1n);

  readonly numerator: bigint;
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    this.numerator = numerator;
    this.denominator = denominator;
    Object.freeze(this);
  }

  /** The normalized value numerator / denominator. A zero denominator throws `DivisionByZero`. */
  static of(numerator: bigint, denominator: bigint = 1n): Rational {
    if (denominator === 0n) throw new DivisionByZero("Rational with a zero denominator");
    if (numerator === 0n) return Rational.ZERO;
    const divisor = gcd(numerator, denominator);
    const sign = denominator < 0n ? -1n : 1n;
    return new Rational((sign * numerator) / divisor, (sign * denominator) / divisor);
  }

  add(other: Rational): Rational {
    return Rational.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  sub(other: Rational): Rational {
    return this.add(other.neg());
  }

  mul(other: Rational): Rational {
    return Rational.of(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  /** Division by a zero value throws `DivisionByZero`. */
  div(other: Rational): Rational {
    return Rational.of(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  neg(): Rational {
    return Rational.of(-this.numerator, this.denominator);
  }

  /** -1, 0 or 1 as this value is less than, equal to or greater than `other`. */
  compare(other: Rational): -1 | 0 | 1 {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  equals(other: Rational): boolean {
    return this.compare(other) === 0;
  }
  lt(other: Rational): boolean {
    return this.compare(other) < 0;
  }
  lte(other: Rational): boolean {
    return this.compare(other) <= 0;
  }
  gt(other: Rational): boolean {
    return this.compare(other) > 0;
  }
  gte(other: Rational): boolean {
    return this.compare(other) >= 0;
  }

  /** The greatest integer not above this value (toward minus infinity). */
  floor(): bigint {
    const quotient = this.numerator / this.denominator;
    return this.numerator % this.denominator < 0n ? quotient - 1n : quotient;
  }

  /** The least integer not below this value (toward plus infinity). */
  ceil(): bigint {
    const quotient = this.numerator / this.denominator;
    return this.numerator % this.denominator > 0n ? quotient + 1n : quotient;
  }

  toString(): string {
    return this.denominator === 1n ? `${this.numerator}` : `${this.numerator}/${this.denominator}`;
  }
}
