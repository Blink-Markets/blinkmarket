import { createService } from "@blink/runtime";
import {
  CHAIN_ID,
  apiContracts,
  generateOpenApi,
  IdempotencyHeaders,
} from "@blink/schemas";
import { modules } from "@blink/domain";
import { routes } from "./routes.js";

export function buildApi() {
  const app = createService("api");
  app.get("/v1/config", async () => ({
    chainId: CHAIN_ID,
    stage: "architecture",
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
    reply
      .code(503)
      .send({
        status: "not-ready",
        stage: "architecture",
        tradingEnabled: false,
      }),
  );
  app.get("/architecture", async () => ({ modules, routes }));
  app.get("/openapi.json", async () => generateOpenApi());
  for (const contract of apiContracts) {
    app.route({
      method: contract.method,
      url: contract.path,
      handler: async (request, reply) => {
        const valid =
          contract.params.safeParse(request.params).success &&
          contract.query.safeParse(request.query).success &&
          (contract.method !== "POST" ||
            IdempotencyHeaders.safeParse(request.headers).success) &&
          (!contract.body || contract.body.safeParse(request.body).success);
        if (!valid)
          return reply
            .code(400)
            .send({
              code: "INVALID_REQUEST",
              message: "Request does not match the API contract",
              requestId: request.id,
              retryable: false,
              details: {},
            });
        return reply
          .code(501)
          .send({
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
