import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bytesToHex } from "viem";
import { createContext } from "../../examples/agents/src/lib/env.ts";
import { createLogger } from "../../examples/agents/src/lib/log.ts";
import type { Model } from "../../examples/agents/src/lib/model.ts";
import { onboard } from "../../examples/agents/src/lib/session.ts";
import { createTrader } from "../../examples/agents/src/roles/trader.ts";
import { createBlinkClient } from "../../packages/client/src/index.ts";
import { protocolAbi, startRfqStack } from "../helpers/rfq-stack.ts";

const POLL_MS = 100;
const VIEW_BPS = 7000;
/** The model's worth of a YES share minus the best price: the least edge the trader trades on. */
const MIN_EDGE_BPS = 500;

type Line = { event: string; [field: string]: unknown };

/**
 * The default trader never fills a market it has no valuation for, and holds every quote against
 * the model's view: an edge of 499 bps is passed on, one of exactly 500 bps is filled.
 */
test(
  "the trader fills only where its model has a view and the best quote leaves 500 bps",
  { timeout: 300_000 },
  async () => {
    const stack = await startRfqStack();
    const stateDir = await mkdtemp(join(tmpdir(), "blink-trader-edge-"));
    let running = true;
    try {
      const { accounts } = stack.anvil;
      await stack.onboard("admin", 0);
      await stack.onboard("maker", 1);
      await stack.depositMaker("maker", 100_000_000n);
      await stack.stakeJurors();
      await stack.sync();
      const makerClient = createBlinkClient(stack.apiUrl, await stack.keyFor(accounts.maker));

      // The maker bot quotes every RFQ at the price set for its market, and none that has no price.
      const prices = new Map<string, string>();
      const known = new Map<string, { marketId: bigint; specHash: `0x${string}` }>();
      const answered = new Set<string>();
      const bot = (async () => {
        while (running) {
          for (const rfq of (await makerClient.listRfqs()).items) {
            const market = known.get(rfq.marketId);
            const priceBps = prices.get(rfq.marketId);
            if (answered.has(rfq.rfqId) || !market || priceBps === undefined) continue;
            answered.add(rfq.rfqId);
            const quote = await stack.quoteFor(market, accounts.maker.address, rfq.taker as `0x${string}`, {
              priceBps,
              quantity: rfq.quantity,
              side: rfq.side === "YES" ? "0" : "1",
            });
            await makerClient.postQuote(rfq.rfqId, { quote, signature: await stack.sign(accounts.maker, quote) });
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      })();
      const open = async (readable: boolean) => {
        const market = await stack.createOpenMarket(600n, readable, 50n);
        known.set(String(market.marketId), market);
        await stack.sync();
        return market;
      };
      const fills = async () =>
        (await stack.anvil.publicClient.getContractEvents({
          address: stack.markets,
          abi: protocolAbi.markets,
          eventName: "QuoteFilled",
          fromBlock: 0n,
        } as never)) as unknown as { args: { priceBps: number } }[];

      // One trader identity for all three cases. Its view is set by the case.
      let view: number | null = null;
      const model: Model = {
        questions: async () => [],
        fromSuggestion: async () => null,
        probabilityBps: async () => view,
        outcome: async () => null,
        creationObjection: async () => null,
        appeal: async () => false,
      };
      const key = bytesToHex(accounts.taker.getHdKey().privateKey!);
      const lines: Line[] = [];
      const ctx = await createContext(
        { name: "trader", roles: ["trader"], apiUrl: stack.apiUrl, rpcUrl: stack.anvil.url, key, worldPath: "", stateDir },
        { model, log: createLogger("trader", [key], (line) => lines.push(JSON.parse(line) as Line)), pollingIntervalMs: POLL_MS },
      );
      await onboard(ctx);
      const trade = createTrader({ pollMs: POLL_MS, waitMs: { quotes: 20_000, receipt: 30_000, settle: 30_000, grace: 500 } });
      const events = (name: string) => lines.filter((l) => l.event === name);
      const rfqs = async () => (await makerClient.listRfqs()).items.length;

      // Unreadable content: no view to hold a price against, so no RFQ and no fill, however good the price.
      const unreadable = await open(false);
      prices.set(String(unreadable.marketId), "1000");
      view = VIEW_BPS;
      await trade(ctx);
      assert.equal(events("rfq_posted").length, 0);
      assert.equal(await rfqs(), 0);

      // A readable market the model has no view on: the same.
      const unknown = await open(true);
      prices.set(String(unknown.marketId), "1000");
      view = null;
      await trade(ctx);
      assert.equal(events("rfq_posted").length, 0);
      assert.equal(await rfqs(), 0);
      assert.equal((await fills()).length, 0);

      // 499 bps of edge: the quote is verified, then passed on.
      view = VIEW_BPS;
      prices.set(String(unknown.marketId), String(VIEW_BPS - MIN_EDGE_BPS + 1));
      await trade(ctx); // joins TAKER; the index must show the role before an RFQ is accepted
      await stack.sync();
      await trade(ctx);
      assert.equal(events("rfq_posted").length, 1);
      assert.deepEqual(events("no_edge").map((l) => [l.marketId, l.priceBps]), [[String(unknown.marketId), String(VIEW_BPS - MIN_EDGE_BPS + 1)]]);
      assert.equal(events("fill_sent").length, 0);
      assert.equal((await fills()).length, 0);

      // Exactly 500 bps: filled, at the quoted price. (The unreadable market is still skipped.)
      const fair = await open(true);
      prices.set(String(fair.marketId), String(VIEW_BPS - MIN_EDGE_BPS));
      await trade(ctx);
      const filled = await fills();
      assert.equal(filled.length, 1);
      assert.equal(filled[0]!.args.priceBps, VIEW_BPS - MIN_EDGE_BPS);
      assert.deepEqual(events("filled").map((l) => l.marketId), [String(fair.marketId)]);
      assert.equal(events("rfq_posted").length, 2);
    } finally {
      running = false;
      await rm(stateDir, { recursive: true, force: true });
      await stack.close();
    }
  },
);
