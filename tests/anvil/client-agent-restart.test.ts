import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bytesToHex } from "viem";
import type { AgentContext } from "../../examples/agents/src/lib/env.ts";
import { createBlinkClient } from "../../packages/client/src/index.ts";
import type { QuoteFields } from "../../packages/schemas/src/index.ts";
import { protocolAbi, startRfqStack } from "../helpers/rfq-stack.ts";
import { runTrader } from "../helpers/trader-agent.ts";

const POLL_MS = 100;

type Checkpoint = "before-save" | "after-save" | "after-broadcast" | "after-receipt";

/**
 * Makes the first state save at `checkpoint` of a fill fail, as if the process died there. The
 * "after" checkpoints let the write through first. What is on disk afterwards is what a restarted
 * process would find.
 */
function crashAt(ctx: AgentContext, checkpoint: Checkpoint) {
  const { data } = ctx.state;
  const realSave = ctx.state.save;
  let crashed = false;
  ctx.state = {
    data,
    save: async () => {
      const pending = Object.values(data.fills)[0];
      const filled = (data.acted["trader.filled"] ?? []).length > 0;
      const reached =
        checkpoint === "before-save" || checkpoint === "after-save"
          ? pending !== undefined && pending.txHash === undefined
          : checkpoint === "after-broadcast"
            ? pending?.txHash !== undefined && !filled
            : filled;
      const hit = !crashed && reached;
      const crash = new Error(`CRASH_AT_${checkpoint.toUpperCase().replace("-", "_")}`);
      crashed ||= hit;
      // The "before" kinds die ahead of the write, the "after" kinds just behind it.
      if (hit && (checkpoint === "before-save" || checkpoint === "after-receipt")) throw crash;
      await realSave();
      if (hit) throw crash;
    },
  };
}

/**
 * The trader is stopped at a checkpoint of its fill and started again on the same state directory.
 * Whatever the checkpoint, the market ends with exactly one fill.
 */
async function scenario(checkpoint: Checkpoint) {
  const stack = await startRfqStack();
  const stateDir = await mkdtemp(join(tmpdir(), "blink-trader-restart-"));
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
    const fills = () =>
      stack.anvil.publicClient.getContractEvents({
        address: stack.markets,
        abi: protocolAbi.markets,
        eventName: "QuoteFilled",
        fromBlock: 0n,
      } as never);
    const config = {
      apiUrl: stack.apiUrl,
      privateKey: bytesToHex(accounts.taker.getHdKey().privateKey!),
      rpcUrl: stack.anvil.url,
      pollMs: POLL_MS,
      trader: { waitMs: { quotes: 30_000, receipt: 30_000, settle: 60_000 } },
      stateDir,
    };

    // First process: dies at the checkpoint.
    await assert.rejects(
      runTrader({ ...config, prepare: (ctx) => crashAt(ctx, checkpoint) }),
      /CRASH_AT_/,
    );
    const firstFills = (await fills()).length;
    assert.equal(firstFills, checkpoint === "before-save" || checkpoint === "after-save" ? 0 : 1);

    // Second process: a new context built from the saved state directory.
    const restarted = runTrader(config).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    if (checkpoint === "after-save") {
      // The fill was never sent, but the quote might still be good: no replacement RFQ before it expires.
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(answered.size, 1, "a replacement RFQ was posted before the quote expired");
      // The relay's clock is chain time as of the last index sync: sync one second short of expiry,
      // so the replacement RFQ does not open on a stale clock.
      const expiresAt = BigInt(quotes[0]!.expiresAt);
      await stack.anvil.setNextTimestamp(expiresAt - 1n);
      await stack.anvil.mine();
      await stack.sync();
      await stack.anvil.setNextTimestamp(expiresAt);
      await stack.anvil.mine();
    }
    for (let i = 0; i < 600 && (await fills()).length === 0; i++) {
      const early = await Promise.race([new Promise<undefined>((r) => setTimeout(() => r(undefined), POLL_MS)), restarted]);
      assert.equal(early, undefined, "the restarted trader stopped: " + JSON.stringify(early, (_, v) => (v instanceof Error ? v.message : v)));
    }
    await stack.resolve(market);
    const done = await restarted;
    assert.ok("result" in done, "restart failed: " + ("error" in done ? String(done.error) : ""));
    running = false;
    await bot;
    return { result: done.result, fills: (await fills()).length, rfqs: answered.size };
  } finally {
    running = false;
    await rm(stateDir, { recursive: true, force: true });
    await stack.close();
  }
}

for (const [checkpoint, rfqs] of [
  // Nothing was recorded or sent, so a new RFQ is legitimate.
  ["before-save", 2],
  // Recorded, not sent: the quote is replaced only after it has expired unused.
  ["after-save", 2],
  // Sent, or sent and landed: the one fill is found, never replaced.
  ["after-broadcast", 1],
  ["after-receipt", 1],
] as const)
  test(
    `a trader restarted ${checkpoint.replace("-", " ")} its fill ends with exactly one fill`,
    { timeout: 300_000 },
    async () => {
      const run = await scenario(checkpoint);
      assert.equal(run.fills, 1);
      assert.equal(run.rfqs, rfqs);
      assert.equal(run.result.payoutMicros, "10000000");
      assert.equal(run.result.finalOutcome, "YES");
    },
  );
