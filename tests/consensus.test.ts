import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consensus,
  forecasterWeight,
  meanBrier,
  weightValue,
  windowContaminated,
  type Weight,
} from "../packages/domain/src/consensus.ts";

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);
// An exact weight from a decimal text such as "0.15".
const w = (text: string): Weight => {
  const [whole, fraction = ""] = text.split(".");
  return { num: BigInt(whole! + fraction), den: 10n ** BigInt(fraction.length) };
};
// Stats whose n answers had this mean Brier (the store hands over the exact sum).
const stats = (n: number, sum: string | null) => ({ n, brierSum: sum });
const value = (n: number, sum: string | null) => weightValue(forecasterWeight(stats(n, sum)));

test("weights from Brier", () => {
  // Five scored submissions with mean 0.1 (sum 0.5) weigh 0.25 - 0.1.
  assert.equal(value(5, "0.5"), 0.15);
  assert.equal(value(50, "5"), 0.15);
  assert.equal(meanBrier(stats(5, "0.5")), 0.1);
  // Fewer than five carry no weight, however good.
  assert.equal(value(4, "0.4"), 0);
  assert.equal(value(0, null), 0);
  // A mean at or above the 50% baseline carries none either.
  assert.equal(value(9, "2.25"), 0);
  assert.equal(value(9, "6.3"), 0);
  assert.equal(value(5, "0"), 0.25);
  // Exact: a mean of 1/3 over three-fifths of the sample is not rounded to six decimals.
  assert.deepEqual(forecasterWeight(stats(6, "1")), { num: 6n - 4n, den: 24n });
});

test("a tiny weight still outweighs a zero weight", () => {
  // n = 5, mean 0.2499996: the weight is 4e-7, which a six-decimal rounding would turn into 0 and
  // fall back to the plain mean (5000).
  const tiny = forecasterWeight(stats(5, "1.249998"));
  assert.equal(tiny.num * 10_000_000n, tiny.den * 4n);
  assert.equal(
    consensus(
      [
        { forecaster: A, probabilityBps: 1000 },
        { forecaster: B, probabilityBps: 9000 },
      ],
      { [A]: tiny, [B]: forecasterWeight(stats(4, "0")) },
    ),
    1000,
  );
});

test("weighted mean, with a forecaster that has no weight entry weighing nothing", () => {
  // (0.15 * 8000 + 0.05 * 4000) / 0.2 = 7000
  assert.equal(
    consensus(
      [
        { forecaster: A, probabilityBps: 8000 },
        { forecaster: B, probabilityBps: 4000 },
        { forecaster: C, probabilityBps: 1 },
      ],
      { [A]: w("0.15"), [B]: w("0.05") },
    ),
    7000,
  );
  // Addresses match whatever their case.
  assert.equal(
    consensus([{ forecaster: A.toUpperCase().replace("0X", "0x"), probabilityBps: 123 }], { [A]: w("0.1") }),
    123,
  );
});

test("falls back to mean when weights zero", () => {
  assert.equal(
    consensus(
      [
        { forecaster: A, probabilityBps: 2000 },
        { forecaster: B, probabilityBps: 4000 },
      ],
      {},
    ),
    3000,
  );
  assert.equal(
    consensus(
      [
        { forecaster: A, probabilityBps: 2000 },
        { forecaster: B, probabilityBps: 4001 },
      ],
      { [A]: w("0"), [B]: w("0") },
    ),
    3001,
  );
  assert.equal(consensus([], { [A]: w("1") }), null);
});

test("rounding half up", () => {
  const two = (a: number, b: number, weights = {}) =>
    consensus(
      [
        { forecaster: A, probabilityBps: a },
        { forecaster: B, probabilityBps: b },
      ],
      weights,
    );
  assert.equal(two(5000, 5001), 5001); // 5000.5 rounds up
  assert.equal(two(5000, 5002), 5001);
  assert.equal(two(1, 2), 2);
  assert.equal(two(9998, 9999), 9999);
  // Exact in integers: equal weights of 0.1 never drift below the half.
  assert.equal(two(5000, 5001, { [A]: w("0.1"), [B]: w("0.1") }), 5001);
  // 0.3 + 0.1 of weight over 4000 and 9000 is 5250 exactly; 5249.9999 must not appear.
  assert.equal(two(4000, 9000, { [A]: w("0.15"), [B]: w("0.05") }), 5250);
  // A third just under the half rounds down: (1 * 5000 + 2 * 5001) / 3 = 5000.67 -> 5001; (2 * 5000 + 5001) / 3 = 5000.33 -> 5000
  assert.equal(two(5000, 5001, { [A]: w("0.000002"), [B]: w("0.000001") }), 5000);
  assert.equal(two(5000, 5001, { [A]: w("0.000001"), [B]: w("0.000002") }), 5001);
});

test("a window is contaminated once a proposal exists at or before its deadline", () => {
  assert.equal(windowContaminated(null, 1000), false);
  assert.equal(windowContaminated({ proposedAt: 1000 }, 1000), true);
  assert.equal(windowContaminated({ proposedAt: 999 }, 1000), true);
  assert.equal(windowContaminated({ proposedAt: 1001 }, 1000), false);
});
