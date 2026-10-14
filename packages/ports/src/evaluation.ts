export interface EvaluationForecast {
  agentId: string;
  role: "FORECASTER_A" | "FORECASTER_B" | "BASELINE" | null;
  probabilityMillionths: number;
  withdrawn: boolean;
  contaminated: boolean;
}
export interface EvaluationWindow {
  windowId: string;
  deploymentId: string;
  marketId: string;
  mode: "LIVE" | "REPLAY";
  outcome: "YES" | "NO" | "INVALID";
  forecasts: EvaluationForecast[];
}
export interface ScoreEntry extends Omit<EvaluationWindow, "forecasts"> {
  scorer: "ENSEMBLE" | "BASELINE" | "AGENT";
  agentId: string | null;
  probabilityMillionthsTimes2: number | null;
  brier: string | null;
  missing: boolean;
  contaminated: boolean;
  evaluationVersion: string;
}
export interface EvaluationStore {
  scoreFinalWindows(
    score: (window: EvaluationWindow) => ScoreEntry[],
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface EvaluationMetrics {
  eventCount: string;
  missingCount: string;
  invalidCount: string;
  brier: number | null;
}
export interface MetricsReader {
  metrics(mode: "LIVE" | "REPLAY"): Promise<EvaluationMetrics>;
}
