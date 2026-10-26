import Fastify from "fastify";

const ROLE_KEY_NAME = /PRIVATE_KEY|MNEMONIC|KEY_FILE|SEED/i;
const BARE_KEY_VALUE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The platform (API, indexer, worker) holds no role key. A process refuses to start when its
 * environment names one (a PRIVATE_KEY, MNEMONIC, KEY_FILE or SEED variable) or holds a bare 32-byte
 * hex value under any name. The error names the variable, never its value.
 */
export function assertNoRoleKeys(
  env: Record<string, string | undefined>,
): void {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ROLE_KEY_NAME.test(name) || BARE_KEY_VALUE.test(value))
      throw Object.assign(new Error("PLATFORM_ROLE_KEY_FORBIDDEN"), {
        variable: name,
      });
  }
}

export function createService(
  name: string,
  stage = "architecture",
  // Services that have connected their business adapters report real readiness here
  // (synchronously or not); the default stays not-ready.
  ready: () => boolean | Promise<boolean> = () => false,
  // Addresses whose X-Forwarded-For is believed; an empty list trusts no header.
  options: { trustProxy?: readonly string[] } = {},
) {
  const app = Fastify({
    trustProxy: options.trustProxy?.length ? [...options.trustProxy] : false,
    bodyLimit: 65536,
    logger: { redact: ["req.headers.authorization", "req.headers.cookie"] },
  });
  app.get("/health/live", async () => ({
    service: name,
    status: "alive",
    stage,
  }));
  app.get("/health/ready", async (_request, reply) => {
    const isReady = await Promise.resolve()
      .then(ready)
      .catch(() => false);
    if (isReady)
      return reply.code(200).send({ service: name, status: "ready", stage });
    return reply.code(503).send({
      service: name,
      status: "not-ready",
      reason: "Business adapters are not connected",
    });
  });
  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const code =
      typeof status === "number" && status >= 400 && status < 500
        ? status
        : 500;
    reply.code(code).send({
      code: code === 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
      message: code === 500 ? "Internal server error" : "Invalid request",
      requestId: request.id,
      retryable: false,
      details: {},
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: "NOT_FOUND",
      message: "Route not found",
      requestId: request.id,
      retryable: false,
      details: {},
    }),
  );
  return app;
}
export async function startService(
  app: ReturnType<typeof createService>,
  port: number,
  host = "127.0.0.1",
) {
  await app.listen({ port, host });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
}
