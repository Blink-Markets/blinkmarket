import { computeFreshness, type FreshnessView, type WindowSummary } from "@blink/schemas";
import { isoToUnix, windowScheduledAt, type SampleMarket } from "./sample-markets.ts";

// The freshness of an OPEN sample market, computed with the same function a live reader uses.
// Only the market page and the tests import this file, so @blink/schemas and zod stay out of the
// chart's client bundle (ForecastChart.tsx imports values from sample-markets.ts).

/** The sample windows as the reader's window summaries (every answer has a readable note). */
export function sampleWindowSummaries(m: SampleMarket): WindowSummary[] {
  return m.windows.map((w) => ({
    scheduledAt: windowScheduledAt(w.date),
    answers: w.forecasters,
    analysed: w.analysed,
    carried: w.carried,
    noNote: 0,
    unfetched: 0,
    evidence: w.changes
      .map((c) => ({ url: c.source, since: isoToUnix(c.since), observedAt: isoToUnix(c.observedAt), witnesses: w.analysed }))
      .sort((a, b) => b.observedAt - a.observedAt),
    firstChecked: w.firstChecked,
  }));
}

/** Null for a market that is not OPEN: forecasting ended at close, so there is no level to show. */
export function sampleFreshness(m: SampleMarket): FreshnessView | null {
  if (m.state !== "OPEN") return null;
  return computeFreshness(sampleWindowSummaries(m), isoToUnix(`${m.updatedAt}T23:59:59Z`));
}
