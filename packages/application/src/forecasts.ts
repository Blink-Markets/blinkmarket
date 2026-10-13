import { apiContracts, IdempotencyHeaders } from "@blink/schemas";
import { plannedWindows } from "@blink/domain";
import type {
  ForecastStore,
  ForecastInput,
  IdentityCrypto,
} from "@blink/ports";
import { authenticateIdentity, IdentityError } from "./identity.js";
import type { RouteService } from "./route-service.js";

const paths = [
  "/v1/markets/:id/forecast-windows",
  "/v1/markets/:id/forecasts",
] as const;
const fail = (status: number, code: string, reason?: string): never => {
  throw new IdentityError(status, code, { details: reason ? { reason } : {} });
};
export function createForecastService({
  store,
  crypto,
}: {
  store: ForecastStore;
  crypto: IdentityCrypto;
}): RouteService {
  return {
    paths,
    async handle(request) {
      const contract = apiContracts.find(
        (c) => c.path === request.path && c.method === request.method,
      );
      if (!contract) return fail(404, "NOT_FOUND");
      const query = contract.query.safeParse(request.query),
        params = contract.params.safeParse(request.params);
      if (!query.success || !params.success)
        return fail(400, "INVALID_REQUEST");
      const deploymentId = String(query.data.deploymentId),
        marketId = String(params.data.id);
      if (request.method === "POST") {
        const parsed = contract.body!.safeParse(request.body);
        if (
          !parsed.success ||
          !IdempotencyHeaders.safeParse({
            "idempotency-key": request.idempotencyKey,
          }).success
        )
          return fail(400, "INVALID_REQUEST");
        const input = parsed.data as ForecastInput,
          key = request.idempotencyKey!;
        return store.run(async (tx) => {
          const principal = await authenticateIdentity(
            tx,
            crypto,
            request.authorization,
            "forecast:write",
          );
          const scope = `POST /v1/markets/${marketId}/forecasts`;
          const hash = crypto.hash(
            JSON.stringify({
              keyId: principal.keyId,
              body: { deploymentId, ...input },
            }),
          );
          const claim = await tx.claimRequest(
            principal.operatorId,
            scope,
            key,
            hash,
          );
          if (claim.state === "DONE") return claim.result;
          if (claim.state !== "NEW")
            return fail(
              409,
              claim.state === "BUSY"
                ? "REQUEST_IN_PROGRESS"
                : "IDEMPOTENCY_CONFLICT",
            );
          const window = await tx.window(
            deploymentId,
            marketId,
            input.horizonKey,
            true,
          );
          if (!window) return fail(404, "NOT_FOUND");
          const now = await tx.now();
          if (now < window.openAt || now >= window.deadline)
            return fail(
              409,
              "FORECAST_WINDOW_CLOSED",
              now < window.openAt ? "NOT_OPEN" : "CLOSED",
            );
          if (!(await tx.marketOpen(deploymentId, marketId, now)))
            return fail(409, "MARKET_CLOSED");
          if (
            !(await tx.evidenceAllowed(input.evidenceIds, principal.operatorId))
          )
            return fail(409, "EVIDENCE_NOT_ALLOWED");
          if (await tx.submitted(window.id, principal.agentId))
            return fail(409, "FORECAST_ALREADY_SUBMITTED");
          const submissionId = crypto.id(),
            receivedAt = await tx.submit(
              submissionId,
              window,
              principal,
              input,
            );
          if (!receivedAt) return fail(409, "FORECAST_WINDOW_CLOSED", "CLOSED");
          await tx.auditForecast(
            principal.keyId,
            submissionId,
            request.requestId,
          );
          const result = {
            status: 201,
            body: {
              submissionId,
              receivedAt: receivedAt.toISOString(),
              windowId: window.id,
            },
          };
          await tx.finishRequest(principal.operatorId, scope, key, result);
          return result;
        });
      }
      return store.run(async (tx) => {
        const principal =
          request.authorization !== undefined
            ? await authenticateIdentity(tx, crypto, request.authorization)
            : null;
        const limit = Number(query.data.limit),
          cursor = query.data.cursor as string | undefined;
        if (request.path === paths[0]) {
          let after: { scheduledAt: string; horizonType: string } | null = null;
          if (cursor) {
            const [time, type, ...rest] = cursor.split("|");
            if (
              !time ||
              !Number.isFinite(Date.parse(time)) ||
              new Date(time).toISOString() !== time ||
              !["DAILY", "PRE_CLOSE"].includes(type ?? "") ||
              rest.length
            )
              return fail(400, "INVALID_REQUEST");
            after = { scheduledAt: time, horizonType: type! };
          }
          const rows = await tx.windows(
              deploymentId,
              marketId,
              limit + 1,
              after,
            ),
            now = await tx.now();
          const items = rows.slice(0, limit).map((w) => ({
            windowId: w.id,
            horizonKey: {
              horizonType: w.horizonType,
              scheduledAt: w.scheduledAt.toISOString(),
            },
            openAt: w.openAt.toISOString(),
            deadline: w.deadline.toISOString(),
            status:
              now < w.openAt
                ? "UPCOMING"
                : now >= w.deadline
                  ? "CLOSED"
                  : "OPEN",
          }));
          const last = items.at(-1);
          return {
            status: 200,
            body: {
              items,
              nextCursor:
                rows.length > limit && last
                  ? `${last.horizonKey.scheduledAt}|${last.horizonKey.horizonType}`
                  : null,
            },
          };
        }
        const window = await tx.window(
          deploymentId,
          marketId,
          String(query.data.windowId),
          false,
        );
        if (!window) return fail(404, "NOT_FOUND");
        const now = await tx.now();
        if (now < window.deadline && !principal)
          return { status: 200, body: { items: [], nextCursor: null } };
        if (
          cursor &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            cursor,
          )
        )
          return fail(400, "INVALID_REQUEST");
        const rows = await tx.submissions(
          window.id,
          now < window.deadline ? principal!.agentId : null,
          limit + 1,
          cursor ?? null,
        );
        const items = rows.slice(0, limit);
        return {
          status: 200,
          body: {
            items,
            nextCursor:
              rows.length > limit ? String(items.at(-1)!.submissionId) : null,
          },
        };
      });
    },
  };
}
export function createWindowScheduler(store: ForecastStore) {
  return {
    scheduleOnce: () =>
      store.run(async (tx) => {
        const markets = await tx.openMarkets();
        let count = 0;
        for (const market of markets) {
          const now = await tx.now();
          for (const window of plannedWindows({ closeAt: market.closeAt, now }))
            if (
              await tx.addWindow({
                ...window,
                deploymentId: market.deploymentId,
                marketId: market.marketId,
              })
            )
              count++;
        }
        return count;
      }),
  };
}
export function createSnapshotReader(store: ForecastStore) {
  return {
    latest: (deploymentId: string, marketId: string) =>
      store.run((tx) => tx.latestSnapshot(deploymentId, marketId)),
  };
}
export function createForecastScheduleHandler(
  scheduler: ReturnType<typeof createWindowScheduler>,
) {
  return async (ctx: {
    job: { id: string; payload: Record<string, unknown> };
    signal: AbortSignal;
  }): Promise<void> => {
    if (ctx.signal.aborted)
      throw new ForecastScheduleError("OPERATION_ABORTED", true);
    try {
      await scheduler.scheduleOnce();
    } catch (error) {
      throw new ForecastScheduleError("FORECAST_SCHEDULE_FAILED", true, error);
    }
  };
}
export class ForecastScheduleError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}
