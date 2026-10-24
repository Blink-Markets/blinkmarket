import { HealthResponse, type AdminMetricsResponse } from "@blink/schemas";
import type { HealthReader } from "@blink/ports";
import type { RouteService } from "./route-service.js";

export interface HealthService {
  read(authorization?: string): Promise<HealthResponse>;
}
export function createHealthService(deps: {
  reader: HealthReader;
  now?: () => number;
  authenticateAdmin(authorization: string | undefined): Promise<unknown>;
}): HealthService & RouteService {
  const now = deps.now ?? Date.now;
  function cached<T>(read: () => Promise<T>, ttl: number) {
    let pending: Promise<T> | undefined;
    let expires = 0;
    return () => {
      if (!pending || now() >= expires) {
        expires = Infinity;
        pending = Promise.resolve()
          .then(read)
          .then(
            (value) => {
              expires = now() + ttl;
              return value;
            },
            (error: unknown) => {
              expires = now() + ttl;
              throw error;
            },
          );
      }
      return pending;
    };
  }
  const snapshotRead = cached(() => deps.reader.health(), 2000);
  return {
    paths: ["/v1/admin/metrics"],
    async read(authorization) {
      // A supplied key must authenticate as admin before any private diagnostics are read.
      if (authorization !== undefined)
        await deps.authenticateAdmin(authorization);
      try {
        const snapshot = await snapshotRead();
        const reasons = snapshot.reasons;
        return HealthResponse.parse({
          status: reasons.length ? "not-ready" : "ready",
          tradingEnabled: false,
          reasons: [...new Set(reasons)],
          ...(authorization !== undefined ? { details: snapshot.details } : {}),
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
