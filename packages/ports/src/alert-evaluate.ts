export const ALERT_FAMILIES = [
  "budget",
  "pause",
  "rpc",
  "indexer_lag",
  "jobs_dead",
] as const;
export type AlertFamily = (typeof ALERT_FAMILIES)[number];
/** Conditions with no deployment column (budget gates, jobs, the RPC) live under this one scope. */
export const GLOBAL_ALERT_SCOPE = "*";
export const ALERT_SCOPE_FAMILIES = {
  global: ["budget", "jobs_dead", "rpc"],
  deployment: ["pause", "indexer_lag"],
} as const satisfies Record<string, readonly AlertFamily[]>;
export type AlertState = "OPEN" | "STILL_OPEN" | "CLEARED";

/** The only detail an alert may carry besides its codes: numbers (as digit strings) and job types. */
export interface AlertFields {
  blockNumber?: string;
  headNumber?: string;
  count?: string;
  failures?: string;
  jobTypes?: string[];
  /** The family hit its subject bound: only the first subjects are reported and none is cleared. */
  truncated?: true;
}

/** A condition that is true right now. Conditions that are not true are simply not observed. */
export interface AlertObservation {
  family: AlertFamily;
  /** `^[a-z_]{1,32}(:[a-z0-9_]{1,78})?$`: no free text, e.g. `global`, `market:7`, `role:maker`. */
  subject: string;
  /** `^[A-Z0-9_]{1,64}$` */
  reason: string;
  fields?: AlertFields;
  /**
   * A count that only grows an incident (DEAD jobs, closed question gates): re-announced at once
   * when `fields.count` grows, never on the hourly heartbeat.
   */
  monotonic?: boolean;
}

/** What one scope's sources said. A family in `unknown` could not be judged and must not transition. */
export interface AlertObserved {
  observations: AlertObservation[];
  /** Subjects of a family that could not be judged; `covers` says which. */
  unknown: { family: AlertFamily; covers(subject: string): boolean }[];
  truncated: AlertFamily[];
}

export interface AlertEpisode {
  family: AlertFamily;
  subject: string;
  active: boolean;
  reason: string | null;
  openedAt: Date | null;
  lastAlertAt: Date | null;
  consecutiveFailures: number;
  /** The count last announced for a monotonic episode. */
  lastCount: number;
}

/** The next stored state of one episode, and the alert (if any) that goes out with it. */
export interface EpisodeChange extends AlertEpisode {
  emit?: { state: AlertState; fields?: AlertFields | undefined };
}

export interface AlertEvaluateStore {
  /**
   * A job-level lock so two evaluators never overlap. Null when another evaluator holds it; the
   * holder releases it when the tick ends (a crashed holder's lock goes with its connection).
   */
  tryLock(): Promise<{ release(): Promise<void> } | null>;
  /** Enabled deployments, used when none is configured. */
  deployments(): Promise<string[]>;
  /**
   * Every condition that holds now in the scope (a deployment id, or GLOBAL_ALERT_SCOPE). Each family
   * is read and bounded on its own; one that fails is reported as unknown, not as healthy.
   */
  observe(scope: string): Promise<AlertObserved>;
  /**
   * Under a per-scope lock: reads the active episodes, the rpc streak and the episodes of the
   * subjects observed now, applies `decide`, writes the new episodes and one outbox alert per
   * emission in a single transaction, and prunes long-inactive episodes.
   */
  transition(
    scope: string,
    families: readonly AlertFamily[],
    observed: readonly { family: AlertFamily; subject: string }[],
    decide: (input: { episodes: AlertEpisode[]; now: Date }) => EpisodeChange[],
  ): Promise<EpisodeChange[]>;
}

export type RpcProbeResult = { ok: true } | { ok: false; reason: string };
export interface RpcProbe {
  /** Never throws: any failure is a result with a fixed reason code. */
  probe(signal: AbortSignal): Promise<RpcProbeResult>;
}
