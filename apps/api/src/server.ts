import { createService } from "@blink/runtime";
import {
  CHAIN_ID,
  apiContracts,
  generateOpenApi,
  IdempotencyHeaders,
  type ConfigResponse,
} from "@blink/schemas";
import { modules } from "@blink/domain";
import { routes } from "./routes.js";
import { createTokenBucket } from "./rate-limit.js";
import {
  IdentityError,
  identityPaths,
  type IdentityService,
  preparationPaths,
  type PreparationService,
  approvalPaths,
  type ApprovalService,
  type RouteService,
} from "@blink/application";
import type { ApiScope } from "@blink/schemas";

type Reply = {
  header(name: string, value: string): unknown;
  code(status: number): { send(body: unknown): unknown };
};
const lowercaseHex = (value: string) =>
  /^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : value;
function sendIdentityError(
  request: { id: string },
  reply: Reply,
  error: IdentityError,
) {
  reply.header("Cache-Control", "no-store");
  const retryAfter =
    error.retryAfterSeconds ??
    (error.code === "REQUEST_IN_PROGRESS" ? 1 : undefined);
  if (retryAfter !== undefined)
    reply.header("Retry-After", String(Math.ceil(retryAfter)));
  return reply.code(error.status).send({
    code: error.code,
    message: error.code,
    requestId: request.id,
    retryable: error.retryable,
    details: error.details,
  });
}

export function buildApi(
  options: {
    identity?: IdentityService;
    preparation?: PreparationService;
    approval?: ApprovalService;
    services?: RouteService[];
    stage?:
      | "architecture"
      | "m2-identity"
      | "m2-preparation"
      | "m2-approval"
      | "m2-markets"
      | "m2-trading";
    config?: () => Promise<ConfigResponse>;
    publicReadLimit?: {
      capacity: number;
      refillPerSecond: number;
      now?: () => number;
    };
  } = {},
) {
  if ((options.preparation || options.approval) && !options.identity)
    throw new Error("IDENTITY_REQUIRED");
  // A contract path has exactly one owner: a built-in option or one route service.
  const builtIn = new Set<string>([
    ...(options.identity ? identityPaths : []),
    ...(options.preparation ? preparationPaths : []),
    ...(options.approval ? approvalPaths : []),
  ]);
  const contractPaths = new Set(apiContracts.map((c) => c.path));
  const owners = new Map<string, RouteService>();
  for (const service of options.services ?? [])
    for (const path of service.paths) {
      if (!contractPaths.has(path))
        throw new Error("UNKNOWN_ROUTE_SERVICE_PATH");
      if (builtIn.has(path) || owners.has(path))
        throw new Error("DUPLICATE_ROUTE_SERVICE");
      owners.set(path, service);
    }
  const stage =
    options.stage ??
    (options.approval
      ? "m2-approval"
      : options.preparation
        ? "m2-preparation"
        : options.identity
          ? "m2-identity"
          : "architecture");
  const app = createService("api", stage);
  // Reads of public data are unauthenticated; bound them per client IP (HEAD runs the same handlers).
  const publicReads = options.publicReadLimit
    ? createTokenBucket(options.publicReadLimit)
    : undefined;
  const limitedUrls = new Set(
    apiContracts
      .filter((c) => c.method === "GET" && c.access.startsWith("public"))
      .map((c) => c.path),
  );
  if (publicReads)
    app.addHook("onRequest", async (request, reply) => {
      if (
        (request.method !== "GET" && request.method !== "HEAD") ||
        !limitedUrls.has(request.routeOptions.url ?? "")
      )
        return;
      const taken = publicReads.take(request.ip);
      if (taken.allowed) return;
      reply.header("Cache-Control", "no-store");
      reply.header("Retry-After", String(taken.retryAfterSeconds));
      return reply.code(429).send({
        code: "RATE_LIMITED",
        message: "RATE_LIMITED",
        requestId: request.id,
        retryable: true,
        details: {},
      });
    });
  app.get(
    "/v1/config",
    async () =>
      options.config?.() ?? {
        chainId: CHAIN_ID,
        stage,
        tradingEnabled: false,
        deployment: null,
        asset: {
          name: "Blink Test USD",
          symbol: "bUSD",
          decimals: 6,
          hasValue: false,
        },
      },
  );
  app.get("/v1/health", async (_request, reply) =>
    reply.code(503).send({
      status: "not-ready",
      stage,
      tradingEnabled: false,
    }),
  );
  app.get("/architecture", async () => ({ modules, routes }));
  app.get("/openapi.json", async () =>
    generateOpenApi([...builtIn, ...owners.keys()]),
  );
  for (const contract of apiContracts) {
    const service = owners.get(contract.path);
    if (service) {
      app.route({
        method: contract.method,
        url: contract.path,
        handler: async (request, reply) => {
          try {
            const params = contract.params.safeParse(request.params);
            const query = contract.query.safeParse(request.query);
            if (
              !params.success ||
              !query.success ||
              (contract.method === "POST" &&
                !IdempotencyHeaders.safeParse(request.headers).success)
            )
              throw new IdentityError(400, "INVALID_REQUEST");
            const key = request.headers["idempotency-key"];
            const result = await service.handle({
              method: contract.method,
              path: contract.path,
              params: Object.fromEntries(
                Object.entries(params.data).map(([name, value]) => [
                  name,
                  lowercaseHex(String(value)),
                ]),
              ),
              query: query.data,
              body: request.body,
              authorization: request.headers.authorization,
              idempotencyKey: typeof key === "string" ? key : undefined,
              requestId: request.id,
              ip: request.ip,
            });
            reply.header("Cache-Control", "no-store");
            for (const [name, value] of Object.entries(result.headers ?? {}))
              reply.header(name, value);
            reply.code(result.status);
            reply.type(result.contentType ?? "application/json");
            if (result.body instanceof Uint8Array)
              return reply.send(Buffer.from(result.body));
            return reply.send(
              result.status >= 400 && result.body.requestId === undefined
                ? { ...result.body, requestId: request.id }
                : result.body,
            );
          } catch (error) {
            if (error instanceof IdentityError)
              return sendIdentityError(request, reply, error);
            request.log.error({ err: error }, "ROUTE_SERVICE_FAILED");
            reply.header("Cache-Control", "no-store");
            return reply.code(500).send({
              code: "INTERNAL_ERROR",
              message: "Internal server error",
              requestId: request.id,
              retryable: false,
              details: {},
            });
          }
        },
      });
      continue;
    }
    app.route({
      method: contract.method,
      url: contract.path,
      handler: async (request, reply) => {
        if (options.identity) {
          try {
            if (
              options.approval &&
              approvalPaths.includes(
                contract.path as (typeof approvalPaths)[number],
              )
            ) {
              reply.header("Cache-Control", "no-store");
              const params = contract.params.safeParse(request.params);
              if (
                !params.success ||
                !contract.query.safeParse(request.query).success
              )
                throw new IdentityError(400, "INVALID_REQUEST");
              if (contract.path === approvalPaths[2]) {
                const bytes = await options.approval.spec(
                  String(params.data.specHash).toLowerCase(),
                );
                return reply.type("application/json").send(Buffer.from(bytes));
              }
              const id = String(params.data.id).toLowerCase();
              if (contract.path === approvalPaths[3])
                return await options.approval.chainStatus(
                  id,
                  request.headers.authorization,
                );
              if (contract.path === approvalPaths[1])
                return await options.approval.intent(
                  id,
                  request.headers.authorization,
                );
              const result = await options.approval.approve(id, {
                authorization: request.headers.authorization,
                idempotencyKey:
                  typeof request.headers["idempotency-key"] === "string"
                    ? request.headers["idempotency-key"]
                    : undefined,
                body: request.body,
                requestId: request.id,
              });
              if (
                "code" in result.body &&
                result.body.code === "REQUEST_IN_PROGRESS"
              )
                reply.header("Retry-After", "1");
              return reply
                .code(result.status)
                .send(
                  result.status >= 400
                    ? { ...result.body, requestId: request.id }
                    : result.body,
                );
            }
            if (
              options.preparation &&
              preparationPaths.includes(
                contract.path as (typeof preparationPaths)[number],
              )
            ) {
              reply.header("Cache-Control", "no-store");
              const result = await options.preparation.handle(contract.path, {
                authorization: request.headers.authorization,
                idempotencyKey:
                  typeof request.headers["idempotency-key"] === "string"
                    ? request.headers["idempotency-key"]
                    : undefined,
                params: request.params,
                query: request.query,
                body: request.body,
                requestId: request.id,
              });
              return reply
                .code(result.status)
                .send(
                  result.status >= 400
                    ? { ...result.body, requestId: request.id }
                    : result.body,
                );
            }
            if (
              contract.path === identityPaths[0] ||
              contract.path === identityPaths[1]
            ) {
              if (
                !contract.params.safeParse(request.params).success ||
                !contract.query.safeParse(request.query).success
              )
                throw new IdentityError(400, "INVALID_REQUEST");
              const result = await options.identity.mutate(contract.path, {
                authorization: request.headers.authorization,
                idempotencyKey:
                  typeof request.headers["idempotency-key"] === "string"
                    ? request.headers["idempotency-key"]
                    : undefined,
                body: request.body,
                requestId: request.id,
              });
              reply.header("Cache-Control", "no-store");
              return reply
                .code(result.status)
                .send(
                  result.status >= 400
                    ? { ...result.body, requestId: request.id }
                    : result.body,
                );
            }
            const scope = (
              {
                "candidate:write": "candidate:write",
                "forecast:write": "forecast:write",
                "trade:quote + wallet": "trade:quote",
                "report:write": "report:write",
                admin: "admin",
                "allowed-wallet": "faucet:claim",
              } as Record<string, ApiScope>
            )[contract.access];
            if (
              scope ||
              [
                "verified-wallet",
                "taker/admin",
                "owner/admin; approved public",
              ].includes(contract.access)
            ) {
              await options.identity.authenticate(
                request.headers.authorization,
                scope,
              );
            }
          } catch (error) {
            if (!(error instanceof IdentityError)) throw error;
            return sendIdentityError(request, reply, error);
          }
        }
        const valid =
          contract.params.safeParse(request.params).success &&
          contract.query.safeParse(request.query).success &&
          (contract.method !== "POST" ||
            IdempotencyHeaders.safeParse(request.headers).success) &&
          (!contract.body || contract.body.safeParse(request.body).success);
        if (!valid)
          return reply.code(400).send({
            code: "INVALID_REQUEST",
            message: "Request does not match the API contract",
            requestId: request.id,
            retryable: false,
            details: {},
          });
        return reply.code(501).send({
          code: "NOT_IMPLEMENTED",
          message: "Business handlers are not enabled",
          requestId: request.id,
          retryable: false,
          details: {},
        });
      },
    });
  }
  return app;
}
