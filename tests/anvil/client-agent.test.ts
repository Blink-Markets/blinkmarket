import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { bytesToHex, hashTypedData } from "viem";
import { runAgent } from "../../examples/agent/run.ts";
import { createBlinkClient } from "../../packages/client/src/index.ts";
import { quoteTypes, type QuoteFields } from "../../packages/schemas/src/index.ts";
import { quoteStruct, startRfqStack, type RfqStack } from "../helpers/rfq-stack.ts";

const QUANTITY = "10";
const PRICE_BPS = "4000";
const POLL_MS = 100;

/**
 * The read routes of Task 7 (`/v1/deployment`, `/v1/markets`, `/v1/markets/:id`) are not part of
 * this branch's API. This front forwards every request to the real API and, only when the API
 * itself refuses (no such route, or the retired v0.1 route of the same path), answers from the
 * same indexed state the real routes would read. Rerun this suite against the API with Task 7 merged: the shim then
 * never fires (`shimmed` stays empty), which the test reports.
 */
async function frontWithReadShim(stack: RfqStack, shimmed: Set<string>) {
  const index = () => stack.publicReader.health();
  const shim = async (path: string, query: URLSearchParams): Promise<unknown | undefined> => {
    if (path === "/v1/deployment") return { ...stack.d, index: await index() };
    if (path === "/v1/markets") {
      const state = query.get("state");
      const page = await stack.publicReader.markets({
        ...(state ? { states: [state as never] } : {}),
        limit: 100,
      });
      return { ...page, index: await index() };
    }
    const one = /^\/v1\/markets\/([0-9]+)$/.exec(path);
    if (one) {
      const market = await stack.publicReader.market(one[1]!);
      return market ? { ...market, index: await index() } : undefined;
    }
    return undefined;
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", async () => {
      try {
        const url = new URL(request.url!, "http://127.0.0.1");
        const headers = new Headers();
        for (const [k, v] of Object.entries(request.headers))
          if (typeof v === "string" && k !== "host" && k !== "content-length") headers.set(k, v);
        const body = Buffer.concat(chunks);
        const upstream = await fetch(stack.apiUrl + request.url, {
          method: request.method!,
          headers,
          ...(body.length ? { body } : {}),
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        let answer: unknown;
        if (upstream.status >= 400 && request.method === "GET") {
          const parsed = JSON.parse(bytes.toString("utf8") || "{}") as { code?: string };
          // No such route, or the retired v0.1 route of the same path rejecting a request made for the new one.
          if (parsed.code === "NOT_FOUND" || parsed.code === "INVALID_REQUEST") {
            answer = await shim(url.pathname, url.searchParams);
            if (answer !== undefined) shimmed.add(url.pathname.replace(/[0-9]+$/, ":id"));
          }
        }
        if (answer !== undefined) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(answer));
          return;
        }
        response.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        });
        response.end(bytes);
      } catch (error) {
        response.writeHead(502);
        response.end(String(error));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test(
  "the taker example runs end to end against a local node, the relay and a maker the test drives",
  { timeout: 480_000 },
  async () => {
    const stack = await startRfqStack();
    const shimmed = new Set<string>();
    const front = await frontWithReadShim(stack, shimmed);
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
      const makerClient = createBlinkClient(front.url, await stack.keyFor(accounts.maker));

      const logLines: string[] = [];
      const agent = runAgent({
        apiUrl: front.url,
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
      // Which read routes were answered by the test's shim instead of the API (see above).
      console.log("read routes served by the test shim: " + ([...shimmed].join(", ") || "none"));
    } finally {
      await front.close();
      await stack.close();
    }
  },
);
