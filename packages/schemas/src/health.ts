import { z } from "zod";
import { Uint256 } from "./core.ts";

const Counts = z.array(z.strictObject({ name: z.string(), count: Uint256 }));
export const HealthDetails = z.strictObject({
  queue: Counts,
  chainIndex: z.strictObject({
    blockNumber: Uint256.nullable(),
    headNumber: Uint256.nullable(),
    fresh: z.boolean(),
  }),
  signerReachable: z.boolean(),
  budgetGates: z.strictObject({
    dailyClosed: z.boolean(),
    questionsClosed: Uint256,
  }),
  poolGate: z.strictObject({
    closed: z.boolean(),
    reconcileRequired: z.boolean(),
  }),
});
export const HealthResponse = z.strictObject({
  status: z.enum(["ready", "not-ready"]),
  tradingEnabled: z.boolean(),
  reasons: z.array(
    z.enum([
      "TRADING_DISABLED",
      "INDEXER_LAG",
      "POOL_GATE_CLOSED",
      "RECONCILE_REQUIRED",
      "SIGNER_UNAVAILABLE",
      "BUDGET_GATE_CLOSED",
      "ALERT_DELIVERY_STALLED",
      "SERVICE_NOT_READY",
    ]),
  ),
  details: HealthDetails.optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
const Latency = z.strictObject({
  samples: Uint256,
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
});
export const AdminMetricsResponse = z.strictObject({
  rfqLatency: Latency,
  txInclusionLatency: Latency,
  counts: z.strictObject({
    quotes: Counts,
    transactions: Counts,
    jobs: Counts,
    errors: Counts,
  }),
  gasSpent: z.array(
    z.strictObject({
      role: z.enum(["maker", "trader", "keeper", "faucet"]),
      day: z.iso.date(),
      spentWei: Uint256,
      reservedWei: Uint256,
    }),
  ),
});
export type AdminMetricsResponse = z.infer<typeof AdminMetricsResponse>;
