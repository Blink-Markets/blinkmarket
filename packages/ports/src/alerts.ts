/** Stable across retries. Receivers should deduplicate on dedupeKey. */
export interface Alert {
  dedupeKey: string;
  type: string;
  deadline?: string;
  thresholdSeconds?: number;
  marketId?: string;
  mode?: "LIVE" | "REPLAY";
  kind?: "HARD_DEADLINE" | "CHALLENGE_END";
}

/** Resolves only after the destination accepts the alert; rejects on failure. */
export interface AlertSink {
  deliver(alert: Alert, signal: AbortSignal): Promise<void>;
}
