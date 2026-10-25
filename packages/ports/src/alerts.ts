import type { AlertFamily, AlertState } from "./alert-evaluate.js";

/** Stable across retries. Receivers should deduplicate on dedupeKey. */
export interface Alert {
  dedupeKey: string;
  type: string;
  deadline?: string;
  thresholdSeconds?: number;
  marketId?: string;
  deploymentId?: string;
  /** Set when the source event payload was not a JSON object. */
  marker?: "PAYLOAD_INVALID";
  mode?: "LIVE" | "REPLAY";
  kind?: "HARD_DEADLINE" | "CHALLENGE_END";
  /** Episode alerts (alert.evaluate): family, state and what the condition is about. */
  family?: AlertFamily;
  state?: AlertState;
  /** Only set for conditions the platform cannot act on (fees_undistributed); absent means an incident. */
  severity?: "info";
  subject?: string;
  reason?: string;
  /** Epoch seconds (digits) at which the episode opened. */
  since?: string;
  blockNumber?: string;
  headNumber?: string;
  count?: string;
  overdueSeconds?: string;
  failures?: string;
  jobTypes?: string[];
  truncated?: true;
}

/** Resolves only after the destination accepts the alert; rejects on failure. */
export interface AlertSink {
  deliver(alert: Alert, signal: AbortSignal): Promise<void>;
}
