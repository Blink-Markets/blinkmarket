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
  budgetGates: z.strictObject({
    dailyClosed: z.boolean(),
    questionsClosed: Uint256,
  }),
  // Informational only: an alert outage does not make quotes unsafe, so it never closes readiness.
  alerts: z.strictObject({
    stalled: z.boolean(),
    stalledCount: Uint256,
    oldestStalledSeconds: Uint256.nullable(),
  }),
});
export const HealthResponse = z.strictObject({
  status: z.enum(["ready", "not-ready"]),
  tradingEnabled: z.boolean(),
  reasons: z.array(
    z.enum([
      "TRADING_DISABLED",
      "INDEXER_LAG",
      "BUDGET_GATE_CLOSED",
      "SERVICE_NOT_READY",
    ]),
  ),
  details: HealthDetails.optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
export const AdminMetricsResponse = z.strictObject({
  counts: z.strictObject({
    jobs: Counts,
    errors: Counts,
  }),
});
export type AdminMetricsResponse = z.infer<typeof AdminMetricsResponse>;
