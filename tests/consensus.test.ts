import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consensus,
  forecasterWeight,
  windowContaminated,
} from "../packages/domain/src/consensus.ts";

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);

test("weights from Brier", () => {
  // Five scored submissions with mean 0.1 weigh 0.25 - 0.1.
  assert.equal(forecasterWeight({ n: 5, meanBrier: 0.1 }), 0.15);
  assert.equal(forecasterWeight({ n: 50, meanBrier: 0.1 }), 0.15);
  // Fewer than five carry no weight, however good.
  assert.equal(forecasterWeight({ n: 4, meanBrier: 0.1 }), 0);
  assert.equal(forecasterWeight({ n: 0, meanBrier: null }), 0);
  // A mean at or above the 50% baseline carries none either.
  assert.equal(forecasterWeight({ n: 9, meanBrier: 0.25 }), 0);
  assert.equal(forecasterWeight({ n: 9, meanBrier: 0.7 }), 0);
  assert.equal(forecasterWeight({ n: 5, meanBrier: 0 }), 0.25);
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
      { [A]: 0.15, [B]: 0.05 },
    ),
    7000,
  );
  // Addresses match whatever their case.
  assert.equal(
    consensus([{ forecaster: A.toUpperCase().replace("0X", "0x"), probabilityBps: 123 }], { [A]: 0.1 }),
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
      { [A]: 0, [B]: 0 },
    ),
    3001,
  );
  assert.equal(consensus([], { [A]: 1 }), null);
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
  assert.equal(two(5000, 5001, { [A]: 0.1, [B]: 0.1 }), 5001);
  // 0.3 + 0.1 of weight over 4000 and 9000 is 5250 exactly; 5249.9999 must not appear.
  assert.equal(two(4000, 9000, { [A]: 0.15, [B]: 0.05 }), 5250);
  // A third just under the half rounds down: (1 * 5000 + 2 * 5001) / 3 = 5000.67 -> 5001; (2 * 5000 + 5001) / 3 = 5000.33 -> 5000
  assert.equal(two(5000, 5001, { [A]: 2e-6, [B]: 1e-6 }), 5000);
  assert.equal(two(5000, 5001, { [A]: 1e-6, [B]: 2e-6 }), 5001);
});

test("a window is contaminated once a proposal exists at or before its deadline", () => {
  assert.equal(windowContaminated(null, 1000), false);
  assert.equal(windowContaminated({ proposedAt: 1000 }, 1000), true);
  assert.equal(windowContaminated({ proposedAt: 999 }, 1000), true);
  assert.equal(windowContaminated({ proposedAt: 1001 }, 1000), false);
});
