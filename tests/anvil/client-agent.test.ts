import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, hashTypedData } from "viem";
import { runAgent } from "../../examples/agent/run.ts";
import { createBlinkClient } from "../../packages/client/src/index.ts";
import { quoteTypes, type QuoteFields } from "../../packages/schemas/src/index.ts";
import { quoteStruct, startRfqStack } from "../helpers/rfq-stack.ts";

const QUANTITY = "10";
const PRICE_BPS = "4000";
const POLL_MS = 100;

test(
  "the taker example runs end to end against a local node, the relay and a maker the test drives",
  { timeout: 480_000 },
  async () => {
    const stack = await startRfqStack();
    try {
      const { accounts } = stack.anvil;
      // The agent is the taker account; it starts with nothing and does its own onboarding.
      await stack.onboard("admin", 0);
      await stack.onboard("maker", 1);
      await stack.onboard("proposer", 4);
      await stack.depositMaker("maker", 100_000_000n);
      await stack.stakeJurors();
      const market = await stack.createOpenMarket();
      await stack.sync();
      const makerClient = createBlinkClient(stack.apiUrl, await stack.keyFor(accounts.maker));

      const logLines: string[] = [];
      const agent = runAgent({
        apiUrl: stack.apiUrl,
        privateKey: bytesToHex(accounts.taker.getHdKey().privateKey!),
        rpcUrl: stack.anvil.url,
        pollMs: POLL_MS,
        waitMs: { indexing: 60_000, quotes: 30_000, final: 120_000, receipt: 30_000 },
        log: (line) => logLines.push(line),
      });
      // Settle the agent's promise into a value so an early failure is reported, not left dangling.
      const outcome = agent.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

      // The maker: answer the first RFQ with a signed quote, as an external maker bot would.
      let quote: QuoteFields | undefined;
      const quoted = (async () => {
        for (;;) {
          const [rfq] = (await makerClient.listRfqs()).items;
          if (rfq) {
            quote = await stack.quoteFor(market, accounts.maker.address, rfq.taker as `0x${string}`, {
              priceBps: PRICE_BPS,
              quantity: rfq.quantity,
              side: rfq.side === "YES" ? "0" : "1",
            });
            await makerClient.postQuote(rfq.rfqId, {
              quote,
              signature: await stack.sign(accounts.maker, quote),
            });
            return;
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      })();
      const first = await Promise.race([quoted.then(() => "quoted" as const), outcome]);
      assert.equal(first, "quoted", JSON.stringify(first, (_, v) => (v instanceof Error ? v.message : v)));
      const digest = hashTypedData({
        domain: { name: "Blink RFQ", version: "0.2", chainId: 84532, verifyingContract: stack.markets },
        types: quoteTypes,
        primaryType: "Quote",
        message: quoteStruct(quote!),
      });

      // The agent verifies, approves and fills; wait for the fill on chain, then settle the market.
      for (let i = 0; i < 600 && !(await stack.mread<boolean>("consumed", [digest])); i++) {
        const early = await Promise.race([
          new Promise<undefined>((r) => setTimeout(() => r(undefined), POLL_MS)),
          outcome,
        ]);
        assert.equal(early, undefined, "the agent stopped before filling: " + JSON.stringify(early, (_, v) => (v instanceof Error ? v.message : v)));
      }
      assert.equal(await stack.mread("consumed", [digest]), true, "the quote was never filled");
      await stack.resolve(market);

      const done = await outcome;
      assert.ok("result" in done, "agent failed: " + ("error" in done ? String(done.error) : ""));
      const { result } = done;
      assert.equal(result.marketId, String(market.marketId));
      assert.equal(result.digest, digest);
      assert.equal(result.finalOutcome, "YES");
      assert.match(result.fillTxHash, /^0x[0-9a-f]{64}$/);
      assert.match(result.redeemTxHash, /^0x[0-9a-f]{64}$/);
      // 10 YES shares bought at 40% pay one bUSD each when YES wins.
      assert.equal(result.payoutMicros, "10000000");

      // The index agrees: the digest is consumed and the maker's stats show one relayed, filled quote.
      await stack.sync();
      assert.equal(await stack.publicReader.digest(digest), "CONSUMED");
      assert.deepEqual(await makerClient.getMakerStats(accounts.maker.address), {
        quotesRelayed: 1,
        quotesFilled: 1,
        quotesCancelledBeforeExpiry: 0,
      });
      assert.ok(logLines.some((l) => l.startsWith("claimed test bUSD")), logLines.join("\n"));
    } finally {
      await stack.close();
    }
  },
);
