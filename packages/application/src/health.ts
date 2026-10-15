import { HealthResponse, type AdminMetricsResponse } from "@blink/schemas";
import type { HealthReader } from "@blink/ports";
import type { RouteService } from "./route-service.js";

export interface HealthService {
  read(authorization?: string): Promise<HealthResponse>;
}
export function createHealthService(deps: {
  reader: HealthReader;
  signerReachable(): Promise<boolean>;
  authenticateAdmin(authorization: string | undefined): Promise<unknown>;
}): HealthService & RouteService {
  return {
    paths: ["/v1/admin/metrics"],
    async read(authorization) {
      // A supplied key must authenticate as admin before any private diagnostics are read.
      if (authorization !== undefined)
        await deps.authenticateAdmin(authorization);
      try {
        const [snapshot, signer] = await Promise.all([
          deps.reader.health(),
          deps.signerReachable().catch(() => false),
        ]);
        const reasons = [
          ...snapshot.reasons,
          ...(!signer ? ["SIGNER_UNAVAILABLE"] : []),
        ];
        return HealthResponse.parse({
          status: reasons.length ? "not-ready" : "ready",
          tradingEnabled: reasons.length === 0,
          reasons: [...new Set(reasons)],
          ...(authorization !== undefined
            ? { details: { ...snapshot.details, signerReachable: signer } }
            : {}),
        });
      } catch {
        return {
          status: "not-ready",
          tradingEnabled: false,
          reasons: ["SERVICE_NOT_READY"],
        };
      }
    },
    async handle(request) {
      await deps.authenticateAdmin(request.authorization);
      const body: AdminMetricsResponse = await deps.reader.metrics();
      return { status: 200, body };
    },
  };
}
