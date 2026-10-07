import { createService } from "@blink/runtime";
import {
  CHAIN_ID,
  apiContracts,
  generateOpenApi,
  IdempotencyHeaders,
} from "@blink/schemas";
import { modules } from "@blink/domain";
import { routes } from "./routes.js";
import {
  IdentityError,
  identityPaths,
  type IdentityService,
  preparationPaths,
  type PreparationService,
  approvalPaths,
  type ApprovalService,
} from "@blink/application";
import type { ApiScope } from "@blink/schemas";

export function buildApi(
  options: {
    identity?: IdentityService;
    preparation?: PreparationService;
    approval?: ApprovalService;
  } = {},
) {
  if ((options.preparation || options.approval) && !options.identity)
    throw new Error("IDENTITY_REQUIRED");
  const stage = options.approval
    ? "m2-approval"
    : options.preparation
      ? "m2-preparation"
      : options.identity
        ? "m2-identity"
        : "architecture";
  const app = createService("api", stage);
  app.get("/v1/config", async () => ({
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
  }));
  app.get("/v1/health", async (_request, reply) =>
    reply.code(503).send({
      status: "not-ready",
      stage,
      tradingEnabled: false,
    }),
  );
  app.get("/architecture", async () => ({ modules, routes }));
  app.get("/openapi.json", async () =>
    generateOpenApi([
      ...(options.identity ? identityPaths : []),
      ...(options.preparation ? preparationPaths : []),
      ...(options.approval ? approvalPaths : []),
    ]),
  );
  for (const contract of apiContracts) {
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
            reply.header("Cache-Control", "no-store");
            if (error.code === "REQUEST_IN_PROGRESS")
              reply.header("Retry-After", "1");
            return reply.code(error.status).send({
              code: error.code,
              message: error.code,
              requestId: request.id,
              retryable: error.code === "REQUEST_IN_PROGRESS",
              details: {},
            });
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
