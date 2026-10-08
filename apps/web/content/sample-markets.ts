// Sample REPLAY markets for the read-only showcase. Companies are fictional and
// follow the GM_LT_V1 template; these are not live markets or forecast records.
export type MarketState = "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL";
export type Outcome = "YES" | "NO" | "INVALID";

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
};

export const sampleMarkets: readonly SampleMarket[] = [
  { id: "sample-01", mode: "REPLAY", entity: "Ostrander Kiln Works", fiscalPeriod: "FY2025Q3", thresholdBps: 7000, forecastBps: 6240, updatedAt: "2026-10-06", state: "OPEN", outcome: null },
  { id: "sample-02", mode: "REPLAY", entity: "Pellbrook Freight Lines", fiscalPeriod: "FY2025Q3", thresholdBps: 3500, forecastBps: 4120, updatedAt: "2026-10-05", state: "OPEN", outcome: null },
  { id: "sample-03", mode: "REPLAY", entity: "Marrow & Vale Textiles", fiscalPeriod: "FY2025Q2", thresholdBps: 5200, forecastBps: 7810, updatedAt: "2026-09-30", state: "PROPOSED", outcome: null },
  { id: "sample-04", mode: "REPLAY", entity: "Tidewell Instruments", fiscalPeriod: "FY2025Q2", thresholdBps: 6100, forecastBps: 3350, updatedAt: "2026-09-28", state: "DISPUTED", outcome: null },
  { id: "sample-05", mode: "REPLAY", entity: "Quillon Grain Cooperative", fiscalPeriod: "FY2025Q1", thresholdBps: 2800, forecastBps: 1890, updatedAt: "2026-09-21", state: "FINAL", outcome: "NO" },
  { id: "sample-06", mode: "REPLAY", entity: "Harlow Fen Robotics", fiscalPeriod: "FY2025Q1", thresholdBps: 4500, forecastBps: 5000, updatedAt: "2026-09-19", state: "FINAL", outcome: "INVALID" },
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
