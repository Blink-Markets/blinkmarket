// Sample REPLAY markets for the read-only showcase. Companies are fictional and
// follow the GM_LT_V1 template; these are not live markets or forecast records.
export type MarketState = "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL";
export type Outcome = "YES" | "NO" | "INVALID";
export type EvidenceVisibility = "PUBLIC" | "EXCERPT";

/** A source that forecasters reported as changed in a window (status CHANGED; a first check is counted apart). */
export type EvidenceChange = {
  /** The https URL of the source. */
  source: string;
  /** The earlier moment the source was last seen unchanged (ISO UTC). */
  since: string;
  /** The moment the change was seen (ISO UTC). */
  observedAt: string;
  summary: string;
  /** Each analysing forecaster's signed probability of YES (percent) before and after this window. */
  moves: readonly { agent: string; from: number; to: number }[];
  /** The hash of the archived bytes, or null when no snapshot was archived. */
  snapshot: string | null;
};

export type ForecastWindow = {
  date: string;
  consensus: number;
  lastFill: number | null;
  forecasters: number;
  /** Answers whose note says the model ran in the window. */
  analysed: number;
  /** Answers that signed the earlier probability again. */
  carried: number;
  changes: readonly EvidenceChange[];
  /** Sources checked for the first time in the window: never a change. */
  firstChecked: number;
};

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
  reasoning: readonly { agent: string; probability: number; summary: string }[];
};

const src = "example.com/fixture-only" as const;

export const sampleMarkets: readonly SampleMarket[] = [
  {
    id: "sample-01", mode: "REPLAY", entity: "Ostrander Kiln Works", fiscalPeriod: "FY2025Q3", thresholdBps: 7000, forecastBps: 6240, updatedAt: "2026-10-06", state: "OPEN", outcome: null,
    periodStart: "2025-07-01", periodEnd: "2025-09-30", closeAt: "2026-10-31T16:00:00Z", proposalDeadline: "2026-11-07T16:00:00Z", hardDeadline: "2026-11-10T16:00:00Z",
    windows: [
      { date: "2026-09-29", consensus: 55.0, lastFill: 50.0, forecasters: 2, analysed: 2, carried: 0, changes: [], firstChecked: 2 },
      { date: "2026-09-30", consensus: 55.0, lastFill: 51.0, forecasters: 2, analysed: 1, carried: 1, changes: [], firstChecked: 0 },
      { date: "2026-10-01", consensus: 55.0, lastFill: null, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-10-02", consensus: 58.8, lastFill: 52.0, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/q3-guidance", since: "2026-10-01T15:20:00Z", observedAt: "2026-10-02T15:41:00Z", summary: "The guidance page now lists a 69% to 71% margin range, narrower than the earlier 68% to 72%.", moves: [{ agent: "forecaster-a", from: 56.0, to: 61.0 }, { agent: "forecaster-b", from: 54.0, to: 57.0 }], snapshot: "0x7a31…c4e0" }], firstChecked: 0 },
      { date: "2026-10-03", consensus: 58.8, lastFill: 54.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-10-04", consensus: 58.8, lastFill: 55.5, forecasters: 2, analysed: 1, carried: 1, changes: [], firstChecked: 0 },
      { date: "2026-10-05", consensus: 58.8, lastFill: 56.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-10-06", consensus: 62.4, lastFill: 57.0, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/q2-release", since: "2026-10-03T09:00:00Z", observedAt: "2026-10-06T15:38:00Z", summary: "The release page added a footnote that restates the Q2 gross margin as 68%.", moves: [{ agent: "forecaster-a", from: 61.0, to: 65.0 }, { agent: "forecaster-b", from: 57.0, to: 60.0 }], snapshot: null }], firstChecked: 0 },
    ],
    evidence: [
      { title: "FY2025 Q2 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-28", source: src, digest: "9c1e…4b07" },
      { title: "FY2025 Q3 guidance, excerpt (sample)", visibility: "EXCERPT", capturedAt: "2026-10-02", source: src, digest: "51aa…e3d9" },
    ],
    reasoning: [
      { agent: "forecaster-a", probability: 65, summary: "The sample Q2 release shows a 68% gross margin, below the 70% threshold." },
      { agent: "forecaster-b", probability: 60, summary: "The sample Q3 guidance suggests a 71% margin, leaving a chance of improvement." },
    ],
  },
  {
    id: "sample-02", mode: "REPLAY", entity: "Pellbrook Freight Lines", fiscalPeriod: "FY2025Q3", thresholdBps: 3500, forecastBps: 4120, updatedAt: "2026-10-05", state: "OPEN", outcome: null,
    periodStart: "2025-07-01", periodEnd: "2025-09-30", closeAt: "2026-10-28T16:00:00Z", proposalDeadline: "2026-11-04T16:00:00Z", hardDeadline: "2026-11-07T16:00:00Z",
    windows: [
      { date: "2026-09-29", consensus: 45.0, lastFill: 40.0, forecasters: 2, analysed: 2, carried: 0, changes: [], firstChecked: 2 },
      { date: "2026-09-30", consensus: 45.0, lastFill: 41.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-10-01", consensus: 43.2, lastFill: 41.5, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/freight-rate-bulletin", since: "2026-09-30T15:10:00Z", observedAt: "2026-10-01T15:44:00Z", summary: "The rate bulletin lists lower fuel surcharges than the page checked the day before.", moves: [{ agent: "forecaster-a", from: 49.0, to: 46.0 }, { agent: "forecaster-b", from: 41.0, to: 39.0 }], snapshot: "0x31de…08b2" }], firstChecked: 0 },
      { date: "2026-10-02", consensus: 43.2, lastFill: 39.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-10-03", consensus: 43.2, lastFill: 38.5, forecasters: 2, analysed: 1, carried: 1, changes: [], firstChecked: 0 },
      { date: "2026-10-04", consensus: 41.2, lastFill: 37.0, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/q2-release", since: "2026-10-02T09:00:00Z", observedAt: "2026-10-04T15:36:00Z", summary: "The release page corrected a typo in the Q2 operating cost table.", moves: [{ agent: "forecaster-a", from: 46.0, to: 45.0 }, { agent: "forecaster-b", from: 39.0, to: 37.0 }], snapshot: "0xc9a0…5e17" }], firstChecked: 0 },
      { date: "2026-10-05", consensus: 41.2, lastFill: 37.5, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
    ],
    evidence: [
      { title: "FY2025 Q2 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-27", source: src, digest: "a07d…12fc" },
    ],
    reasoning: [
      { agent: "forecaster-a", probability: 45, summary: "The sample Q2 release shows a 34% gross margin, below the 35% threshold." },
      { agent: "forecaster-b", probability: 37, summary: "The sample release also indicates freight costs could ease, raising the margin." },
    ],
  },
  {
    id: "sample-03", mode: "REPLAY", entity: "Marrow & Vale Textiles", fiscalPeriod: "FY2025Q2", thresholdBps: 5200, forecastBps: 7810, updatedAt: "2026-09-30", state: "PROPOSED", outcome: null,
    periodStart: "2025-04-01", periodEnd: "2025-06-30", closeAt: "2026-09-24T16:00:00Z", proposalDeadline: "2026-10-01T16:00:00Z", hardDeadline: "2026-10-04T16:00:00Z",
    windows: [
      { date: "2026-09-17", consensus: 69.0, lastFill: 62.0, forecasters: 2, analysed: 2, carried: 0, changes: [], firstChecked: 2 },
      { date: "2026-09-18", consensus: 70.8, lastFill: 63.0, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/filing-calendar", since: "2026-09-17T15:05:00Z", observedAt: "2026-09-18T15:40:00Z", summary: "The filing calendar moved the Q2 release date earlier by one week.", moves: [{ agent: "forecaster-a", from: 71.0, to: 74.0 }, { agent: "forecaster-b", from: 67.0, to: 68.0 }], snapshot: "0x52f8…a1d3" }], firstChecked: 0 },
      { date: "2026-09-19", consensus: 70.8, lastFill: 66.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-20", consensus: 70.8, lastFill: 67.5, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-21", consensus: 70.8, lastFill: 69.0, forecasters: 2, analysed: 1, carried: 1, changes: [], firstChecked: 0 },
      { date: "2026-09-22", consensus: 70.8, lastFill: 70.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-23", consensus: 78.1, lastFill: 71.0, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/q2-release", since: "2026-09-21T09:00:00Z", observedAt: "2026-09-23T15:33:00Z", summary: "A preview of the Q2 release gives a 50% gross margin, below the 52% threshold.", moves: [{ agent: "forecaster-a", from: 74.0, to: 80.0 }, { agent: "forecaster-b", from: 68.0, to: 76.0 }], snapshot: null }], firstChecked: 0 },
      { date: "2026-09-24", consensus: 78.1, lastFill: 72.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
    ],
    evidence: [
      { title: "FY2025 Q2 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-25", source: src, digest: "e4b2…70a1" },
      { title: "Proposed outcome capture, excerpt (sample)", visibility: "EXCERPT", capturedAt: "2026-09-29", source: src, digest: "03cd…9f58" },
    ],
    reasoning: [
      { agent: "forecaster-a", probability: 80, summary: "The sample Q2 release reports a 50% gross margin, below the 52% threshold." },
      { agent: "forecaster-b", probability: 76, summary: "The sample outcome excerpt also points to a margin below the threshold." },
    ],
  },
  {
    id: "sample-04", mode: "REPLAY", entity: "Tidewell Instruments", fiscalPeriod: "FY2025Q2", thresholdBps: 6100, forecastBps: 3350, updatedAt: "2026-09-28", state: "DISPUTED", outcome: null,
    periodStart: "2025-04-01", periodEnd: "2025-06-30", closeAt: "2026-09-20T16:00:00Z", proposalDeadline: "2026-09-27T16:00:00Z", hardDeadline: "2026-09-30T16:00:00Z",
    windows: [
      { date: "2026-09-13", consensus: 43.0, lastFill: 48.0, forecasters: 2, analysed: 2, carried: 0, changes: [], firstChecked: 2 },
      { date: "2026-09-14", consensus: 43.0, lastFill: 47.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-15", consensus: 37.2, lastFill: 45.0, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/q2-release", since: "2026-09-14T15:12:00Z", observedAt: "2026-09-15T15:42:00Z", summary: "The release page shows a 62% gross margin, above the 61% threshold.", moves: [{ agent: "forecaster-a", from: 45.0, to: 39.0 }, { agent: "forecaster-b", from: 41.0, to: 35.0 }], snapshot: "0x8e04…77bc" }], firstChecked: 0 },
      { date: "2026-09-16", consensus: 37.2, lastFill: 44.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-17", consensus: 37.2, lastFill: 42.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-18", consensus: 37.2, lastFill: 41.0, forecasters: 2, analysed: 1, carried: 1, changes: [], firstChecked: 0 },
      { date: "2026-09-19", consensus: 37.2, lastFill: 40.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-20", consensus: 33.5, lastFill: 40.5, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/margin-restatement", since: "2026-09-18T11:30:00Z", observedAt: "2026-09-20T15:37:00Z", summary: "A restatement notice cites a 63% margin for the quarter.", moves: [{ agent: "forecaster-a", from: 39.0, to: 36.0 }, { agent: "forecaster-b", from: 35.0, to: 31.0 }], snapshot: "0xd2b6…3f90" }], firstChecked: 0 },
    ],
    evidence: [
      { title: "FY2025 Q2 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-21", source: src, digest: "7d90…c2e6" },
      { title: "Challenger filing, excerpt (sample)", visibility: "EXCERPT", capturedAt: "2026-09-28", source: src, digest: "b8f3…1a4d" },
    ],
    reasoning: [
      { agent: "forecaster-a", probability: 36, summary: "The sample Q2 release reports a 62% margin, just above the 61% threshold." },
      { agent: "forecaster-b", probability: 31, summary: "The sample challenger filing cites a 63% margin, above the threshold." },
    ],
  },
  {
    id: "sample-05", mode: "REPLAY", entity: "Quillon Grain Cooperative", fiscalPeriod: "FY2025Q1", thresholdBps: 2800, forecastBps: 1890, updatedAt: "2026-09-21", state: "FINAL", outcome: "NO",
    periodStart: "2025-01-01", periodEnd: "2025-03-31", closeAt: "2026-09-08T16:00:00Z", proposalDeadline: "2026-09-15T16:00:00Z", hardDeadline: "2026-09-18T16:00:00Z",
    windows: [
      { date: "2026-09-01", consensus: 23.0, lastFill: 26.0, forecasters: 2, analysed: 2, carried: 0, changes: [], firstChecked: 2 },
      { date: "2026-09-02", consensus: 23.0, lastFill: 25.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-03", consensus: 23.0, lastFill: 24.5, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-04", consensus: 18.9, lastFill: 23.0, forecasters: 2, analysed: 2, carried: 0, changes: [{ source: "https://example.com/fixture-only/q1-release", since: "2026-09-03T15:08:00Z", observedAt: "2026-09-04T15:39:00Z", summary: "The release page lists a 30% gross margin for Q1, above the 28% threshold.", moves: [{ agent: "forecaster-a", from: 25.0, to: 21.0 }, { agent: "forecaster-b", from: 21.0, to: 17.0 }], snapshot: "0x6b17…e2a4" }], firstChecked: 0 },
      { date: "2026-09-05", consensus: 18.9, lastFill: 22.5, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-06", consensus: 18.9, lastFill: 22.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-07", consensus: 18.9, lastFill: 21.0, forecasters: 2, analysed: 1, carried: 1, changes: [], firstChecked: 0 },
      { date: "2026-09-08", consensus: 18.9, lastFill: 21.5, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
    ],
    evidence: [
      { title: "FY2025 Q1 results release (sample)", visibility: "PUBLIC", capturedAt: "2026-09-09", source: src, digest: "f12b…6c39" },
      { title: "Resolution capture, excerpt (sample)", visibility: "EXCERPT", capturedAt: "2026-09-15", source: src, digest: "44d7…a0e2" },
    ],
    reasoning: [
      { agent: "forecaster-a", probability: 21, summary: "The sample Q1 release reports a 30% margin, above the 28% threshold." },
      { agent: "forecaster-b", probability: 17, summary: "The sample resolution excerpt likewise places the margin above the threshold." },
    ],
  },
  {
    id: "sample-06", mode: "REPLAY", entity: "Harlow Fen Robotics", fiscalPeriod: "FY2025Q1", thresholdBps: 4500, forecastBps: 5000, updatedAt: "2026-09-19", state: "FINAL", outcome: "INVALID",
    periodStart: "2025-01-01", periodEnd: "2025-03-31", closeAt: "2026-09-05T16:00:00Z", proposalDeadline: "2026-09-12T16:00:00Z", hardDeadline: "2026-09-15T16:00:00Z",
    windows: [
      { date: "2026-08-29", consensus: 50.0, lastFill: 50.0, forecasters: 2, analysed: 2, carried: 0, changes: [], firstChecked: 1 },
      { date: "2026-08-30", consensus: 50.0, lastFill: 49.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-08-31", consensus: 50.0, lastFill: 51.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-01", consensus: 50.0, lastFill: 50.5, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-02", consensus: 50.0, lastFill: 49.5, forecasters: 2, analysed: 1, carried: 1, changes: [], firstChecked: 0 },
      { date: "2026-09-03", consensus: 50.0, lastFill: 50.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-04", consensus: 50.0, lastFill: 50.5, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
      { date: "2026-09-05", consensus: 50.0, lastFill: 50.0, forecasters: 2, analysed: 0, carried: 2, changes: [], firstChecked: 0 },
    ],
    evidence: [
      { title: "FY2025 Q1 source search, no release found (sample)", visibility: "PUBLIC", capturedAt: "2026-09-13", source: src, digest: "d3a8…05bf" },
    ],
    reasoning: [
      { agent: "forecaster-a", probability: 51, summary: "The sample source search found no Q1 release containing a gross margin." },
      { agent: "forecaster-b", probability: 49, summary: "The missing sample release leaves the margin relative to 45% uncertain." },
    ],
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

export function consensusForecast(w: Pick<ForecastWindow, "consensus">): number {
  return w.consensus;
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

/** Y-axis band: floor(min-5) to ceil(max+5), rounded outward to 10s and clamped to 0-100. */
export function yAxisBounds(windows: readonly ForecastWindow[]): { lo: number; hi: number; ticks: number[] } {
  const all = windows.flatMap((w) => w.lastFill === null ? [w.consensus] : [w.consensus, w.lastFill]);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 5) / 10) * 10);
  const hi = Math.min(100, Math.ceil((Math.max(...all) + 5) / 10) * 10);
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += 10) ticks.push(v);
  return { lo, hi, ticks };
}

export function chartAriaLabel(windows: readonly ForecastWindow[]): string {
  const first = windows[0];
  const last = windows[windows.length - 1];
  if (!first || !last) return "Line chart of consensus and last fill (no data).";
  const changed = windows.filter((w) => w.changes.length > 0).length;
  return `Line chart of the probability of YES from ${first.date} to ${last.date}: consensus moves from ${first.consensus.toFixed(1)}% to ${last.consensus.toFixed(1)}%, with last fill shown. Sources changed (reported) in ${changed} of ${windows.length} windows.`;
}

/** Daily forecast windows close at 16:00 UTC; this is a window's deadline (unix seconds). */
export function windowScheduledAt(date: string): number {
  return isoToUnix(`${date}T16:00:00Z`);
}

/** "2026-10-06T15:38:00Z" -> unix seconds. */
export function isoToUnix(iso: string): number {
  const ms = Date.parse(iso);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso) || Number.isNaN(ms)) throw new Error(`not an ISO UTC string: ${iso}`);
  return ms / 1000;
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
      ? `no proposer bond by ${formatUtcDate(m.proposalDeadline)}`
      : `proposer posts a bond by ${formatUtcDate(m.proposalDeadline)}; challenge window (REPLAY parameters)`,
    disputed: "a challenger raised a dispute; jurors vote by commit and reveal",
    final: timedOut
      ? `keeper can finalize INVALID at ${formatUtcDate(m.hardDeadline)}`
      : m.state === "FINAL"
        ? `${m.outcome} is final`
        : `keeper can finalize INVALID if not final by ${formatUtcDate(m.hardDeadline)}`,
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
    return m.outcome === "INVALID" ? "No qualifying value; finalized INVALID after the hard deadline" : `Resolved ${m.outcome}`;
  }
  return `Closed ${formatUtc(m.closeAt)}`;
}

/** Rule sentence split around the two emphasised phrases. */
export function resolutionRule(m: SampleMarket): [string, string, string, string, string] {
  const th = formatBpsPercent(m.thresholdBps, 2);
  return [
    "YES if the ",
    "first qualifying release",
    ` of ${possessive(m.entity)} ${formatPeriod(m.fiscalPeriod)} GAAP reported gross margin is below ${th}. NO if it is ${th} or higher. A proposer can propose only YES or NO. If no result is final by the hard deadline, for example because no qualifying value was published, a keeper can finalize the market as `,
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
  };
}
