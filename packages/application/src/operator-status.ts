import type { HealthService } from "./health.js";
import type { OperatorStatusStore, IdentityPrincipal } from "@blink/ports";
import type { RouteService } from "./route-service.js";
import { IdentityError } from "./identity.js";
export function createOperatorStatusService(deps: {
  store: OperatorStatusStore;
  health?: HealthService;
  authenticateAdmin(
    authorization: string | undefined,
  ): Promise<IdentityPrincipal>;
}): RouteService {
  return {
    paths: ["/v1/admin/jobs", "/v1/admin/pause"],
    async handle(request) {
      try {
        await deps.authenticateAdmin(request.authorization);
      } catch (error) {
        if (
          error instanceof IdentityError &&
          [401, 403, 404].includes(error.status)
        )
          throw new IdentityError(404, "NOT_FOUND");
        throw error;
      }
      if (request.path === "/v1/admin/pause") {
        const [pause, health] = await Promise.all([
          deps.store.pause(),
          deps.health?.read(request.authorization),
        ]);
        return {
          status: 200,
          body: {
            ...pause,
            health: health ?? {
              status: "not-ready",
              tradingEnabled: false,
              reasons: ["SERVICE_NOT_READY"],
            },
          },
        };
      }
      return {
        status: 200,
        body: await deps.store.jobs(request.query.state as string | undefined),
      };
    },
  };
}
