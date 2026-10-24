import type { AdminMetricsResponse, HealthResponse } from "@blink/schemas";

export interface HealthReader {
  health(): Promise<{
    reasons: HealthResponse["reasons"];
    details: NonNullable<HealthResponse["details"]>;
  }>;
  metrics(): Promise<AdminMetricsResponse>;
}
