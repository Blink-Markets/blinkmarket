import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, getAbiItem, toFunctionSelector } from "viem";
import { runAgent } from "../../examples/agent/run.ts";
import { createBlinkClient } from "../../packages/client/src/index.ts";
import type { QuoteFields } from "../../packages/schemas/src/index.ts";
import { protocolAbi, startRfqStack } from "../helpers/rfq-stack.ts";
import { rpcFaultProxy, type SendFault } from "../helpers/rpc-fault-proxy.ts";

const POLL_MS = 100;
const FILL_SELECTOR = toFunctionSelector(
  getAbiItem({ abi: protocolAbi.markets, name: "fillQuote" }) as never,
);

/**
 * The example agent against a node whose first fill send fails in a way that leaves the outcome
 * unknown. Whatever the network does, the agent must end with exactly one fill.
 */
async function scenario(
  fault: (ctx: {
    quotes: QuoteFields[];
    mine: (timestamp: bigint) => Promise<void>;
    markSent: () => void;
  }) => SendFault,
  between: (ctx: {
    quotes: QuoteFields[];
    sent: () => boolean;
    mine: (timestamp: bigint) => Promise<void>;
  }) => Promise<void>,
) {
  const stack = await startRfqStack();
  let proxy: Awaited<ReturnType<typeof rpcFaultProxy>> | undefined;
  let running = true;
  try {
    const { accounts } = stack.anvil;
    await stack.onboard("admin", 0);
    await stack.onboard("maker", 1);
    await stack.onboard("proposer", 4);
    await stack.depositMaker("maker", 100_000_000n);
    await stack.stakeJurors();
    const market = await stack.createOpenMarket();
    await stack.sync();
    const makerClient = createBlinkClient(stack.apiUrl, await stack.keyFor(accounts.maker));

    const quotes: QuoteFields[] = [];
    let faultSent = false;
    const mine = async (timestamp: bigint) => {
      await stack.anvil.setNextTimestamp(timestamp);
      await stack.anvil.mine();
    };
    const ctx = { quotes, mine, markSent: () => void (faultSent = true) };
    let faulted = false;
    proxy = await rpcFaultProxy(stack.anvil.url, async (tx) => {
      const isFill = tx.to?.toLowerCase() === stack.markets.toLowerCase() && tx.data?.startsWith(FILL_SELECTOR);
      if (!isFill || faulted) return "pass";
      faulted = true;
      return fault(ctx)(tx);
    });
    const agent = runAgent({
      apiUrl: stack.apiUrl,
      privateKey: bytesToHex(accounts.taker.getHdKey().privateKey!),
      rpcUrl: proxy.url,
      pollMs: POLL_MS,
      waitMs: { indexing: 60_000, quotes: 30_000, final: 120_000, receipt: 30_000, settle: 60_000 },
      log: () => undefined,
    });
    const outcome = agent.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );

    // A maker bot that answers every RFQ once.
    const answered = new Set<string>();
    const bot = (async () => {
      while (running) {
        for (const rfq of (await makerClient.listRfqs()).items) {
          if (answered.has(rfq.rfqId)) continue;
          answered.add(rfq.rfqId);
          const quote = await stack.quoteFor(market, accounts.maker.address, rfq.taker as `0x${string}`, {
            priceBps: "4000",
            quantity: rfq.quantity,
            side: rfq.side === "YES" ? "0" : "1",
          });
          quotes.push(quote);
          await makerClient.postQuote(rfq.rfqId, { quote, signature: await stack.sign(accounts.maker, quote) });
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();

    await between({ quotes, sent: () => faultSent, mine });
    // The agent has one filled quote; settle the market so it can redeem.
    const fills = () =>
      stack.anvil.publicClient.getContractEvents({
        address: stack.markets,
        abi: protocolAbi.markets,
        eventName: "QuoteFilled",
        fromBlock: 0n,
      } as never);
    for (let i = 0; i < 300 && (await fills()).length === 0; i++)
      await new Promise((r) => setTimeout(r, POLL_MS));
    await stack.resolve(market);
    const done = await outcome;
    assert.ok("result" in done, "agent failed: " + ("error" in done ? String(done.error) : ""));
    running = false;
    await bot;
    return { result: done.result, fills: (await fills()).length, rfqs: answered.size };
  } finally {
    running = false;
    await proxy?.close();
    await stack.close();
  }
}

test(
  "a fill reported lost that lands just before expiry is not bought twice",
  { timeout: 300_000 },
  async () => {
    const run = await scenario(
      ({ quotes, mine }) => async () => {
        // The send fails as far as the agent can tell, and the node mines it a moment later, a few
        // seconds before the quote expires. The agent must wait for it, not buy again.
        await mine(BigInt(quotes.at(-1)!.expiresAt) - 5n);
        return "lose-answer-later" as const;
      },
      async () => undefined,
    );
    assert.equal(run.fills, 1);
    assert.equal(run.rfqs, 1);
    assert.equal(run.result.fillTxHash, "");
    assert.equal(run.result.payoutMicros, "10000000");
  },
);

test(
  "a fill that never reaches the node is replaced only after the quote has expired unused",
  { timeout: 300_000 },
  async () => {
    const run = await scenario(
      ({ markSent }) => () => {
        markSent();
        return "swallow" as const;
      },
      async ({ quotes, sent, mine }) => {
        while (!sent()) await new Promise((r) => setTimeout(r, POLL_MS));
        // Before expiry the agent must wait: no second RFQ may appear.
        await new Promise((r) => setTimeout(r, 2000));
        assert.equal(quotes.length, 1);
        await mine(BigInt(quotes[0]!.expiresAt));
      },
    );
    assert.equal(run.fills, 1);
    assert.equal(run.rfqs, 2);
  },
);
