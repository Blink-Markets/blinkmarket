export {
  createIdentityService,
  IdentityError,
  identityPaths,
  type IdentityService,
} from "./identity.js";
export const implementationStage = "m2-identity" as const;
export type {
  RouteService,
  ServiceRequest,
  ServiceResponse,
} from "./route-service.js";
export {
  createPreparationService,
  preparationPaths,
  type PreparationService,
} from "./preparation.js";
export { prepareReplayApproval } from "./approval-preflight.js";
export {
  createApprovalService,
  approvalPaths,
  type ApprovalService,
} from "./approval.js";
export { createCreationTracker } from "./creation-tracker.js";
export { startCreationPoller } from "./creation-poller.js";
export { startWorker, schedulePeriodic } from "./worker-runtime.js";
export {
  createBudgetedModelCaller,
  ModelCallError,
} from "./budgeted-model.js";
export { createEvidenceFetchHandler } from "./evidence-fetch.js";
export * from "./forecasts.js";
export {
  createDiscoveryHandler,
  createDiscoveryScheduler,
} from "./discovery.js";
export {
  createForecastRunHandler,
  createForecastDispatchHandler,
} from "./platform-forecaster.js";

export { authenticateIdentity } from "./identity.js";
export { createMarketReadService } from "./market-read.js";
export { createTxTracker } from "./tx-tracking.js";
export * from "./evaluation.js";
export {
  assertBaseSepolia,
  chainIndexHealth,
  createChainIndexer,
  rebuildChainProjection,
  startChainIndexer,
  type ChainIndexHealth,
  type ChainRebuildReport,
  type ChainSyncResult,
} from "./chain-indexer.js";

export * from "./resolution.js";
export {
  createSignerService,
  assertSignerStartup,
  transactionRequestHash,
  quoteRequestHash,
  quoteTypedData,
  QuoteCheckRejection,
  createReservationQuoteCheck,
  type SignerDeps,
  type SignerCaller,
  type SignerPolicy,
  type QuoteCheck,
} from "./signer.js";
export {
  createTxDispatcher,
  createTxDispatchHandler,
  TxDispatchError,
  type DispatchResult,
  type TxDispatchHandler,
} from "./tx-dispatcher.js";

export * from "./faucet.js";
export * from "./keeper.js";
export * from "./execution.js";
export {
  createRfqService,
  createTradingReadiness,
  indexerStatus,
  type SnapshotSource,
} from "./rfq.js";
export {
  createQuoteReconciler,
  createQuoteReconcileHandler,
  decideReservation,
} from "./quote-reconcile.js";
export {
  createTrader,
  createTraderHandler,
  traderIntentId,
  traderStopReason,
  verifyTraderQuote,
  type TraderDeps,
  type TraderRun,
} from "./trader.js";
