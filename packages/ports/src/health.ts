import type { AdminMetricsResponse, HealthResponse } from "@blink/schemas";

export interface HealthReader {
  health(): Promise<{
    reasons: HealthResponse["reasons"];
    details: Omit<NonNullable<HealthResponse["details"]>, "signerReachable">;
  }>;
  metrics(): Promise<AdminMetricsResponse>;
}
