import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askPriceBps,
  quoteCosts,
  quoteValidity,
} from "../packages/domain/src/pricing.ts";

const ask = (probabilitySumMillionths: number, side: "YES" | "NO") =>
  askPriceBps({ probabilitySumMillionths, side, spreadBps: 200 });

test("spec 10.2 vector: sum 1,200,000, YES, 10 shares is 6200 bps for 6.2 bUSD", () => {
  const price = ask(1_200_000, "YES");
  assert.equal(price, 6200);
  assert.deepEqual(quoteCosts(10n, price), {
    takerCostMicros: 6_200_000n,
    makerCostMicros: 3_800_000n,
  });
  assert.equal(ask(1_200_000, "NO"), 4200);
});

test("an odd ensemble sum rounds the ceiling up before the spread", () => {
  assert.equal(ask(1_200_001, "YES"), 6201);
  // The NO side uses the complement over the same denominator: ceil(799,999 / 200) = 4000.
  assert.equal(ask(1_200_001, "NO"), 4200);
});

test("certain forecasts clamp into the contract's 1..9999 price range", () => {
  assert.equal(ask(2_000_000, "YES"), 9999);
  assert.equal(ask(2_000_000, "NO"), 200);
  assert.equal(ask(0, "YES"), 200);
  assert.equal(ask(0, "NO"), 9999);
  // A zero spread at a certain NO still cannot go below 1 bps.
  assert.equal(
    askPriceBps({
      probabilitySumMillionths: 2_000_000,
      side: "NO",
      spreadBps: 0,
    }),
    1,
  );
});

test("a spread or a sum outside the supported domain is refused, not clamped", () => {
  for (const spreadBps of [-1, 1.5, Number.NaN, 10_001])
    assert.throws(
      () =>
        askPriceBps({
          probabilitySumMillionths: 1_000_000,
          side: "YES",
          spreadBps,
        }),
      /INVALID_SPREAD/,
    );
  assert.throws(() => ask(2_000_001, "YES"), /INVALID_PROBABILITY_SUM/);
});

test("costs are exact integers and always add up to the notional", () => {
  assert.deepEqual(quoteCosts(100n, 9999), {
    takerCostMicros: 99_990_000n,
    makerCostMicros: 10_000n,
  });
  assert.deepEqual(quoteCosts(1n, 1), {
    takerCostMicros: 100n,
    makerCostMicros: 999_900n,
  });
  for (const quantity of [1n, 7n, 100n])
    for (const price of [1, 2500, 6200, 9999]) {
      const { takerCostMicros, makerCostMicros } = quoteCosts(quantity, price);
      assert.equal(takerCostMicros + makerCostMicros, quantity * 1_000_000n);
    }
  assert.throws(() => quoteCosts(0n, 5000), /INVALID_QUOTE_COST_INPUT/);
  assert.throws(() => quoteCosts(1n, 0), /INVALID_QUOTE_COST_INPUT/);
  assert.throws(() => quoteCosts(1n, 10_000), /INVALID_QUOTE_COST_INPUT/);
  assert.throws(() => quoteCosts(1n, 1.5), /INVALID_QUOTE_COST_INPUT/);
});

test("a quote lives 30 seconds from the head block and never past the close", () => {
  assert.deepEqual(
    quoteValidity({ headTimestamp: 1000n, closeAt: 5000n, ttlSeconds: 30n }),
    {
      validAfter: 1000n,
      expiresAt: 1030n,
      usable: true,
    },
  );
  // The close caps the expiry; exactly five seconds left is still usable, four is not.
  assert.deepEqual(
    quoteValidity({ headTimestamp: 1000n, closeAt: 1005n, ttlSeconds: 30n }),
    {
      validAfter: 1000n,
      expiresAt: 1005n,
      usable: true,
    },
  );
  assert.equal(
    quoteValidity({ headTimestamp: 1000n, closeAt: 1004n, ttlSeconds: 30n })
      .usable,
    false,
  );
  assert.equal(
    quoteValidity({ headTimestamp: 1000n, closeAt: 900n, ttlSeconds: 30n })
      .usable,
    false,
  );
});
