import { createService } from "@blink/runtime";

// POST /internal/sign: the only signing route. The bearer token and the strict body are checked
// by the signer service itself; this layer only carries them. Nothing here reads a key.
export function buildSignerServer(
  service: {
    handle(
      token: string | undefined,
      body: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }>;
  },
  // Readiness is the signer's own: true only while its database and its RPC answer correctly.
  ready?: () => Promise<boolean>,
) {
  const app = createService("signer", "m2-restricted-signer", ready);
  app.post("/internal/sign", async (request, reply) => {
    const header = request.headers.authorization;
    const token =
      typeof header === "string"
        ? /^Bearer (\S+)$/.exec(header)?.[1]
        : undefined;
    const response = await service.handle(token, request.body);
    return reply
      .code(response.status)
      .header("cache-control", "no-store")
      .send(response.body);
  });
  return app;
}
