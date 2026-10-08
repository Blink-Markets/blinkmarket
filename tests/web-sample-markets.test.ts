import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sampleMarkets,
  marketQuestion,
  formatBpsPercent,
  stateLabel,
} from "../apps/web/content/sample-markets.ts";

test("sample markets are REPLAY-only with unique ids and valid bps", () => {
  assert.ok(sampleMarkets.length >= 6);
  assert.equal(new Set(sampleMarkets.map((m) => m.id)).size, sampleMarkets.length);
  for (const m of sampleMarkets) {
    assert.equal(m.mode, "REPLAY");
    assert.ok(m.forecastBps >= 0 && m.forecastBps <= 10_000, m.id);
    assert.ok(m.thresholdBps > 0 && m.thresholdBps < 10_000, m.id);
    assert.match(m.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(m.fiscalPeriod, /^FY\d{4}Q[1-4]$/);
  }
});

test("only FINAL markets carry an outcome", () => {
  for (const m of sampleMarkets) {
    assert.equal(m.state === "FINAL", m.outcome !== null, m.id);
  }
});

test("formatBpsPercent handles bounds", () => {
  assert.equal(formatBpsPercent(0), "0.0%");
  assert.equal(formatBpsPercent(10_000), "100.0%");
  assert.equal(formatBpsPercent(6240), "62.4%");
  assert.equal(formatBpsPercent(7000, 2), "70.00%");
});

test("question follows the GM_LT_V1 wording", () => {
  const first = sampleMarkets[0];
  assert.ok(first);
  assert.equal(
    marketQuestion(first),
    "Will Ostrander Kiln Works report FY2025 Q3 GAAP gross margin below 70.00%?",
  );
});

test("stateLabel names final outcomes", () => {
  const invalid = sampleMarkets.find((m) => m.outcome === "INVALID");
  assert.ok(invalid);
  assert.equal(stateLabel(invalid), "Final · INVALID");
  const open = sampleMarkets.find((m) => m.state === "OPEN");
  assert.ok(open);
  assert.equal(stateLabel(open), "Open");
});
