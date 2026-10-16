// Adapters may not import @blink/domain: the gas-cap codes and the keeper due rule come through here.
export { checkGasCaps, keeperDueSince } from "@blink/domain";

export const ALERT_FAMILIES = [
  "budget",
  "pause",
  "rpc",
  "indexer_lag",
  "keeper_overdue",
  "jobs_dead",
] as const;
export type AlertFamily = (typeof ALERT_FAMILIES)[number];
export type AlertState = "OPEN" | "STILL_OPEN" | "CLEARED";

/** The only detail an alert may carry besides its codes: numbers (as digit strings) and job types. */
export interface AlertFields {
  blockNumber?: string;
  headNumber?: string;
  count?: string;
  overdueSeconds?: string;
  failures?: string;
  jobTypes?: string[];
}

/** A condition that is true right now. Conditions that are not true are simply not observed. */
export interface AlertObservation {
  family: AlertFamily;
  /** `^[a-z_]{1,32}(:[a-z0-9_]{1,78})?$`: no free text, e.g. `global`, `market:7`, `role:maker`. */
  subject: string;
  /** `^[A-Z0-9_]{1,64}$` */
  reason: string;
  fields?: AlertFields;
}

export interface AlertEpisode {
  family: AlertFamily;
  subject: string;
  active: boolean;
  reason: string | null;
  openedAt: Date | null;
  lastAlertAt: Date | null;
  consecutiveFailures: number;
}

/** The next stored state of one episode, and the alert (if any) that goes out with it. */
export interface EpisodeChange extends AlertEpisode {
  emit?: { state: AlertState; fields?: AlertFields | undefined };
}

export interface AlertEvaluateStore {
  /** Enabled deployments, used when none is configured. */
  deployments(): Promise<string[]>;
  /** Every SQL-observable condition that holds now for the deployment. */
  observe(
    deploymentId: string,
    options: { keeperOverdueSeconds: number },
  ): Promise<AlertObservation[]>;
  /**
   * Under a per-deployment lock: reads the episodes of `families`, applies `decide`, then writes
   * the new episodes and one outbox alert per emission in a single transaction.
   */
  transition(
    deploymentId: string,
    families: readonly AlertFamily[],
    decide: (input: { episodes: AlertEpisode[]; now: Date }) => EpisodeChange[],
  ): Promise<EpisodeChange[]>;
}

export type RpcProbeResult = { ok: true } | { ok: false; reason: string };
export interface RpcProbe {
  /** Never throws: any failure is a result with a fixed reason code. */
  probe(signal: AbortSignal): Promise<RpcProbeResult>;
}
