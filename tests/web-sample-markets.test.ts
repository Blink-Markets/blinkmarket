import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sampleMarkets,
  marketQuestion,
  formatBpsPercent,
  stateLabel,
  findMarket,
  platformForecast,
  formatUtc,
  formatUsdMicros,
  entitySlug,
  yAxisBounds,
  chartAriaLabel,
  lifecycleSteps,
  stateDetail,
  resolutionRule,
  frozenSpec,
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

const TODAY = "2026-10-10";

test("detail data: windows, probabilities and forecast consistency", () => {
  for (const m of sampleMarkets) {
    assert.ok(m.windows.length >= 6 && m.windows.length <= 10, m.id);
    const last = m.windows[m.windows.length - 1];
    assert.ok(last, m.id);
    assert.ok(last.date <= m.updatedAt, `${m.id} windows end after updatedAt`);
    assert.ok(Math.abs((last.a + last.b) / 2 - m.forecastBps / 100) <= 0.05, `${m.id} forecast mismatch`);
    for (const [i, w] of m.windows.entries()) {
      for (const v of [w.a, w.b, w.baseline]) assert.ok(v >= 0 && v <= 100, m.id);
      const prev = m.windows[i - 1];
      if (prev) assert.ok(prev.date < w.date, `${m.id} dates not increasing`);
    }
  }
});

test("detail data: deadlines, period and state consistency", () => {
  for (const m of sampleMarkets) {
    assert.ok(m.closeAt < m.proposalDeadline && m.proposalDeadline < m.hardDeadline, m.id);
    assert.match(m.closeAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const year = m.fiscalPeriod.slice(2, 6);
    const q = Number(m.fiscalPeriod.slice(-1));
    assert.equal(m.periodStart, `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`, m.id);
    assert.equal(m.periodEnd.slice(0, 7), `${year}-${String(q * 3).padStart(2, "0")}`, m.id);
    assert.ok(m.periodStart < m.periodEnd, m.id);
    if (m.state === "OPEN") assert.ok(m.closeAt.slice(0, 10) > TODAY, `${m.id} open but closed`);
    else assert.ok(m.closeAt.slice(0, 10) < m.updatedAt, `${m.id} closeAt after updatedAt`);
    if (m.outcome === "INVALID") assert.ok(m.hardDeadline.slice(0, 10) < m.updatedAt, `${m.id} INVALID before hard deadline`);
  }
  assert.equal(findMarket("sample-05")?.outcome, "NO");
});

test("detail data: evidence and cost shape", () => {
  for (const m of sampleMarkets) {
    assert.ok(m.evidence.length >= 1 && m.evidence.length <= 3, m.id);
    for (const e of m.evidence) {
      assert.match(e.title, /\(sample\)$/);
      assert.match(e.digest, /^[0-9a-f]{4}…[0-9a-f]{4}$/);
      assert.equal(e.source, "example.com/fixture-only");
    }
    for (const v of Object.values(m.cost)) assert.ok(Number.isInteger(v) && v >= 0, m.id);
  }
});

test("sample-01 matches the approved mockup", () => {
  const m = findMarket("sample-01");
  assert.ok(m);
  assert.deepEqual(m.windows.map((w) => w.a), [56.0, 57.5, 58.0, 60.5, 61.0, 62.5, 63.0, 64.0]);
  assert.deepEqual(m.windows.map((w) => w.b), [54.0, 54.5, 56.0, 57.0, 58.5, 59.0, 60.0, 60.8]);
  assert.deepEqual(m.windows.map((w) => w.baseline), [50.0, 51.0, 52.5, 52.0, 54.0, 55.5, 56.0, 57.0]);
  assert.equal(formatUsdMicros(m.cost.spentMicros), "$3.42");
  assert.equal(formatUsdMicros(m.cost.reservedMicros), "$0.80");
});

test("helpers: platformForecast, formatUtc, formatUsdMicros, entitySlug", () => {
  assert.equal(platformForecast({ a: 64, b: 60.8 }), 62.4);
  assert.equal(formatUtc("2026-10-31T16:00:00Z"), "2026-10-31 16:00 UTC");
  assert.throws(() => formatUtc("2026-10-31"));
  assert.equal(formatUsdMicros(0), "$0.00");
  assert.equal(formatUsdMicros(120_000), "$0.12");
  assert.equal(entitySlug("Marrow & Vale Textiles"), "marrow-vale-textiles");
});

test("yAxisBounds is a 10-point grid containing every value", () => {
  for (const m of sampleMarkets) {
    const { lo, hi, ticks } = yAxisBounds(m.windows);
    assert.equal(lo % 10, 0);
    assert.equal(hi % 10, 0);
    assert.ok(hi > lo && ticks.length >= 2);
    for (const w of m.windows) for (const v of [w.a, w.b, w.baseline]) assert.ok(v >= lo && v <= hi, m.id);
  }
  const s1 = findMarket("sample-01");
  assert.ok(s1);
  assert.deepEqual(yAxisBounds(s1.windows), { lo: 40, hi: 70, ticks: [40, 50, 60, 70] });
});

test("chartAriaLabel summarises first and last values", () => {
  const s1 = findMarket("sample-01");
  assert.ok(s1);
  assert.equal(
    chartAriaLabel(s1.windows),
    "Line chart of the probability of YES from 2026-09-29 to 2026-10-06. Platform forecast rises from 55.0% to 62.4%; the baseline rises from 50.0% to 57.0%.",
  );
});

test("lifecycleSteps follow the market state", () => {
  const steps = (id: string) => {
    const m = findMarket(id);
    assert.ok(m);
    return lifecycleSteps(m);
  };
  assert.deepEqual(steps("sample-01").map((s) => [s.label, s.status]), [["Open", "now"], ["Closed", "todo"], ["Proposed", "todo"], ["Final", "todo"]]);
  assert.deepEqual(steps("sample-03").map((s) => s.status), ["done", "done", "now", "todo"]);
  assert.deepEqual(steps("sample-04").map((s) => [s.label, s.status]), [["Closed", "done"], ["Proposed", "done"], ["Disputed", "now"], ["Final", "todo"]]);
  assert.deepEqual(steps("sample-05").map((s) => s.status), ["done", "done", "done", "now"]);
  const invalid = steps("sample-06");
  assert.equal(invalid[3]?.detail, "INVALID: no qualifying value by 2026-09-15");
  assert.match(invalid[2]?.detail ?? "", /^no proposal by/);
});

test("stateDetail, resolutionRule and frozenSpec", () => {
  const s1 = findMarket("sample-01");
  const s6 = findMarket("sample-06");
  assert.ok(s1 && s6);
  assert.equal(stateDetail(s1), "Closes 2026-10-31 16:00 UTC");
  assert.match(stateDetail(s6), /No qualifying value/);
  assert.equal(
    resolutionRule(s1).join(""),
    "YES if the first qualifying release of Ostrander Kiln Works's FY2025 Q3 GAAP reported gross margin is below 70.00%. NO if it is 70.00% or higher. If no qualifying value is published, the market resolves INVALID and each side gets 0.5 bUSD per share.",
  );
  assert.deepEqual(frozenSpec(s1), {
    schemaVersion: "blink.market.v0.1.1",
    mode: "REPLAY",
    templateId: "GM_LT_V1",
    entityId: "sample-ostrander-kiln-works",
    fiscalPeriod: "FY2025Q3",
    metric: "quarterly_gaap_reported_gross_margin",
    thresholdBps: 7000,
    comparator: "LT",
    valueVersion: "FIRST_QUALIFYING_RELEASE",
    missingValueOutcome: "INVALID",
    challengeSeconds: 120,
  });
});
