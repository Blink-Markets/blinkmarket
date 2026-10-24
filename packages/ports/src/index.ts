import type { NewMarketSpec } from "@blink/schemas";
export type * from "./identity.js";
export type * from "./preparation.js";
export type * from "./approval.js";
export type * from "./creation-tracker.js";
export * from "./jobs.js";
export * from "./budgets.js";
export * from "./evidence-fetch.js";
export type * from "./chain-index.js";
export * from "./research.js";
export type * from "./protocol-read.js";
export * from "./signature.js";

// 邊界合約：實作留到後續 milestone；不公開 ORM 或私鑰。
export interface ImmutableObjectStore {
  putIfAbsent(bytes: Uint8Array, contentHash: string): Promise<{ uri: string }>;
  read(uri: string): Promise<Uint8Array>;
}
export interface SpecArchive {
  freeze(
    spec: NewMarketSpec,
    nowSeconds: bigint,
  ): Promise<{ hash: string; uri: string; bytes: Uint8Array }>;
  read(uri: string, hash: string): Promise<Uint8Array>;
}
declare const transactionBrand: unique symbol;
export interface TransactionContext {
  readonly [transactionBrand]: true;
}
export interface UnitOfWork {
  run<T>(
    work: (tx: TransactionContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
export * from "./forecasts.js";

export type * from "./market-read.js";
export * from "./evaluation.js";

export * from "./resolution.js";

export * from "./health.js";

export * from "./operator-status.js";
export type { Alert, AlertSink } from "./alerts.js";
export {
  ALERT_FAMILIES,
  ALERT_SCOPE_FAMILIES,
  GLOBAL_ALERT_SCOPE,
} from "./alert-evaluate.js";
export type {
  AlertFamily,
  AlertState,
  AlertFields,
  AlertObservation,
  AlertObserved,
  AlertEpisode,
  EpisodeChange,
  AlertEvaluateStore,
  RpcProbe,
  RpcProbeResult,
} from "./alert-evaluate.js";
export type * from "./tx-tracking.ts";
