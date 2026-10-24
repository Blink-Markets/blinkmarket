import { createService } from "@blink/runtime";
import {
  CHAIN_ID,
  apiContracts,
  generateOpenApi,
  IdempotencyHeaders,
  WalletChallengeRequest,
  type ConfigResponse,
} from "@blink/schemas";
import { modules } from "@blink/domain";
import { routes } from "./routes.js";
import { createTokenBucket } from "./rate-limit.js";
import { isDatabaseUnavailable } from "./database-errors.js";
import {
  IdentityError,
  identityPaths,
  type IdentityService,
  type RouteService,
  type HealthService,
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

// Wallet challenges are public and cost a database row and a later chain read, so each client IP and
// each address gets its own hourly allowance. In-process, like the public read limit (one API instance).
const HOUR_SECONDS = 3600;
const defaultChallengeLimits = {
  perIp: { capacity: 30, refillPerSecond: 30 / HOUR_SECONDS },
  perAddress: { capacity: 10, refillPerSecond: 10 / HOUR_SECONDS },
};
type BucketOptions = Parameters<typeof createTokenBucket>[0];

// The database could not be reached: not a fault of the request, and the same request may be repeated.
const databaseUnavailable = () =>
  new IdentityError(503, "SERVICE_NOT_READY", {
    retryable: true,
    retryAfterSeconds: 1,
    details: { reason: "DATABASE_UNAVAILABLE" },
  });

export function buildApi(
  options: {
    identity?: IdentityService;
    health?: HealthService;
    services?: RouteService[];
    stage?: "architecture" | "m2-identity" | "m2-markets";
    config?: () => Promise<ConfigResponse>;
    assertReady?: () => Promise<void>;
    publicReadLimit?: {
      capacity: number;
      refillPerSecond: number;
      now?: () => number;
    };
    trustedProxies?: readonly string[];
    walletChallengeLimits?: { perIp: BucketOptions; perAddress: BucketOptions };
  } = {},
) {
  // A contract path has exactly one owner: a built-in option or one route service.
  const builtIn = new Set<string>([...(options.identity ? identityPaths : [])]);
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
    options.stage ?? (options.identity ? "m2-identity" : "architecture");
  const app = createService(
    "api",
    stage,
    async () => {
      await options.assertReady?.();
      return (await options.health?.read())?.status === "ready";
    },
    { trustProxy: options.trustedProxies ?? [] },
  );
  const challengeLimits =
    options.walletChallengeLimits ?? defaultChallengeLimits;
  const challengesByIp = createTokenBucket(challengeLimits.perIp);
  const challengesByAddress = createTokenBucket(challengeLimits.perAddress);
  // Reads of public data are unauthenticated; bound them per client IP (HEAD runs the same handlers).
  const publicReads = options.publicReadLimit
    ? createTokenBucket(options.publicReadLimit)
    : undefined;
  const limitedUrls = new Set(
    apiContracts
      .filter((c) => c.method === "GET" && c.access.startsWith("public"))
      .map((c) => c.path),
  );
  limitedUrls.add("/v1/health");
  limitedUrls.add("/health/ready");
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
  app.get("/v1/health", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      await options.assertReady?.();
      const body = options.health
        ? await options.health.read(request.headers.authorization)
        : {
            status: "not-ready",
            tradingEnabled: false,
            reasons: ["SERVICE_NOT_READY"],
          };
      return reply.code(body.status === "ready" ? 200 : 503).send(body);
    } catch (error) {
      if (error instanceof IdentityError)
        return sendIdentityError(request, reply, error);
      return reply.code(503).send({
        status: "not-ready",
        tradingEnabled: false,
        reasons: ["SERVICE_NOT_READY"],
      });
    }
  });
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
            if (isDatabaseUnavailable(error))
              return sendIdentityError(request, reply, databaseUnavailable());
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
              contract.path === identityPaths[0] ||
              contract.path === identityPaths[1]
            ) {
              if (
                !contract.params.safeParse(request.params).success ||
                !contract.query.safeParse(request.query).success
              )
                throw new IdentityError(400, "INVALID_REQUEST");
              if (contract.path === identityPaths[0]) {
                const wanted = WalletChallengeRequest.safeParse(request.body);
                const taken = [
                  challengesByIp.take(request.ip),
                  // An unparsable body is refused by the service; it must not spend an address allowance.
                  wanted.success
                    ? challengesByAddress.take(
                        wanted.data.address.toLowerCase(),
                      )
                    : ({ allowed: true } as const),
                ].find((t) => !t.allowed);
                if (taken && !taken.allowed)
                  throw new IdentityError(429, "RATE_LIMITED", {
                    retryAfterSeconds: taken.retryAfterSeconds,
                  });
              }
              const result = await options.identity.mutate(contract.path, {
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
                "forecast:write": "forecast:write",
                admin: "admin",
              } as Record<string, ApiScope | "admin">
            )[contract.access];
            if (
              scope ||
              ["verified-wallet", "taker/admin"].includes(contract.access)
            ) {
              await options.identity.authenticate(
                request.headers.authorization,
                scope,
              );
            }
          } catch (error) {
            if (error instanceof IdentityError)
              return sendIdentityError(request, reply, error);
            if (!isDatabaseUnavailable(error)) throw error;
            request.log.error({ err: error }, "DATABASE_UNAVAILABLE");
            return sendIdentityError(request, reply, databaseUnavailable());
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
