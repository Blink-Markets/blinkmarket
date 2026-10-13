import type { ModelRate } from "@blink/domain";
// Re-exported for adapters, which may import only schemas and ports.
export {
  ModelCallError,
  usageCostUsdMicros,
  type ModelCallErrorKind,
  type ModelRate,
} from "@blink/domain";

type Usage = {
  capUsdMicros: bigint;
  spentUsdMicros: bigint;
  reservedUsdMicros: bigint;
  unknownUsdMicros: bigint;
};

// USD micros ledger (spec 12.5). Every method throws JobError; reserve throws
// BUDGET_EXHAUSTED or BUDGET_GATE_CLOSED (both non-retryable).
export interface BudgetLedger {
  reserve(input: {
    runId: string;
    questionKey: string;
    questionCapUsdMicros: bigint;
    provider: string;
    model: string;
    maxUsdMicros: bigint;
    jobId?: string;
  }): Promise<{ reservationId: string }>;
  markUnknown(
    reservationId: string,
    providerRequestId: string | null,
  ): Promise<void>;
  reconcile(
    reservationId: string,
    actualUsdMicros: bigint,
    providerRequestId: string,
  ): Promise<{ overrun: boolean }>;
  // Only for requests that were definitely not sent.
  release(reservationId: string): Promise<void>;
  daySummary(day?: string): Promise<{ day: string } & Usage>;
  questionSummary(questionKey: string): Promise<Usage | null>;
  totals(): Promise<Omit<Usage, "capUsdMicros">>;
}

export interface ModelCallRequest {
  runId: string;
  model: string;
  promptHash: string;
  system: string;
  input: string;
  maxOutputTokens: number;
  reservationId: string;
  signal?: AbortSignal;
}
export interface ModelCallResult {
  output: string;
  providerRequestId: string;
  actualUsdMicros: bigint | null;
}
// call() throws ModelCallError; `rate` null means the model has no price and must not be called.
export interface ModelGateway {
  readonly provider: string;
  rate(model: string): ModelRate | null;
  call(request: ModelCallRequest): Promise<ModelCallResult>;
}
