import type { ChainIndexHealth } from "@blink/application";
import type { createService } from "@blink/runtime";

// The RFQ gate reads this: 200 only while the chain index is fresh and ungated.
export function registerChainIndexHealth(
  app: ReturnType<typeof createService>,
  health: (() => Promise<ChainIndexHealth>) | null,
) {
  app.get("/health/chain-index", async (_request, reply) => {
    if (!health)
      return reply
        .code(503)
        .send({ component: "chain-indexer", ready: false, status: "disabled" });
    try {
      const result = await health();
      return reply.code(result.ready ? 200 : 503).send(result);
    } catch {
      return reply.code(503).send({
        component: "chain-indexer",
        ready: false,
        status: "health-query-failed",
      });
    }
  });
}
