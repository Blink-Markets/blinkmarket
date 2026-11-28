import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeFreshness } from "../packages/schemas/src/index.ts";
import { sampleFreshness, sampleWindowSummaries } from "../apps/web/content/sample-freshness.ts";
import {
  sampleMarkets,
  marketQuestion,
  formatBpsPercent,
  stateLabel,
  findMarket,
  consensusForecast,
  formatUtc,
  entitySlug,
  yAxisBounds,
  chartAriaLabel,
  lifecycleSteps,
  stateDetail,
  resolutionRule,
  frozenSpec,
  possessive,
  windowScheduledAt,
  isoToUnix,
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
    assert.ok(Math.abs(last.consensus - m.forecastBps / 100) <= 0.05, `${m.id} forecast mismatch`);
    for (const [i, w] of m.windows.entries()) {
      assert.ok(w.consensus >= 0 && w.consensus <= 100, m.id);
      assert.ok(w.lastFill === null || (w.lastFill >= 0 && w.lastFill <= 100), m.id);
      assert.ok(Number.isInteger(w.forecasters) && w.forecasters >= 1, m.id);
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

test("detail data: evidence and reasoning shape", () => {
  for (const m of sampleMarkets) {
    assert.ok(m.evidence.length >= 1 && m.evidence.length <= 3, m.id);
    for (const e of m.evidence) {
      assert.notEqual(e.visibility, "PRIVATE");
      assert.match(e.title, /\(sample\)$/);
      assert.match(e.digest, /^[0-9a-f]{4}…[0-9a-f]{4}$/);
      assert.equal(e.source, "example.com/fixture-only");
    }
    assert.ok(!("cost" in m));
    assert.ok(m.reasoning.length >= 2 && m.reasoning.length <= 3);
    for (const r of m.reasoning) {
      assert.ok(r.probability >= 1 && r.probability <= 99);
      assert.ok(r.summary.trim());
    }
  }
});

test("helpers: consensusForecast, formatUtc and entitySlug", () => {
  assert.equal(consensusForecast({ consensus: 62.4 }), 62.4);
  assert.equal(formatUtc("2026-10-31T16:00:00Z"), "2026-10-31 16:00 UTC");
  assert.throws(() => formatUtc("2026-10-31"));
  assert.equal(entitySlug("Marrow & Vale Textiles"), "marrow-vale-textiles");
});

test("yAxisBounds is a 10-point grid containing every value", () => {
  for (const m of sampleMarkets) {
    const { lo, hi, ticks } = yAxisBounds(m.windows);
    assert.equal(lo % 10, 0);
    assert.equal(hi % 10, 0);
    assert.ok(hi > lo && ticks.length >= 2);
    for (const w of m.windows) for (const v of [w.consensus, w.lastFill]) if (v !== null) assert.ok(v >= lo && v <= hi, m.id);
  }
  const s1 = findMarket("sample-01");
  assert.ok(s1);
});

test("chartAriaLabel summarises first and last values", () => {
  const s1 = findMarket("sample-01");
  assert.ok(s1);
  assert.match(chartAriaLabel(s1.windows), /consensus/i);
  assert.match(chartAriaLabel(s1.windows), /last fill/i);
  const label = chartAriaLabel(s1.windows);
  assert.ok(label.includes(`${s1.windows[0]!.consensus.toFixed(1)}%`) && label.includes(`${s1.windows.at(-1)!.consensus.toFixed(1)}%`), label);
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
  assert.equal(invalid[3]?.detail, "keeper can finalize INVALID at 2026-09-15");
  assert.match(invalid[2]?.detail ?? "", /^no proposer bond by/);
  assert.deepEqual(invalid.map((s) => s.status), ["done", "done", "skipped", "now"]);
  assert.equal(steps("sample-01")[0]?.detail, "market open until close");
});

test("possessive handles names ending in s", () => {
  assert.equal(possessive("Harlow Fen Robotics"), "Harlow Fen Robotics'");
  assert.equal(possessive("Quillon Grain Cooperative"), "Quillon Grain Cooperative's");
  const rules = sampleMarkets.map((m) => resolutionRule(m)[2]);
  assert.ok(rules.every((r) => !r.includes("s's ")));
});

test("stateDetail, resolutionRule and frozenSpec", () => {
  const s1 = findMarket("sample-01");
  const s6 = findMarket("sample-06");
  assert.ok(s1 && s6);
  assert.equal(stateDetail(s1), "Closes 2026-10-31 16:00 UTC");
  assert.match(stateDetail(s6), /No qualifying value/);
  assert.equal(
    resolutionRule(s1).join(""),
    "YES if the first qualifying release of Ostrander Kiln Works' FY2025 Q3 GAAP reported gross margin is below 70.00%. NO if it is 70.00% or higher. A proposer can propose only YES or NO. If no result is final by the hard deadline, for example because no qualifying value was published, a keeper can finalize the market as INVALID and each side gets 0.5 bUSD per share.",
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
  });
  assert.equal(stateDetail(s6), "No qualifying value; finalized INVALID after the hard deadline");
});

const WINDOW_OPEN_SECONDS = 1800;
const DAY = 86_400;

test("every sample window has analysed + carried equal to its forecasters", () => {
  for (const m of sampleMarkets) {
    for (const w of m.windows) {
      assert.ok(Number.isInteger(w.analysed) && w.analysed >= 0, `${m.id} ${w.date}`);
      assert.ok(Number.isInteger(w.carried) && w.carried >= 0, `${m.id} ${w.date}`);
      assert.equal(w.analysed + w.carried, w.forecasters, `${m.id} ${w.date}`);
      assert.ok(Number.isInteger(w.firstChecked) && w.firstChecked >= 0, `${m.id} ${w.date}`);
    }
  }
});

test("a window with changes has at least one analysed answer", () => {
  let windowsWithChanges = 0;
  for (const m of sampleMarkets) {
    for (const w of m.windows) {
      if (w.changes.length > 0) {
        windowsWithChanges++;
        assert.ok(w.analysed >= 1, `${m.id} ${w.date}`);
      }
      if (w.firstChecked > 0) assert.ok(w.analysed >= 1, `${m.id} ${w.date} first check needs an analysis`);
    }
  }
  assert.ok(windowsWithChanges >= 6, "the samples exercise changes");
  // The samples also exercise a window where every answer was carried forward, and a heartbeat (mixed) window.
  const all = sampleMarkets.flatMap((m) => m.windows);
  assert.ok(all.some((w) => w.analysed === 0));
  assert.ok(all.some((w) => w.analysed > 0 && w.carried > 0));
});

test("sample-markets.ts and ForecastChart.tsx import neither @blink/schemas nor zod", () => {
  for (const file of ["apps/web/content/sample-markets.ts", "apps/web/components/markets/ForecastChart.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /@blink\/schemas|["']zod["']/, file);
  }
});

test("sampleFreshness equals computeFreshness over the sample windows", () => {
  const open = sampleMarkets.filter((m) => m.state === "OPEN");
  assert.ok(open.length >= 2);
  for (const m of open) {
    const expected = computeFreshness(sampleWindowSummaries(m), isoToUnix(`${m.updatedAt}T23:59:59Z`));
    const got = sampleFreshness(m);
    assert.deepEqual(got, expected, m.id);
    assert.equal(got?.level, "CURRENT", m.id);
    assert.equal(got?.windowsBehind, 0, m.id);
    assert.equal(got?.lastAnsweredWindow, windowScheduledAt(m.windows.at(-1)!.date), m.id);
    assert.equal(got?.latestWindow.answers, m.windows.at(-1)!.forecasters, m.id);
    const observed = m.windows.flatMap((w) => w.changes.map((c) => isoToUnix(c.observedAt)));
    assert.equal(got?.evidenceChangedAt, Math.max(...observed), m.id);
  }
});

test("a market that is not OPEN has no freshness level", () => {
  for (const id of ["sample-03", "sample-04", "sample-05", "sample-06"]) {
    const m = findMarket(id);
    assert.ok(m);
    assert.notEqual(m.state, "OPEN");
    assert.equal(sampleFreshness(m), null, id);
  }
});

test("evidence change dates are ordered: since is before observedAt, and observedAt is not after the window", () => {
  for (const m of sampleMarkets) {
    for (const w of m.windows) {
      const scheduledAt = windowScheduledAt(w.date);
      for (const c of w.changes) {
        assert.match(c.source, /^https:\/\/example\.com\/fixture-only\//, `${m.id} ${w.date}`);
        assert.match(c.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        assert.match(c.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        assert.ok(isoToUnix(c.since) < isoToUnix(c.observedAt), `${m.id} ${w.date} since`);
        assert.ok(isoToUnix(c.observedAt) <= scheduledAt, `${m.id} ${w.date} observedAt after the window`);
        assert.ok(isoToUnix(c.observedAt) >= scheduledAt - WINDOW_OPEN_SECONDS - DAY, `${m.id} ${w.date} observedAt a day before the window`);
        assert.ok(c.summary.trim());
        assert.ok(c.moves.length >= 1 && c.moves.length <= w.analysed, `${m.id} ${w.date} moves`);
        for (const mv of c.moves) {
          assert.ok(mv.from >= 1 && mv.from <= 99 && mv.to >= 1 && mv.to <= 99);
          assert.ok(mv.agent.trim());
        }
        assert.ok(c.snapshot === null || /^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(c.snapshot), `${m.id} ${w.date} snapshot`);
      }
    }
  }
  const all = sampleMarkets.flatMap((m) => m.windows.flatMap((w) => w.changes));
  assert.ok(all.some((c) => c.snapshot === null), "one sample shows a snapshot that is not available");
  assert.ok(all.some((c) => c.snapshot !== null));
});

test("chartAriaLabel names how many windows had a changed source", () => {
  const s1 = findMarket("sample-01");
  assert.ok(s1);
  const n = s1.windows.filter((w) => w.changes.length > 0).length;
  assert.ok(n >= 1);
  assert.ok(chartAriaLabel(s1.windows).includes(`Sources changed (reported) in ${n} of ${s1.windows.length} windows.`), chartAriaLabel(s1.windows));
  assert.match(chartAriaLabel(s1.windows), /^Line chart of the probability of YES/);
});

test("a window whose answers were all carried forward has the same consensus as the window before it", () => {
  for (const m of sampleMarkets) {
    for (const [i, w] of m.windows.entries()) {
      const prev = m.windows[i - 1];
      if (w.analysed === 0 && prev) assert.equal(w.consensus, prev.consensus, `${m.id} ${w.date}`);
    }
  }
});

test("when a change lists a move for every forecaster, the consensus lies between the lowest and the highest new value", () => {
  let checked = 0;
  for (const m of sampleMarkets) {
    for (const [i, w] of m.windows.entries()) {
      const prev = m.windows[i - 1];
      for (const c of w.changes) {
        if (c.moves.length !== w.forecasters) continue;
        checked++;
        const to = c.moves.map((mv) => mv.to);
        assert.ok(w.consensus >= Math.min(...to) && w.consensus <= Math.max(...to), `${m.id} ${w.date}: ${w.consensus} outside ${to.join(", ")}`);
        // The consensus does not move against the direction in which every forecaster moved.
        if (prev && c.moves.every((mv) => mv.to >= mv.from)) assert.ok(w.consensus >= prev.consensus, `${m.id} ${w.date}: all moved up, consensus fell`);
        if (prev && c.moves.every((mv) => mv.to <= mv.from)) assert.ok(w.consensus <= prev.consensus, `${m.id} ${w.date}: all moved down, consensus rose`);
      }
    }
  }
  assert.ok(checked >= 6, "the check must see the sample changes");
});

test("each changed source was checked for the first time in its window or an earlier one", () => {
  for (const m of sampleMarkets) {
    let firstChecked = 0;
    const changed = new Set<string>();
    for (const w of m.windows) {
      firstChecked += w.firstChecked;
      for (const c of w.changes) changed.add(c.source);
      assert.ok(firstChecked >= changed.size, `${m.id} ${w.date}: ${changed.size} sources changed, ${firstChecked} first checked`);
    }
  }
});
