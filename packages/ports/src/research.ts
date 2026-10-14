import type { PlatformRole } from "@blink/domain";
// Re-exported for adapters, which may import only schemas and ports.
export type { PlatformRole } from "@blink/domain";

// Platform agents call the public API like any external agent; @blink/client
// satisfies these structurally, so application code never imports it. Its
// responses are already validated against the contract; application code reads
// the parts it needs through the schemas in @blink/schemas (CandidateCreated,
// MarketView, SubmissionReceipt).
export interface DiscoveryApi {
  createCandidate(
    input: {
      templateId: "GM_LT_V1";
      entityId: string;
      fiscalPeriod: string;
      thresholdBps: number;
      evidenceIds: string[];
      thesis: string;
    },
    idempotencyKey: string,
  ): Promise<unknown>;
}
export interface ForecastApi {
  getMarket(ref: {
    deploymentId: string;
    marketId: string;
    mode: "LIVE" | "REPLAY";
  }): Promise<unknown>;
  submitForecast(
    ref: { deploymentId: string; marketId: string },
    input: {
      horizonKey: { horizonType: "DAILY" | "PRE_CLOSE"; scheduledAt: string };
      probability: number;
      evidenceIds: string[];
      rationale: string;
      agentVersion: string;
    },
    idempotencyKey: string,
  ): Promise<unknown>;
}

export type ScanState =
  | "STARTED"
  | "CANDIDATE_CREATED"
  | "NO_CANDIDATE"
  | "MANUAL_REVIEW"
  | "FAILED"
  | "SKIPPED_DAILY_CAP";
/** The model's validated candidate proposal; everything else in the request comes from the run. */
export interface ScanAnswer {
  entityId: string;
  fiscalPeriod: string;
  thresholdBps: number;
  thesis: string;
}
export interface ScanRun {
  id: string;
  state: ScanState;
  evidenceId: string | null;
  /** Stored with the day's slot, before the API is called; a redelivery replays it. */
  answer: ScanAnswer | null;
}
export interface EvidenceDocument {
  evidenceId: string;
  objectUri: string;
  /** keccak256 of the archived bytes, 0x-prefixed. */
  contentHash: string;
}
// Runs as blink_worker: scan bookkeeping plus the evidence reads discovery needs.
export interface DiscoveryStore {
  /** The database business clock. */
  now(): Promise<Date>;
  /** Sources that are allow-listed and fetch-enabled. */
  fetchableSources(): Promise<string[]>;
  /** Creates the run for (source, UTC day, slot) or returns the existing one. */
  startRun(input: {
    sourceId: string;
    day: string;
    slot: 0 | 1;
  }): Promise<ScanRun>;
  recordEvidence(runId: string, evidenceId: string): Promise<void>;
  /** The evidence record a SUCCEEDED fetch attempt made for this job id. */
  fetchedEvidence(jobId: string): Promise<string | null>;
  newestEvidence(sourceId: string, day: string): Promise<string | null>;
  evidence(evidenceId: string): Promise<EvidenceDocument | null>;
  /** Counts one model call against the run; null once two have been started. */
  beginModelAttempt(runId: string): Promise<number | null>;
  /**
   * Takes one of the day's candidate slots and stores the answer with it, in one
   * transaction. ALREADY: this run holds one from an earlier delivery. CAP: none left.
   */
  takeSlot(
    runId: string,
    answer: ScanAnswer,
  ): Promise<"TAKEN" | "ALREADY" | "CAP">;
  /**
   * Ends a STARTED run. Any end but CANDIDATE_CREATED returns its slot, unless
   * `keepSlot`: the outcome is unknown (a candidate may exist), so it stays counted.
   */
  finish(
    runId: string,
    outcome: {
      state: Exclude<ScanState, "STARTED">;
      candidateId?: string;
      errorCode?: string;
      /** The audit action to record, for outcomes a person must look at. */
      audit?: string;
      keepSlot?: boolean;
    },
  ): Promise<void>;
}

export interface PlatformAgentRecord {
  agentId: string;
  model: string;
  /** keccak256 of the prompt template, 0x-prefixed. */
  promptHash: string;
}
export interface WindowContext {
  windowId: string;
  deploymentId: string;
  marketId: string;
  mode: "LIVE" | "REPLAY";
  horizonType: "DAILY" | "PRE_CLOSE";
  scheduledAt: Date;
  openAt: Date;
  deadline: Date;
  /** The database business clock when the window was read. */
  now: Date;
  /** The approval of this market's spec: its candidate and research budget. */
  approval: { candidateId: string; budgetMicros: bigint } | null;
}
export type ModelRunState =
  "STARTED" | "SUBMITTED" | "LATE" | "SCHEMA_INVALID" | "FAILED";
/** A model's validated forecast, kept until its submission is settled. */
export interface ForecastAnswer {
  probability: number;
  rationale: string;
  evidenceIds: string[];
}
// Runs as blink_worker, which cannot read forecasts.submissions or snapshots.
export interface PlatformRunStore {
  platformAgent(role: PlatformRole): Promise<PlatformAgentRecord | null>;
  window(windowId: string): Promise<WindowContext | null>;
  /** Windows that are open by the database clock, in markets that are OPEN. */
  openWindows(): Promise<string[]>;
  /** True when this agent already has a SUBMITTED or LATE run for the window. */
  settled(agentId: string, windowId: string): Promise<boolean>;
  /** Evidence among `ids` observed at or before `cutoff`, oldest first. */
  evidence(ids: string[], cutoff: Date): Promise<EvidenceDocument[]>;
  startRun(input: {
    id: string;
    agentId: string;
    windowId: string;
    purpose: "FORECAST" | "BASELINE";
    model: string;
    promptHash: string;
    sampling: Record<string, unknown>;
    toolPolicy: string;
    inputHash: string;
    dataCutoff: Date;
  }): Promise<void>;
  /**
   * Stores the run's validated answer with its provenance, before it is submitted. The run
   * stays STARTED; a retry finds it with `pendingAnswer` and submits it again under the same key.
   */
  recordAnswer(
    runId: string,
    answer: ForecastAnswer,
    provenance: { reservationId: string; providerRequestId: string },
  ): Promise<void>;
  /** The agent's unsettled run for the window that already holds an answer, if any. */
  pendingAnswer(
    agentId: string,
    windowId: string,
  ): Promise<{ runId: string; answer: ForecastAnswer } | null>;
  /** Ends a run; the stored answer, if any, goes with it. */
  updateRun(
    id: string,
    update: {
      state: Exclude<ModelRunState, "STARTED">;
      reservationId?: string;
      providerRequestId?: string;
      submissionId?: string;
    },
  ): Promise<void>;
}
