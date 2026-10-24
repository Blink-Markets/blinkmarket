import { createService } from "@blink/runtime";
import {
  CHAIN_ID,
  apiContracts,
  generateOpenApi,
  IdempotencyHeaders,
  WalletChallengeRequest,
  type ConfigResponse,
  type HttpContract,
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
// Each verification reaches the chain through the signature check, so it has its own per-IP allowance
// (a legitimate proof needs one or two) on top of the per-challenge attempt budget.
const defaultVerificationLimit = {
  capacity: 60,
  refillPerSecond: 60 / HOUR_SECONDS,
};
// Human suggestions are public and need no key, so they are bounded per client IP and overall. The
// buckets hold a full allowance at start and refill evenly (one API instance, like the limits above).
const DAY_SECONDS = 86_400;
const defaultSuggestionLimits = {
  perIp: { capacity: 5, refillPerSecond: 5 / HOUR_SECONDS },
  global: { capacity: 500, refillPerSecond: 500 / DAY_SECONDS },
};
const GLOBAL_SUGGESTION_KEY = "all";
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
    walletVerificationLimit?: BucketOptions;
    suggestionLimits?: { perIp: BucketOptions; global: BucketOptions };
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
  const verificationsByIp = createTokenBucket(
    options.walletVerificationLimit ?? defaultVerificationLimit,
  );
  const suggestionLimits = options.suggestionLimits ?? defaultSuggestionLimits;
  const suggestionsByIp = createTokenBucket(suggestionLimits.perIp);
  const suggestionsOverall = createTokenBucket(suggestionLimits.global);
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
  // The client IP is charged first and stops the request; only an IP-approved request spends a token
  // of the overall allowance, so one blocked client cannot use up everyone's suggestions. The charge
  // comes before the body is read or validated.
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.method !== "POST" ||
      request.routeOptions.url !== "/v1/suggestions"
    )
      return;
    const taken = suggestionsByIp.take(request.ip);
    const overall = taken.allowed
      ? suggestionsOverall.take(GLOBAL_SUGGESTION_KEY)
      : taken;
    if (overall.allowed) return;
    return sendIdentityError(
      request,
      reply,
      new IdentityError(429, "RATE_LIMITED", {
        retryable: true,
        retryAfterSeconds: overall.retryAfterSeconds,
      }),
    );
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
  // Routes that take raw bytes live in their own scope, so their parsers (which keep the exact
  // bytes, even for application/json) never replace the JSON parser of the other routes.
  const mount = (
    contract: HttpContract,
    route: Parameters<typeof app.route>[0],
  ) => {
    const withLimit = {
      ...route,
      ...(contract.bodyLimit ? { bodyLimit: contract.bodyLimit } : {}),
    } as typeof route;
    const raw = contract.rawRequest;
    if (!raw) return void app.route(withLimit);
    void app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        [...raw.mediaTypes],
        { parseAs: "buffer", bodyLimit: raw.maxBytes },
        (_request, body, done) => done(null, body),
      );
      // Refuse before the body is read when there is no credential to check.
      scope.addHook("onRequest", async (request, reply) => {
        if (!request.headers.authorization)
          return sendIdentityError(
            request,
            reply,
            new IdentityError(401, "UNAUTHORIZED"),
          );
      });
      scope.route(withLimit);
    });
  };
  for (const contract of apiContracts) {
    const service = owners.get(contract.path);
    if (service) {
      mount(contract, {
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
                contract.idempotencyKey !== false &&
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
              contentType: request.headers["content-type"],
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
    mount(contract, {
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
                // The client IP is charged first and stops the request; only an IP-approved request
                // spends an address token. The address allowance is per (client IP, address): no
                // proof of control is needed to ask for a challenge, so one client must not be able
                // to use up an address's allowance for everyone else.
                const byIp = challengesByIp.take(request.ip);
                const wanted = WalletChallengeRequest.safeParse(request.body);
                // An unparsable body is refused by the service; it must not spend an address token.
                const byAddress =
                  byIp.allowed && wanted.success
                    ? challengesByAddress.take(
                        request.ip + "|" + wanted.data.address.toLowerCase(),
                      )
                    : byIp;
                if (!byAddress.allowed)
                  throw new IdentityError(429, "RATE_LIMITED", {
                    retryAfterSeconds: byAddress.retryAfterSeconds,
                  });
              } else {
                const taken = verificationsByIp.take(request.ip);
                if (!taken.allowed)
                  throw new IdentityError(429, "RATE_LIMITED", {
                    retryAfterSeconds: taken.retryAfterSeconds,
                  });
              }
              const result = await options.identity.mutate(contract.path, {
                body: request.body,
                requestId: request.id,
                clientIp: request.ip,
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
            contract.idempotencyKey === false ||
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
