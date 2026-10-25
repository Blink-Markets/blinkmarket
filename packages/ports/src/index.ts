export type * from "./identity.js";
export * from "./jobs.js";
export * from "./source-fetcher.js";
export * from "./chain-index.js";
export type * from "./protocol-read.js";
export * from "./content.js";
export * from "./signature.js";

// 邊界合約：實作留到後續 milestone；不公開 ORM 或私鑰。
export interface ImmutableObjectStore {
  putIfAbsent(bytes: Uint8Array, contentHash: string): Promise<{ uri: string }>;
  read(uri: string): Promise<Uint8Array>;
}
export interface SpecArchive {
  /** The stored bytes, accepted only if keccak256(bytes) is `hash`. */
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
