import type { Pool } from "pg";
import { createPublicClient, http, type Hex } from "viem";
import type { JobType } from "@blink/domain";
import type { JobHandler, JobQueue, TraderQuoteApi } from "@blink/ports";
import {
  assertProductionClock,
  assertTraderInstalled,
  chainSnapshotReader,
  encodeAllowedCall,
  executionChainReader,
  loadChainDeployment,
  postgresDispatchStore,
  postgresTraderStore,
  signerClient,
  viemDispatchRpc,
} from "@blink/adapters";
import {
  createTrader,
  createTraderHandler,
  createTxDispatcher,
  schedulePeriodic,
} from "@blink/application";
import { BlinkApiError, createBlinkClient } from "@blink/client";
import type {
  ExecutionConfig,
  ResearchConfig,
  TraderConfig,
} from "./config.js";

const EVALUATE_EVERY_MS = 5 * 60_000;
const RESUME_EVERY_MS = 15_000;
// The worker runs one job at a time: an RFQ that is not answered in this long is asked again later.
const RFQ_TIMEOUT_MS = 4000;
const RESUME_SOON_MS = 2000;

/** The public RFQ API with the trader's own key. Every failure is classified, none is thrown. */
export function traderQuoteApi(
  client: Pick<ReturnType<typeof createBlinkClient>, "requestQuote">,
  timeoutMs = RFQ_TIMEOUT_MS,
): TraderQuoteApi {
  return {
    async requestQuote(input, idempotencyKey) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const quote = await Promise.race([
          client.requestQuote(input, idempotencyKey),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("RFQ_TIMEOUT")),
              timeoutMs,
            );
          }),
        ]);
        return { ok: true, quote };
      } catch (error) {
        if (error instanceof BlinkApiError)
          return {
            ok: false,
            status: error.status,
            code: error.body.code,
            retryable: error.body.retryable,
          };
        // No answer, or one that is not an RFQ response: ask again with the same key later.
        return {
          ok: false,
          status: 0,
          code: "API_UNAVAILABLE",
          retryable: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The internal trader's worker side. Off unless WORKER_TRADER_API_KEY and
 * WORKER_TRADER_FORECASTER_ROLE are set; then it also needs the public API URL and the execution
 * configuration (a signer caller with the `trader` role, the RPC), because it buys through the API
 * and transacts through the restricted signer. It holds no key.
 */
export async function buildTrader(deps: {
  pool: Pool;
  queue: JobQueue;
  config: TraderConfig | null;
  api: ResearchConfig["api"];
  execution: ExecutionConfig | null;
}): Promise<{
  handlers: Partial<Record<JobType, JobHandler>>;
  tick(): Promise<void>;
}> {
  const { pool, queue, config, api, execution } = deps;
  if (!config) return { handlers: {}, tick: async () => {} };
  if (!api || !execution)
    throw new Error("WORKER_TRADER_CONFIGURATION_INCOMPLETE");
  await assertProductionClock(pool, false);
  await assertTraderInstalled(pool);
  const deployment = await loadChainDeployment(pool, execution.deploymentId);
  const reader = executionChainReader({
    url: execution.rpcUrl,
    marketAddress: deployment.marketAddress,
  });
  await reader.assertChain();
  const chain = chainSnapshotReader({
    client: createPublicClient({
      transport: http(execution.rpcUrl, { timeout: 5000, retryCount: 0 }),
      cacheTime: 0,
    }),
    market: deployment.marketAddress as Hex,
  });
  const store = postgresTraderStore(pool);
  // More than one mandate for the role is a configuration error: refuse it at startup.
  await store.mandate(config.forecasterRole);
  const trader = createTrader({
    store,
    api: traderQuoteApi(createBlinkClient(api.url, config.apiKey)),
    dispatcher: createTxDispatcher({
      store: postgresDispatchStore(pool),
      rpc: reader.guardDispatch(viemDispatchRpc({ url: execution.rpcUrl })),
      signer: signerClient({
        url: execution.signerUrl,
        token: execution.signerToken,
      }),
    }),
    chain,
    encodeCall: encodeAllowedCall,
    deploymentId: execution.deploymentId,
    role: config.forecasterRole,
    async track(intentId) {
      await queue.enqueue({
        type: "tx.dispatch",
        dedupeKey: "tx.dispatch:" + intentId,
        payload: { intentId },
        maxAttempts: 10,
      });
    },
    // A run that ran out of time leaves its pending buys to a run at most one bucket later.
    async resume() {
      const now = new Date(
        (await pool.query("SELECT blink.now() AS now")).rows[0].now,
      );
      await schedulePeriodic(
        queue,
        "trader.evaluate",
        RESUME_SOON_MS,
        { resume: "soon" },
        now,
      );
    },
  });
  return {
    handlers: { "trader.evaluate": createTraderHandler(trader) },
    async tick() {
      const now = new Date(
        (await pool.query("SELECT blink.now() AS now")).rows[0].now,
      );
      await schedulePeriodic(
        queue,
        "trader.evaluate",
        EVALUATE_EVERY_MS,
        {},
        now,
      );
      // After each forecast window closes: one job per window, whenever a tick first sees it.
      const closed = await pool.query(
        `SELECT id FROM forecasts.windows WHERE deployment_id=$1
        AND deadline<=blink.now() AND deadline>blink.now()-interval '10 minutes'`,
        [execution.deploymentId],
      );
      for (const row of closed.rows)
        await queue.enqueue({
          type: "trader.evaluate",
          dedupeKey: "trader.evaluate:window:" + row.id,
          payload: { windowId: row.id },
          maxAttempts: 5,
        });
      // A buy in flight is carried on every tick rather than at the next five-minute run.
      const inFlight = await pool.query(
        "SELECT 1 FROM trading.risk_reservations WHERE deployment_id=$1 AND state='HELD' LIMIT 1",
        [execution.deploymentId],
      );
      if (inFlight.rows.length)
        await schedulePeriodic(
          queue,
          "trader.evaluate",
          RESUME_EVERY_MS,
          { resume: true },
          now,
        );
    },
  };
}
