import type { ChainCursor, MarketRef, NewMarketSpec } from "@blink/schemas";
import type { Job, SignRequest, SignResult } from "@blink/domain";
export type * from "./identity.js";
export type * from "./preparation.js";
export type * from "./approval.js";

// 邊界合約：實作留到後續 milestone；不公開 ORM 或私鑰。
export interface ImmutableObjectStore {
  putIfAbsent(bytes: Uint8Array, contentHash: string): Promise<{ uri: string }>;
  read(uri: string): Promise<Uint8Array>;
}
export interface SourceFetcher {
  fetchAllowed(
    sourceId: string,
  ): Promise<{ bytes: Uint8Array; observedAt: string; sourceUrl: string }>;
}
export interface ModelGateway {
  forecast(request: {
    runId: string;
    inputObjectUri: string;
    modelVersion: string;
    promptHash: string;
    maxOutputTokens: number;
    costReservationId: string;
  }): Promise<{
    output: unknown;
    providerRequestId: string;
    actualCostMicros: string | null;
  }>;
}
export interface ChainReader {
  getSnapshot(
    ref: MarketRef,
    blockHash: string,
  ): Promise<{
    cursor: ChainCursor;
    makerFreeMicros: string;
    paused: boolean;
    epoch: string;
    verifyingContract: string;
    specHash: string;
    closeAt: string;
    state: string;
  }>;
  getQuoteConsumed(digest: string, cursor: ChainCursor): Promise<boolean>;
  getQuoteCancelled(digest: string, cursor: ChainCursor): Promise<boolean>;
}
export interface SpecArchive {
  freeze(
    spec: NewMarketSpec,
    nowSeconds: bigint,
  ): Promise<{ hash: string; uri: string; bytes: Uint8Array }>;
  read(uri: string, hash: string): Promise<Uint8Array>;
}
export interface JobQueue {
  enqueueWithinTransaction(
    job: Job,
    transaction: TransactionContext,
  ): Promise<void>;
  lease(
    workerId: string,
    acceptedTypes: readonly Job["type"][],
  ): Promise<Job | null>;
  acknowledge(
    jobId: string,
    workerId: string,
    leaseToken: string,
  ): Promise<boolean>;
}
declare const transactionBrand: unique symbol;
export interface TransactionContext {
  readonly [transactionBrand]: true;
}
export interface UnitOfWork {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
// Signer 自行重新載入受信 intent、policy、nonce 與 reservation；不信任 caller 的授權聲明。
export interface RestrictedSigner {
  sign(request: SignRequest): Promise<SignResult>;
}
// 管理員 / proposer / challenger / arbiter 透過各自人工錢包操作，不走此自動 signer。
