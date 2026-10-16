import { HealthResponse, type AdminMetricsResponse } from "@blink/schemas";
import type { HealthReader } from "@blink/ports";
import type { RouteService } from "./route-service.js";

export interface HealthService {
  read(authorization?: string): Promise<HealthResponse>;
}
export function createHealthService(deps: {
  reader: HealthReader;
  now?: () => number;
  signerReachable(): Promise<boolean>;
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
  const signerReachable = cached(
    () => deps.signerReachable().catch(() => false),
    2000,
  );
  const snapshotRead = cached(async () => {
    const [health, signer] = await Promise.all([
      deps.reader.health(),
      signerReachable(),
    ]);
    return { health, signer };
  }, 2000);
  return {
    paths: ["/v1/admin/metrics"],
    async read(authorization) {
      // A supplied key must authenticate as admin before any private diagnostics are read.
      if (authorization !== undefined)
        await deps.authenticateAdmin(authorization);
      try {
        const { health: snapshot, signer } = await snapshotRead();
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
