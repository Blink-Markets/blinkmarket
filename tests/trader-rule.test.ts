import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mandateAdmission,
  traderDecision,
  tradeNotionalMicros,
} from "../packages/domain/src/trader-rule.js";

const base = {
  ownProbabilityMillionths: 700_000,
  askYesBps: 6200,
  askNoBps: 4200,
  thresholdBps: 500,
};

test("buys YES only when the edge is strictly above the threshold", () => {
  // 0.67 - 0.62 is exactly 500 bps: not enough.
  assert.equal(
    traderDecision({ ...base, ownProbabilityMillionths: 670_000 }),
    null,
  );
  // One millionth above is already an edge above the threshold (integer comparison).
  assert.deepEqual(
    traderDecision({ ...base, ownProbabilityMillionths: 670_001 }),
    { side: "YES" },
  );
  // One basis point above, the case the plan names.
  assert.deepEqual(
    traderDecision({ ...base, ownProbabilityMillionths: 670_100 }),
    { side: "YES" },
  );
  assert.equal(
    traderDecision({ ...base, ownProbabilityMillionths: 669_999 }),
    null,
  );
});

test("buys NO only when the NO edge is strictly above the threshold", () => {
  // own NO probability 0.30 against an ask of 0.20 is 1000 bps; 0.25 is exactly 500 bps.
  const lowYes = { ...base, askYesBps: 9000, askNoBps: 2000 };
  assert.deepEqual(
    traderDecision({ ...lowYes, ownProbabilityMillionths: 700_000 }),
    { side: "NO" },
  );
  assert.equal(
    traderDecision({ ...lowYes, ownProbabilityMillionths: 750_000 }),
    null,
  );
  assert.deepEqual(
    traderDecision({ ...lowYes, ownProbabilityMillionths: 749_999 }),
    { side: "NO" },
  );
});

test("no edge on either side is no trade, and the threshold itself is a parameter", () => {
  assert.equal(
    traderDecision({ ...base, ownProbabilityMillionths: 620_000 }),
    null,
  );
  // A larger edge needs a larger probability when the threshold is raised.
  assert.equal(
    traderDecision({
      ...base,
      ownProbabilityMillionths: 700_000,
      thresholdBps: 800,
    }),
    null,
  );
  assert.deepEqual(
    traderDecision({
      ...base,
      ownProbabilityMillionths: 700_000,
      thresholdBps: 799,
    }),
    { side: "YES" },
  );
});

test("when both sides qualify the larger edge wins and a tie goes to YES", () => {
  const cheap = { askYesBps: 2000, askNoBps: 2000, thresholdBps: 0 };
  assert.deepEqual(
    traderDecision({ ...cheap, ownProbabilityMillionths: 500_000 }),
    { side: "YES" },
  );
  assert.deepEqual(
    traderDecision({ ...cheap, ownProbabilityMillionths: 600_000 }),
    { side: "YES" },
  );
  assert.deepEqual(
    traderDecision({ ...cheap, ownProbabilityMillionths: 400_000 }),
    { side: "NO" },
  );
});

test("refuses inputs that are not integers in range", () => {
  for (const patch of [
    { ownProbabilityMillionths: 0.5 },
    { ownProbabilityMillionths: -1 },
    { ownProbabilityMillionths: 1_000_001 },
    { askYesBps: 0 },
    { askYesBps: 10_000 },
    { askNoBps: 62.5 },
    { thresholdBps: -1 },
    { thresholdBps: 1.5 },
    { thresholdBps: Number.NaN },
  ])
    assert.throws(
      () => traderDecision({ ...base, ...patch }),
      /INVALID_TRADER_INPUT/,
      JSON.stringify(patch),
    );
});

const mandate = {
  dailyNotionalCapMicros: 100_000_000n,
  openNotionalCapMicros: 500_000_000n,
  maxFillShares: 20,
};

test("notional is the maximum payout of the shares, never the price paid", () => {
  assert.equal(tradeNotionalMicros(10), 10_000_000n);
  assert.equal(tradeNotionalMicros(1), 1_000_000n);
});

test("mandate admission checks the fill size, then the daily cap, then the open cap", () => {
  const ok = { mandate, shares: 10, dailyMicros: 0n, openMicros: 0n };
  assert.equal(mandateAdmission(ok), null);
  assert.equal(
    mandateAdmission({ ...ok, shares: 21 }),
    "SHARES_EXCEED_MAX_FILL",
  );
  assert.equal(mandateAdmission({ ...ok, shares: 20 }), null);
  // The cap is inclusive: exactly the cap is admitted, one micro more is not.
  assert.equal(
    mandateAdmission({ ...ok, dailyMicros: 90_000_000n }),
    null,
    "90 + 10 = 100 bUSD fits",
  );
  assert.equal(
    mandateAdmission({ ...ok, dailyMicros: 90_000_001n }),
    "DAILY_CAP_EXCEEDED",
  );
  assert.equal(
    mandateAdmission({ ...ok, openMicros: 490_000_000n }),
    null,
    "490 + 10 = 500 bUSD fits",
  );
  assert.equal(
    mandateAdmission({ ...ok, openMicros: 490_000_001n }),
    "OPEN_CAP_EXCEEDED",
  );
  // A fill larger than the daily cap on its own can never be admitted.
  assert.equal(
    mandateAdmission({
      ...ok,
      mandate: { ...mandate, dailyNotionalCapMicros: 5_000_000n },
    }),
    "DAILY_CAP_EXCEEDED",
  );
  assert.throws(
    () => mandateAdmission({ ...ok, shares: 0 }),
    /INVALID_TRADER_INPUT/,
  );
});
