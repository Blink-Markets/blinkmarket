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
export { startWorker, schedulePeriodic } from "./worker-runtime.js";
export * from "./forecasts.js";

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

export * from "./health.js";

export * from "./operator-status.js";
export { createAlertDeliveryHandler } from "./alerts.js";
export {
  createAlertEvaluateHandler,
  decideEpisodeChanges,
  type AlertEvaluatePolicy,
} from "./alert-evaluate.js";
