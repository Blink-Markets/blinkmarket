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
export type * from "./signing.js";
export type * from "./trading.js";

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
// RestrictedSigner 與持久化 sign request 協定見 signing.ts；signer 自行重載受信資料，不信任 caller 的授權聲明。
// 管理員 / proposer / challenger / arbiter 透過各自人工錢包操作，不走此自動 signer。
export * from "./forecasts.js";

export type * from "./market-read.js";
export * from "./evaluation.js";

export * from "./resolution.js";

export * from "./execution.js";
