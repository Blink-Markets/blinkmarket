import Fastify from "fastify";

export function createService(name: string, stage = "architecture") {
  const app = Fastify({
    bodyLimit: 65536,
    logger: { redact: ["req.headers.authorization", "req.headers.cookie"] },
  });
  app.get("/health/live", async () => ({
    service: name,
    status: "alive",
    stage,
  }));
  app.get("/health/ready", async (_request, reply) =>
    reply.code(503).send({
      service: name,
      status: "not-ready",
      reason: "Business adapters are not connected",
    }),
  );
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
