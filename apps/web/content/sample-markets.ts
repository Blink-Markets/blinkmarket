// Sample REPLAY markets for the read-only showcase. Companies are fictional and
// follow the GM_LT_V1 template; these are not live markets or forecast records.
export type MarketState = "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL";
export type Outcome = "YES" | "NO" | "INVALID";
export type EvidenceVisibility = "PUBLIC" | "EXCERPT" | "PRIVATE";

export type ForecastWindow = { date: string; a: number; b: number; baseline: number };

export type EvidenceEntry = {
  title: string;
  visibility: EvidenceVisibility;
  capturedAt: string;
  source: "example.com/fixture-only";
  digest: string;
};

export type SampleMarket = {
  id: string;
  mode: "REPLAY";
  entity: string;
  fiscalPeriod: string;
  thresholdBps: number;
  forecastBps: number;
  updatedAt: string;
  state: MarketState;
  outcome: Outcome | null;
  periodStart: string;
  periodEnd: string;
  closeAt: string;
  proposalDeadline: string;
  hardDeadline: string;
  windows: readonly ForecastWindow[];
  evidence: readonly EvidenceEntry[];
  cost: { spentMicros: number; reservedMicros: number; unknownMicros: number };
};

const src = "example.com/fixture-only" as const;

export const sampleMarkets: readonly SampleMarket[] = [
  {
    id: "sample-01", mode: "REPLAY", entity: "Ostrander Kiln Works", fiscalPeriod: "FY2025Q3", thresholdBps: 7000, forecastBps: 6240, updatedAt: "2026-10-06", state: "OPEN", outcome: null,
    periodStart: "2025-07-01", periodEnd: "2025-09-30", closeAt: "2026-10-31T16:00:00Z", proposalDeadline: "2026-11-07T16:00:00Z", hardDeadline: "2026-11-10T16:00:00Z",
    windows: [
      { date: "2026-09-29", a: 56.0, b: 54.0, baseline: 50.0 },
      { date: "2026-09-30", a: 57.5, b: 54.5, baseline: 51.0 },
      { date: "2026-10-01", a: 58.0, b: 56.0, baseline: 52.5 },
      { date: "2026-10-02", a: 60.5, b: 57.0, baseline: 52.0 },
      { date: "2026-10-03", a: 61.0, b: 58.5, baseline: 54.0 },
      { date: "2026-10-04", a: 62.5, b: 59.0, baseline: 55.5 },
      { date: "2026-10-05", a: 63.0, b: 60.0, baseline: 56.0 },
      { date: "2026-10-06", a: 64.0, b: 60.8, baseline: 57.0 },
    ],
    evidence: [
      { title: "FY2025 Q2 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-28", source: src, digest: "9c1e…4b07" },
      { title: "FY2025 Q3 guidance, excerpt (sample)", visibility: "EXCERPT", capturedAt: "2026-10-02", source: src, digest: "51aa…e3d9" },
    ],
    cost: { spentMicros: 3_420_000, reservedMicros: 800_000, unknownMicros: 0 },
  },
  {
    id: "sample-02", mode: "REPLAY", entity: "Pellbrook Freight Lines", fiscalPeriod: "FY2025Q3", thresholdBps: 3500, forecastBps: 4120, updatedAt: "2026-10-05", state: "OPEN", outcome: null,
    periodStart: "2025-07-01", periodEnd: "2025-09-30", closeAt: "2026-10-28T16:00:00Z", proposalDeadline: "2026-11-04T16:00:00Z", hardDeadline: "2026-11-07T16:00:00Z",
    windows: [
      { date: "2026-09-29", a: 46.0, b: 44.0, baseline: 40.0 },
      { date: "2026-09-30", a: 45.5, b: 43.0, baseline: 41.0 },
      { date: "2026-10-01", a: 44.0, b: 42.5, baseline: 41.5 },
      { date: "2026-10-02", a: 43.5, b: 41.0, baseline: 39.0 },
      { date: "2026-10-03", a: 42.5, b: 41.5, baseline: 38.5 },
      { date: "2026-10-04", a: 42.0, b: 40.0, baseline: 37.0 },
      { date: "2026-10-05", a: 42.0, b: 40.4, baseline: 37.5 },
    ],
    evidence: [
      { title: "FY2025 Q2 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-27", source: src, digest: "a07d…12fc" },
    ],
    cost: { spentMicros: 2_180_000, reservedMicros: 640_000, unknownMicros: 90_000 },
  },
  {
    id: "sample-03", mode: "REPLAY", entity: "Marrow & Vale Textiles", fiscalPeriod: "FY2025Q2", thresholdBps: 5200, forecastBps: 7810, updatedAt: "2026-09-30", state: "PROPOSED", outcome: null,
    periodStart: "2025-04-01", periodEnd: "2025-06-30", closeAt: "2026-09-24T16:00:00Z", proposalDeadline: "2026-10-01T16:00:00Z", hardDeadline: "2026-10-04T16:00:00Z",
    windows: [
      { date: "2026-09-17", a: 70.0, b: 68.0, baseline: 62.0 },
      { date: "2026-09-18", a: 72.0, b: 69.5, baseline: 63.0 },
      { date: "2026-09-19", a: 73.5, b: 71.0, baseline: 66.0 },
      { date: "2026-09-20", a: 75.0, b: 72.5, baseline: 67.5 },
      { date: "2026-09-21", a: 76.0, b: 74.0, baseline: 69.0 },
      { date: "2026-09-22", a: 77.5, b: 75.0, baseline: 70.0 },
      { date: "2026-09-23", a: 78.5, b: 76.5, baseline: 71.0 },
      { date: "2026-09-24", a: 79.0, b: 77.2, baseline: 72.0 },
    ],
    evidence: [
      { title: "FY2025 Q2 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-25", source: src, digest: "e4b2…70a1" },
      { title: "Proposed outcome capture, excerpt (sample)", visibility: "EXCERPT", capturedAt: "2026-09-29", source: src, digest: "03cd…9f58" },
    ],
    cost: { spentMicros: 4_050_000, reservedMicros: 0, unknownMicros: 0 },
  },
  {
    id: "sample-04", mode: "REPLAY", entity: "Tidewell Instruments", fiscalPeriod: "FY2025Q2", thresholdBps: 6100, forecastBps: 3350, updatedAt: "2026-09-28", state: "DISPUTED", outcome: null,
    periodStart: "2025-04-01", periodEnd: "2025-06-30", closeAt: "2026-09-20T16:00:00Z", proposalDeadline: "2026-09-27T16:00:00Z", hardDeadline: "2026-09-30T16:00:00Z",
    windows: [
      { date: "2026-09-13", a: 44.0, b: 42.0, baseline: 48.0 },
      { date: "2026-09-14", a: 42.0, b: 40.5, baseline: 47.0 },
      { date: "2026-09-15", a: 40.0, b: 38.0, baseline: 45.0 },
      { date: "2026-09-16", a: 38.5, b: 36.0, baseline: 44.0 },
      { date: "2026-09-17", a: 37.0, b: 34.5, baseline: 42.0 },
      { date: "2026-09-18", a: 36.0, b: 33.0, baseline: 41.0 },
      { date: "2026-09-19", a: 35.5, b: 32.5, baseline: 40.0 },
      { date: "2026-09-20", a: 35.0, b: 32.0, baseline: 40.5 },
    ],
    evidence: [
      { title: "FY2025 Q2 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-21", source: src, digest: "7d90…c2e6" },
      { title: "Challenger filing, excerpt (sample)", visibility: "EXCERPT", capturedAt: "2026-09-28", source: src, digest: "b8f3…1a4d" },
      { title: "Operator working notes (sample)", visibility: "PRIVATE", capturedAt: "2026-09-28", source: src, digest: "2e6a…d5b0" },
    ],
    cost: { spentMicros: 5_310_000, reservedMicros: 500_000, unknownMicros: 120_000 },
  },
  {
    id: "sample-05", mode: "REPLAY", entity: "Quillon Grain Cooperative", fiscalPeriod: "FY2025Q1", thresholdBps: 2800, forecastBps: 1890, updatedAt: "2026-09-21", state: "FINAL", outcome: "NO",
    periodStart: "2025-01-01", periodEnd: "2025-03-31", closeAt: "2026-09-08T16:00:00Z", proposalDeadline: "2026-09-15T16:00:00Z", hardDeadline: "2026-09-18T16:00:00Z",
    windows: [
      { date: "2026-09-01", a: 24.0, b: 22.0, baseline: 26.0 },
      { date: "2026-09-02", a: 23.0, b: 21.5, baseline: 25.0 },
      { date: "2026-09-03", a: 22.0, b: 20.5, baseline: 24.5 },
      { date: "2026-09-04", a: 21.5, b: 20.0, baseline: 23.0 },
      { date: "2026-09-05", a: 20.5, b: 19.5, baseline: 22.5 },
      { date: "2026-09-06", a: 20.0, b: 19.0, baseline: 22.0 },
      { date: "2026-09-07", a: 19.8, b: 18.6, baseline: 21.0 },
      { date: "2026-09-08", a: 19.5, b: 18.3, baseline: 21.5 },
    ],
    evidence: [
      { title: "FY2025 Q1 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-09", source: src, digest: "f12b…6c39" },
      { title: "Resolution capture, excerpt (sample)", visibility: "EXCERPT", capturedAt: "2026-09-15", source: src, digest: "44d7…a0e2" },
    ],
    cost: { spentMicros: 4_760_000, reservedMicros: 0, unknownMicros: 0 },
  },
  {
    id: "sample-06", mode: "REPLAY", entity: "Harlow Fen Robotics", fiscalPeriod: "FY2025Q1", thresholdBps: 4500, forecastBps: 5000, updatedAt: "2026-09-19", state: "FINAL", outcome: "INVALID",
    periodStart: "2025-01-01", periodEnd: "2025-03-31", closeAt: "2026-09-05T16:00:00Z", proposalDeadline: "2026-09-12T16:00:00Z", hardDeadline: "2026-09-15T16:00:00Z",
    windows: [
      { date: "2026-08-29", a: 52.0, b: 48.0, baseline: 50.0 },
      { date: "2026-08-30", a: 51.0, b: 49.5, baseline: 49.0 },
      { date: "2026-08-31", a: 52.5, b: 47.5, baseline: 51.0 },
      { date: "2026-09-01", a: 50.5, b: 48.5, baseline: 50.5 },
      { date: "2026-09-02", a: 51.5, b: 49.0, baseline: 49.5 },
      { date: "2026-09-03", a: 50.0, b: 50.5, baseline: 50.0 },
      { date: "2026-09-04", a: 51.0, b: 49.0, baseline: 50.5 },
      { date: "2026-09-05", a: 51.0, b: 49.0, baseline: 50.0 },
    ],
    evidence: [
      { title: "FY2025 Q1 source search, no release found (sample)", visibility: "PUBLIC", capturedAt: "2026-09-13", source: src, digest: "d3a8…05bf" },
    ],
    cost: { spentMicros: 1_940_000, reservedMicros: 0, unknownMicros: 0 },
  },
];

export function formatBpsPercent(bps: number, digits = 1): string {
  return `${(bps / 100).toFixed(digits)}%`;
}

function formatPeriod(fiscalPeriod: string): string {
  return fiscalPeriod.replace(/^(FY\d{4})(Q[1-4])$/, "$1 $2");
}

export function marketQuestion(m: SampleMarket): string {
  return `Will ${m.entity} report ${formatPeriod(m.fiscalPeriod)} GAAP gross margin below ${formatBpsPercent(m.thresholdBps, 2)}?`;
}

const stateNames: Record<MarketState, string> = {
  OPEN: "Open",
  CLOSED: "Closed",
  PROPOSED: "Proposed",
  DISPUTED: "Disputed",
  FINAL: "Final",
};

export function stateLabel(m: SampleMarket): string {
  return m.state === "FINAL" && m.outcome ? `Final · ${m.outcome}` : stateNames[m.state];
}

export function findMarket(id: string): SampleMarket | undefined {
  return sampleMarkets.find((m) => m.id === id);
}

/** Plain average of the two platform forecasters, rounded to 0.1. */
export function platformForecast(w: Pick<ForecastWindow, "a" | "b">): number {
  return Math.round(((w.a + w.b) / 2) * 10) / 10;
}

export function entitySlug(entity: string): string {
  return entity.toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** "2026-10-31T16:00:00Z" -> "2026-10-31 16:00 UTC" */
export function formatUtc(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (!m) throw new Error(`not an ISO UTC string: ${iso}`);
  return `${m[1]} ${m[2]} UTC`;
}

export function formatUtcDate(iso: string): string {
  return iso.slice(0, 10);
}

/** USD micros (1e-6 dollars) as "$3.42". */
export function formatUsdMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** Y-axis band: floor(min-5) to ceil(max+5), rounded outward to 10s and clamped to 0-100. */
export function yAxisBounds(windows: readonly ForecastWindow[]): { lo: number; hi: number; ticks: number[] } {
  const all = windows.flatMap((w) => [w.a, w.b, w.baseline, platformForecast(w)]);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 5) / 10) * 10);
  const hi = Math.min(100, Math.ceil((Math.max(...all) + 5) / 10) * 10);
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += 10) ticks.push(v);
  return { lo, hi, ticks };
}

export function chartAriaLabel(windows: readonly ForecastWindow[]): string {
  const first = windows[0];
  const last = windows[windows.length - 1];
  if (!first || !last) return "Line chart of the probability of YES (no data).";
  const dir = (a: number, b: number) => (b > a ? "rises" : b < a ? "falls" : "stays level");
  const p0 = platformForecast(first);
  const p1 = platformForecast(last);
  const fromTo = (a: number, b: number) => (a === b ? `at ${a.toFixed(1)}%` : `from ${a.toFixed(1)}% to ${b.toFixed(1)}%`);
  return `Line chart of the probability of YES from ${first.date} to ${last.date}. Platform forecast ${dir(p0, p1)} ${fromTo(p0, p1)}; the baseline ${dir(first.baseline, last.baseline)} ${fromTo(first.baseline, last.baseline)}.`;
}

/** "Works" -> "Works'", "Cooperative" -> "Cooperative's" */
export function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

export type LifecycleStep = { key: string; label: string; detail: string; status: "done" | "now" | "todo" | "skipped" };

export function lifecycleSteps(m: SampleMarket): LifecycleStep[] {
  const timedOut = m.state === "FINAL" && m.outcome === "INVALID";
  const keys = m.state === "DISPUTED" ? ["closed", "proposed", "disputed", "final"] : ["open", "closed", "proposed", "final"];
  const nowIdx = keys.indexOf(m.state.toLowerCase());
  const names: Record<string, string> = { open: "Open", closed: "Closed", proposed: "Proposed", disputed: "Disputed", final: "Final" };
  const detail: Record<string, string> = {
    open: "market open until close",
    closed: formatUtc(m.closeAt),
    proposed: timedOut
      ? `no proposal by ${formatUtcDate(m.proposalDeadline)}`
      : `by ${formatUtcDate(m.proposalDeadline)}, 2-minute challenge window (REPLAY)`,
    disputed: "a challenge was raised; the outcome is under review",
    final: timedOut
      ? `INVALID: no qualifying value by ${formatUtcDate(m.hardDeadline)}`
      : m.state === "FINAL"
        ? `${m.outcome} is final`
        : `INVALID if not final by ${formatUtcDate(m.hardDeadline)}`,
  };
  return keys.map((key, i) => ({
    key,
    label: names[key] ?? key,
    detail: detail[key] ?? "",
    status: timedOut && key === "proposed" ? "skipped" : i < nowIdx ? "done" : i === nowIdx ? "now" : "todo",
  }));
}

/** One line under the State fact. */
export function stateDetail(m: SampleMarket): string {
  if (m.state === "OPEN") return `Closes ${formatUtc(m.closeAt)}`;
  if (m.state === "FINAL") {
    return m.outcome === "INVALID" ? "No qualifying value by the hard deadline" : `Resolved ${m.outcome}`;
  }
  return `Closed ${formatUtc(m.closeAt)}`;
}

/** Rule sentence split around the two emphasised phrases. */
export function resolutionRule(m: SampleMarket): [string, string, string, string, string] {
  const th = formatBpsPercent(m.thresholdBps, 2);
  return [
    "YES if the ",
    "first qualifying release",
    ` of ${possessive(m.entity)} ${formatPeriod(m.fiscalPeriod)} GAAP reported gross margin is below ${th}. NO if it is ${th} or higher. If no qualifying value is published, the market resolves `,
    "INVALID",
    " and each side gets 0.5 bUSD per share.",
  ];
}

export type FrozenSpec = {
  schemaVersion: "blink.market.v0.1.1";
  mode: "REPLAY";
  templateId: "GM_LT_V1";
  entityId: string;
  fiscalPeriod: string;
  metric: "quarterly_gaap_reported_gross_margin";
  thresholdBps: number;
  comparator: "LT";
  valueVersion: "FIRST_QUALIFYING_RELEASE";
  missingValueOutcome: "INVALID";
  challengeSeconds: 120;
};

export function frozenSpec(m: SampleMarket): FrozenSpec {
  return {
    schemaVersion: "blink.market.v0.1.1",
    mode: m.mode,
    templateId: "GM_LT_V1",
    entityId: `sample-${entitySlug(m.entity)}`,
    fiscalPeriod: m.fiscalPeriod,
    metric: "quarterly_gaap_reported_gross_margin",
    thresholdBps: m.thresholdBps,
    comparator: "LT",
    valueVersion: "FIRST_QUALIFYING_RELEASE",
    missingValueOutcome: "INVALID",
    challengeSeconds: 120,
  };
}
