import type { Weight } from "@blink/domain";
import type { ForecasterStats } from "./forecasts.js";

export interface EvaluationForecast {
  /** Lowercase wallet address. */
  forecaster: string;
  probabilityBps: number;
  withdrawn: boolean;
}
export interface EvaluationWindow {
  windowId: string;
  deploymentId: string;
  marketId: string;
  mode: "LIVE" | "REPLAY";
  outcome: "YES" | "NO" | "INVALID";
  /** The window's deadline in unix seconds. */
  deadline: number;
  /** A proposal existed at or before the deadline. */
  contaminated: boolean;
  forecasts: EvaluationForecast[];
  /** Credit weight per forecaster, frozen as of the deadline. */
  weights: Record<string, Weight>;
}
export interface ScoreEntry {
  windowId: string;
  deploymentId: string;
  marketId: string;
  mode: "LIVE" | "REPLAY";
  outcome: "YES" | "NO" | "INVALID";
  scorer: "AGENT" | "CONSENSUS";
  /** The scored wallet; null for the consensus. */
  forecaster: string | null;
  probabilityMillionthsTimes2: number | null;
  brier: string | null;
  missing: boolean;
  contaminated: boolean;
  evaluationVersion: string;
}
export interface UnscoredWindow {
  windowId: string;
  deadline: Date;
  forecasts: EvaluationForecast[];
}
/** The score store of one protocol deployment. The market state and outcome come from the ProtocolReader. */
export interface EvaluationStore {
  /** Windows of a market past their deadline that have answers but no scores of the current version. */
  unscoredWindows(marketId: string): Promise<UnscoredWindow[]>;
  creditStats(
    forecasters: string[],
    at: Date,
  ): Promise<ForecasterStats[]>;
  /** One window's entries, atomically; entries that exist already are left alone. */
  saveScores(entries: ScoreEntry[]): Promise<void>;
}

export interface EvaluationMetrics {
  eventCount: string;
  missingCount: string;
  invalidCount: string;
  brier: number | null;
  consensusBrier: number | null;
}
export interface MetricsReader {
  metrics(mode: "LIVE" | "REPLAY"): Promise<EvaluationMetrics>;
}
