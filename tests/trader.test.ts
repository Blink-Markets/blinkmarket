import { test } from "node:test";
import assert from "node:assert/strict";
import { traderConfig } from "../apps/worker/src/config.js";
import { traderQuoteApi } from "../apps/worker/src/trader.js";
import { BlinkApiError } from "../packages/client/src/index.js";
import {
  createTraderHandler,
  traderIntentId,
} from "../packages/application/src/trader.js";
import { quoteTypedData } from "../packages/application/src/signer.js";
import { parseQuoteMessage } from "../packages/domain/src/signing-policy.js";
import type {
  TraderQuoteResult,
  TraderSignedQuote,
} from "../packages/ports/src/index.js";
import { DEPLOYMENT, HEAD_NUMBER } from "./helpers/trading.js";
import { inviteAgent } from "./helpers/database.js";
import { poolAs } from "./helpers/research.js";
import { testAccounts } from "./helpers/signer-fixture.js";
import { traderWorld, type TraderWorld } from "./helpers/trader.js";

const intentOf = (w: TraderWorld, windowId: string) =>
  traderIntentId({
    agentId: w.agent.agentId,
    deploymentId: DEPLOYMENT,
    marketId: "1",
    windowId,
  });
// Outstanding quotes and held collateral are the API's limits, not the trader's: clear them so a
// test can ask for many quotes.
const freeMaker = async (w: TraderWorld) => {
  await w.query("UPDATE trading.quotes SET status='EXPIRED'");
  await w.query("UPDATE trading.collateral_reservations SET state='RELEASED'");
};

test("trader configuration is off, complete, or refused", () => {
  assert.equal(traderConfig({}), null);
  assert.deepEqual(
    traderConfig({
      WORKER_TRADER_API_KEY: " blink_key ",
      WORKER_TRADER_FORECASTER_ROLE: "FORECASTER_B",
    }),
    { apiKey: "blink_key", forecasterRole: "FORECASTER_B" },
  );
  assert.throws(
    () => traderConfig({ WORKER_TRADER_API_KEY: "blink_key" }),
    /WORKER_TRADER_CONFIGURATION_INCOMPLETE/,
  );
  assert.throws(
    () => traderConfig({ WORKER_TRADER_FORECASTER_ROLE: "FORECASTER_A" }),
    /WORKER_TRADER_CONFIGURATION_INCOMPLETE/,
  );
  assert.throws(
    () =>
      traderConfig({
        WORKER_TRADER_API_KEY: "blink_key",
        WORKER_TRADER_FORECASTER_ROLE: "BASELINE",
      }),
    /INVALID_WORKER_TRADER_FORECASTER_ROLE/,
  );
});

test("a buy is named by mandate, market and window, and is a UUID", () => {
  const input = {
    agentId: "5d9f8f4a-1111-4222-8333-444455556666",
    deploymentId: "d",
    marketId: "1",
    windowId: "6d9f8f4a-1111-4222-8333-444455556666",
  };
  const id = traderIntentId(input);
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(traderIntentId(input), id);
  for (const patch of [
    { agentId: "7d9f8f4a-1111-4222-8333-444455556666" },
    { deploymentId: "e" },
    { marketId: "2" },
    { windowId: "7d9f8f4a-1111-4222-8333-444455556666" },
  ])
    assert.notEqual(traderIntentId({ ...input, ...patch }), id);
});

test("the RFQ client adapter classifies every failure and never throws", async () => {
  const body = (retryable: boolean) => ({
    code: "NO_QUOTE" as const,
    message: "x",
    requestId: "r",
    retryable,
    details: {},
  });
  const input = {
    deploymentId: DEPLOYMENT,
    marketId: "1",
    side: "YES" as const,
    quantity: "10",
    maxCostMicros: "6700000",
  };
  const through = (fail: () => Promise<never>, timeoutMs?: number) =>
    traderQuoteApi({ requestQuote: fail } as never, timeoutMs).requestQuote(
      input,
      "k",
    );
  assert.deepEqual(
    await through(async () => {
      throw new BlinkApiError(409, body(false));
    }),
    { ok: false, status: 409, code: "NO_QUOTE", retryable: false },
  );
  assert.deepEqual(
    await through(async () => {
      throw new BlinkApiError(503, {
        ...body(true),
        code: "SERVICE_NOT_READY",
      });
    }),
    { ok: false, status: 503, code: "SERVICE_NOT_READY", retryable: true },
  );
  const unavailable = {
    ok: false,
    status: 0,
    code: "API_UNAVAILABLE",
    retryable: true,
  };
  assert.deepEqual(
    await through(async () => {
      throw new TypeError("fetch failed");
    }),
    unavailable,
  );
  // An API that never answers must not hold the job's lease.
  assert.deepEqual(
    await through(() => new Promise<never>(() => {}), 20),
    unavailable,
  );
});

test("an edge above the threshold buys: exact approve, then the verified fill, risk held", async () => {
  const w = await traderWorld();
  try {
    const run = await w.run();
    const intentId = intentOf(w, w.windowId!);
    assert.deepEqual(run.markets, { "1": "RESERVED" });
    assert.deepEqual(run.trades, { [intentId]: "FILL_INCLUDED" });
    // own 0.80 against an ask of 0.67 (ensemble 0.65 plus the 200 bps spread).
    assert.deepEqual(await w.reservations(), [
      {
        state: "HELD",
        side: "YES",
        shares: 10,
        ask_bps: 6700,
        release_reason: null,
        notional_micros: "10000000",
      },
    ]);
    assert.equal(w.apiCalls.length, 1);
    assert.deepEqual(w.apiCalls[0]!.input, {
      deploymentId: DEPLOYMENT,
      marketId: "1",
      side: "YES",
      quantity: "10",
      maxCostMicros: "6700000",
    });
    assert.equal(w.apiCalls[0]!.key, "trader-" + intentId);
    assert.deepEqual(w.dispatcher.kinds(), ["APPROVE", "FILL"]);
    const requests = await w.query<{
      kind: string;
      unsigned_payload: { to: string; functionName: string; args: unknown[] };
    }>(
      `SELECT i.kind,r.unsigned_payload FROM signing.sign_requests r
      JOIN signing.economic_intents i ON i.id=r.intent_id WHERE i.role='trader' ORDER BY i.created_at,i.id`,
    );
    assert.deepEqual(
      requests.map((r) => Object.keys(r.unsigned_payload).sort()),
      [
        ["args", "functionName", "to"],
        ["args", "functionName", "to"],
      ],
      "only the signer's {to, functionName, args} shape",
    );
    // The allowance is exactly the taker cost, to the market, on the token.
    assert.deepEqual(requests[0]!.unsigned_payload, {
      to: w.manifest.contracts.BlinkTestUSD.toLowerCase(),
      functionName: "approve",
      args: [w.manifest.contracts.BlinkMarket.toLowerCase(), "6700000"],
    });
    assert.equal(requests[1]!.unsigned_payload.functionName, "fillQuote");
    assert.equal(
      requests[1]!.unsigned_payload.to,
      w.manifest.contracts.BlinkMarket.toLowerCase(),
    );
    // Both transactions are watched to finality after the trader stops waiting for them.
    assert.equal(w.tracked.length, 2);
  } finally {
    await w.close();
  }
});

test("a NO edge buys NO, and an edge exactly at the threshold does not trade", async () => {
  const exact = await traderWorld({ a: 0.68, b: 0.54 });
  try {
    // ensemble 0.61 + 200 bps = ask 0.63; own 0.68 is exactly 500 bps above it.
    const run = await exact.run();
    assert.deepEqual(run.markets, { "1": "NO_EDGE" });
    assert.deepEqual(await exact.reservations(), []);
    assert.equal(exact.apiCalls.length, 0);
    // The smallest probability step above the threshold trades.
    await exact.seedWindow({ a: 0.680001, b: 0.539999, hoursAgo: 0 });
    assert.equal((await exact.run()).markets["1"], "RESERVED");
    assert.equal((await exact.reservations())[0]!.side, "YES");
    assert.equal((await exact.reservations())[0]!.ask_bps, 6300);
  } finally {
    await exact.close();
  }
  const no = await traderWorld({ a: 0.2, b: 0.5 });
  try {
    // ensemble 0.35: YES ask 0.37, NO ask 0.67; own NO probability 0.80.
    assert.equal((await no.run()).markets["1"], "RESERVED");
    assert.deepEqual(
      (await no.reservations()).map((r) => [r.side, r.ask_bps]),
      [["NO", 6700]],
    );
    assert.deepEqual(no.apiCalls[0]!.input.side, "NO");
    assert.equal(no.apiCalls[0]!.input.maxCostMicros, "6700000");
  } finally {
    await no.close();
  }
});

test("every stop condition keeps the trader out of the market", async () => {
  const w = await traderWorld({ window: false });
  try {
    const q = <R = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      w.query<R>(sql, params);
    const fresh = () => w.setCursor({ number: HEAD_NUMBER, timestamp: w.ts });
    const idle = async (reason: string, label: string) => {
      const run = await w.run();
      assert.equal(run.markets["1"], reason, label);
      assert.deepEqual(await w.reservations(), [], label);
      assert.equal(w.apiCalls.length, 0, label);
    };
    // No forecast: none at all, one that closed more than 24 hours ago, one that is contaminated.
    await idle("NO_FORECAST", "no window");
    await w.seedWindow({ hoursAgo: 25 });
    await idle("NO_FORECAST", "stale window");
    const contaminated = await w.seedWindow({ hoursAgo: 1 });
    await q(
      `INSERT INTO forecasts.annotations(id,submission_id,kind,reason,actor)
      SELECT gen_random_uuid(),id,'WINDOW_CONTAMINATED','answer already public','test'
      FROM forecasts.submissions WHERE window_id=$1 LIMIT 1`,
      [contaminated],
    );
    await idle("NO_FORECAST", "annotated window");
    await w.seedWindow({ a: 0.8, b: 0.5, hoursAgo: 0 });

    const closeAt = String(w.ts + 100_000n);
    const cases: [
      string,
      () => Promise<unknown>,
      string,
      () => Promise<unknown>,
    ][] = [
      [
        "market not OPEN",
        () => q("UPDATE chain.markets SET state='PROPOSED'"),
        "MARKET_CLOSED",
        () => q("UPDATE chain.markets SET state='OPEN'"),
      ],
      [
        "close reached on block time",
        () => w.setCursor({ number: HEAD_NUMBER, timestamp: w.ts + 100_000n }),
        "MARKET_CLOSED",
        fresh,
      ],
      [
        "close reached on the business clock only",
        async () => {
          await q("UPDATE chain.markets SET close_at=$1", [String(w.ts + 1n)]);
          await w.setDbClock(10);
          await fresh();
        },
        "MARKET_CLOSED",
        async () => {
          await q("UPDATE chain.markets SET close_at=$1", [closeAt]);
          await w.setDbClock(0);
          await fresh();
        },
      ],
      [
        "quote gate open",
        () =>
          q(
            `INSERT INTO trading.quote_gates(id,deployment_id,market_id,reason,actor,note)
            VALUES(gen_random_uuid(),$1,1,'OUTCOME_KNOWN','test','outcome is public')`,
            [DEPLOYMENT],
          ),
        "OUTCOME_KNOWN",
        () =>
          q(
            "UPDATE trading.quote_gates SET reopened_at=blink.now(),reopened_by='test'",
          ),
      ],
      [
        "indexer silent for more than 10 seconds",
        () => w.setDbClock(30),
        "INDEXER_LAG",
        async () => {
          await w.setDbClock(0);
          await fresh();
        },
      ],
      [
        "indexer gated",
        () =>
          w.setCursor({
            number: HEAD_NUMBER,
            timestamp: w.ts,
            gate: "REORG_IN_PROGRESS",
          }),
        "INDEXER_LAG",
        fresh,
      ],
      [
        "indexer more than 3 blocks behind the head",
        () =>
          w.setCursor({
            number: HEAD_NUMBER,
            timestamp: w.ts,
            headNumber: HEAD_NUMBER + 4n,
          }),
        "INDEXER_LAG",
        fresh,
      ],
      [
        "no cursor at all",
        () => q("DELETE FROM chain.cursors"),
        "INDEXER_LAG",
        fresh,
      ],
      [
        "trading paused globally",
        () => q("UPDATE chain.maker_state SET global_paused=true"),
        "TRADING_PAUSED",
        () => q("UPDATE chain.maker_state SET global_paused=false"),
      ],
      [
        "market paused",
        () => q("UPDATE chain.markets SET paused=true"),
        "TRADING_PAUSED",
        () => q("UPDATE chain.markets SET paused=false"),
      ],
      [
        "maker pool gated",
        () =>
          q(
            `INSERT INTO trading.maker_pools(deployment_id,gate_reason) VALUES($1,'OVERCOMMITTED')
            ON CONFLICT (deployment_id) DO UPDATE SET gate_reason='OVERCOMMITTED'`,
            [DEPLOYMENT],
          ),
        "SERVICE_NOT_READY",
        () => q("UPDATE trading.maker_pools SET gate_reason=NULL"),
      ],
      [
        "wallet not allowed to take",
        () => q("UPDATE chain.takers SET allowed=false"),
        "TAKER_NOT_ALLOWED",
        () => q("UPDATE chain.takers SET allowed=true"),
      ],
      [
        "deployment disabled",
        () => q("UPDATE markets.deployments SET enabled=false"),
        "TRADING_DISABLED",
        () => q("UPDATE markets.deployments SET enabled=true"),
      ],
      [
        "manifest trading off",
        () =>
          q(
            "UPDATE markets.deployments SET manifest=jsonb_set(manifest,'{tradingEnabled}','false')",
          ),
        "TRADING_DISABLED",
        () =>
          q(
            "UPDATE markets.deployments SET manifest=jsonb_set(manifest,'{tradingEnabled}','true')",
          ),
      ],
    ];
    for (const [label, apply, reason, revert] of cases) {
      await apply();
      await idle(reason, label);
      await revert();
    }
    // The mandate switch stops the whole run.
    await q("UPDATE trading.mandates SET enabled=false");
    const off = await w.run();
    assert.equal(off.stopped, "MANDATE_DISABLED");
    assert.deepEqual(off.markets, {});
    assert.deepEqual(await w.reservations(), []);
    await q("UPDATE trading.mandates SET enabled=true");
    // With every condition cleared, the same state buys: the conditions were the only reason.
    assert.equal((await w.run()).markets["1"], "RESERVED");
  } finally {
    await w.close();
  }
});

test("the mandate's limits admit exactly the cap and skip the rest with one audit row", async () => {
  const w = await traderWorld();
  try {
    const q = <R = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      w.query<R>(sql, params);
    const audits = () =>
      q<{ reason: string }>(
        "SELECT reason FROM operations.audit_log WHERE action='trader.skipped' ORDER BY created_at",
      );
    assert.equal((await w.run()).markets["1"], "RESERVED");

    // Daily cap: 10 bUSD already occupied, a second buy of 10 does not fit under 15.
    await q("UPDATE trading.mandates SET daily_notional_cap_micros=15000000");
    await w.seedWindow({ hoursAgo: 0 });
    assert.equal((await w.run()).markets["1"], "SKIPPED:DAILY_CAP_EXCEEDED");
    assert.equal((await w.run()).markets["1"], "SKIPPED:DAILY_CAP_EXCEEDED");
    assert.deepEqual(await audits(), [{ reason: "DAILY_CAP_EXCEEDED" }]);
    assert.equal((await w.reservations()).length, 1);
    assert.equal(w.apiCalls.length, 1, "a skipped buy never reaches the RFQ");

    // Open cap: HELD counts, ACCOUNTED does not (it is a position now), the daily cap still does.
    await q(
      "UPDATE trading.mandates SET daily_notional_cap_micros=100000000, open_notional_cap_micros=15000000",
    );
    assert.equal((await w.run()).markets["1"], "SKIPPED:OPEN_CAP_EXCEEDED");
    await w.fillDigest();
    await q("UPDATE trading.mandates SET daily_notional_cap_micros=15000000");
    assert.equal(
      (await w.run()).markets["1"],
      "SKIPPED:DAILY_CAP_EXCEEDED",
      "the accounted fill is out of the open cap but still in the day's",
    );
    await q("UPDATE trading.mandates SET daily_notional_cap_micros=100000000");
    const freed = await w.run();
    assert.equal(freed.markets["1"], "RESERVED", "the fill freed the open cap");
    assert.deepEqual(
      (await w.reservations()).map((r) => r.state),
      ["ACCOUNTED", "HELD"],
    );

    // A fill larger than the mandate allows.
    await q("UPDATE trading.mandates SET max_fill_shares=5");
    await w.seedWindow({ hoursAgo: 0 });
    assert.equal(
      (await w.run()).markets["1"],
      "SKIPPED:SHARES_EXCEED_MAX_FILL",
    );
    assert.deepEqual(
      (await audits()).map((a) => a.reason),
      ["DAILY_CAP_EXCEEDED", "OPEN_CAP_EXCEEDED", "SHARES_EXCEED_MAX_FILL"],
    );
  } finally {
    await w.close();
  }
});

test("only today's buys count against the daily cap, and the limits are read under the lock", async () => {
  const w = await traderWorld();
  try {
    const q = <R = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      w.query<R>(sql, params);
    await q(
      `INSERT INTO trading.risk_reservations(id,agent_id,intent_id,day,notional_micros,state,deployment_id,market_id,
        window_id,side,shares,ask_bps,own_probability_millionths)
      VALUES (gen_random_uuid(),$1,gen_random_uuid(),(blink.now() AT TIME ZONE 'UTC')::date - 1,100000000,'ACCOUNTED',$2,1,$3,'YES',100,6700,800000)`,
      [w.agent.agentId, DEPLOYMENT, w.windowId],
    );
    await q("UPDATE trading.mandates SET daily_notional_cap_micros=10000000");
    const mandate = (await w.store.mandate("FORECASTER_A"))!;
    assert.equal(
      (await w.run()).markets["1"],
      "RESERVED",
      "yesterday's 100 bUSD is not today's",
    );
    // The mandate was switched off after a caller loaded it: the stored value decides.
    await q("UPDATE trading.mandates SET enabled=false");
    const stale = await w.store.reserve({
      mandate,
      intentId: "00000000-0000-4000-8000-000000000001",
      deploymentId: DEPLOYMENT,
      marketId: "1",
      windowId: w.windowId!,
      side: "YES",
      shares: 1,
      askBps: 6700,
      ownProbabilityMillionths: 800_000,
    });
    assert.deepEqual(stale, { state: "SKIPPED", reason: "MANDATE_DISABLED" });
  } finally {
    await w.close();
  }
});

test("a window is bought once, and a retry after a transient RFQ failure reuses the same key", async () => {
  const w = await traderWorld();
  try {
    w.chain.state.headFails = true;
    const first = await w.run();
    const id = intentOf(w, w.windowId!);
    assert.deepEqual(first.trades, { [id]: "WAITING:RFQ:CHAIN_UNAVAILABLE" });
    assert.deepEqual(
      (await w.reservations()).map((r) => r.state),
      ["HELD"],
    );
    assert.deepEqual(w.dispatcher.calls, []);

    w.chain.state.headFails = false;
    const second = await w.run();
    assert.deepEqual(second.markets, { "1": "DECIDED:HELD" });
    assert.deepEqual(second.trades, { [id]: "FILL_INCLUDED" });
    assert.deepEqual(
      w.apiCalls.map((c) => c.key),
      ["trader-" + id, "trader-" + id],
    );
    const quotes = await w.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM trading.quotes",
    );
    assert.equal(quotes[0]!.n, "1", "one quote under the one key");

    // Done: the window is not bought again, and the stored quote is used without asking the API.
    const third = await w.run();
    assert.deepEqual(third.markets, { "1": "DECIDED:HELD" });
    assert.equal(w.apiCalls.length, 2);
    assert.deepEqual(w.dispatcher.kinds(), ["APPROVE", "FILL"]);
  } finally {
    await w.close();
  }
});

test("a terminal rejection releases the risk for good; an RFQ with no answer is never given back for being late", async () => {
  const w = await traderWorld();
  try {
    // The projection says the wallet may take but the contract view says it may not.
    w.chain.state.view.takerAllowed = false;
    const run = await w.run();
    const id = intentOf(w, w.windowId!);
    assert.deepEqual(run.trades, { [id]: "RELEASED:RFQ_REJECTED:NO_QUOTE" });
    assert.deepEqual(await w.reservations(), [
      {
        state: "RELEASED",
        side: "YES",
        shares: 10,
        ask_bps: 6700,
        release_reason: "RFQ_REJECTED:NO_QUOTE",
        notional_micros: "10000000",
      },
    ]);
    // The same window is not tried again, but the capacity is free for the next one.
    assert.deepEqual((await w.run()).markets, { "1": "DECIDED:RELEASED" });
    w.chain.state.view.takerAllowed = true;
    await w.seedWindow({ hoursAgo: 0 });
    assert.equal((await w.run()).markets["1"], "RESERVED");
    assert.deepEqual(
      (await w.reservations()).map((r) => r.state),
      ["RELEASED", "HELD"],
    );
  } finally {
    await w.close();
  }
  const slow = await traderWorld();
  try {
    slow.chain.state.headFails = true;
    await slow.run();
    // 200 seconds on the business clock, with the indexer still fresh at that time: the answer is
    // late, which is not a definitive failure, so the same RFQ is asked again under the same key.
    await slow.setDbClock(200);
    await slow.setCursor({ number: HEAD_NUMBER, timestamp: slow.ts });
    const id = intentOf(slow, slow.windowId!);
    const late = await slow.run();
    assert.deepEqual(late.trades, { [id]: "WAITING:RFQ:CHAIN_UNAVAILABLE" });
    assert.deepEqual(
      (await slow.reservations()).map((r) => r.state),
      ["HELD"],
    );
    assert.ok(slow.resumes.count >= 1, "and a resume run is asked for");
    slow.chain.state.headFails = false;
    assert.deepEqual((await slow.run()).trades, { [id]: "FILL_INCLUDED" });
    assert.deepEqual(
      slow.apiCalls.map((c) => c.key),
      Array(3).fill("trader-" + id),
    );
    assert.deepEqual(slow.dispatcher.kinds(), ["APPROVE", "FILL"]);

    // What is definitive without any answer: the market has closed on block time, so no quote
    // that could still be filled can exist.
    const closing = await traderWorld();
    try {
      closing.chain.state.headFails = true;
      await closing.run();
      await closing.setCursor({
        number: HEAD_NUMBER,
        timestamp: closing.ts + 100_000n,
      });
      assert.deepEqual(Object.values((await closing.run()).trades), [
        "RELEASED:MARKET_CLOSED",
      ]);
      assert.equal(closing.apiCalls.length, 1, "it was not asked again");
    } finally {
      await closing.close();
    }
  } finally {
    await slow.close();
  }
});

test("an envelope that is not exactly what was asked for is refused before anything is signed", async () => {
  type Rewrite = (
    q: TraderSignedQuote,
  ) => TraderSignedQuote | Promise<TraderSignedQuote>;
  let current: Rewrite | null = null;
  const w = await traderWorld({
    tamper: (quote) => (current ? current(quote) : quote),
  });
  try {
    const other = testAccounts.taker2.address.toLowerCase();
    const flip = (hex: string) =>
      hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");
    const message =
      (patch: Partial<TraderSignedQuote["message"]>) =>
      (q: TraderSignedQuote) => ({ ...q, message: { ...q.message, ...patch } });
    const cases: Record<string, Rewrite> = {
      DEPLOYMENT_MISMATCH: (q) => ({ ...q, deploymentId: "other-deployment" }),
      DOMAIN_MISMATCH: (q) => ({
        ...q,
        domain: { ...q.domain, verifyingContract: other },
      }),
      TYPES_MISMATCH: (q) => ({
        ...q,
        types: {
          Quote: q.types.Quote.map((t, i) =>
            i === 0 ? { ...t, name: "marketID" } : t,
          ),
        },
      }),
      QUOTE_INVALID: message({ side: "2" as never }),
      MARKET_MISMATCH: message({ marketId: "2" }),
      MAKER_MISMATCH: message({ maker: other }),
      TAKER_MISMATCH: message({ taker: other }),
      SIDE_MISMATCH: message({ side: "1" }),
      QUANTITY_MISMATCH: message({ quantity: "11" }),
      PRICE_ABOVE_ASK: message({ priceBps: "6701" }),
      LIFETIME_INVALID: (q) => ({ ...q, expiresAt: "1" }),
      COST_MISMATCH: (q) => ({ ...q, takerCostMicros: "1" }),
      DIGEST_MISMATCH: (q) => ({ ...q, quoteId: flip(q.quoteId) }),
      // Signed over the right message by someone who is not the maker.
      SIGNATURE_INVALID: async (q) => ({
        ...q,
        signature: await testAccounts.taker2.signTypedData(
          quoteTypedData(w.manifest, parseQuoteMessage(q.message)!),
        ),
      }),
      CALLDATA_MISMATCH: (q) => ({ ...q, calldata: flip(q.calldata) }),
    };
    let first = true;
    for (const [reason, tamper] of Object.entries(cases)) {
      if (!first) {
        await w.seedWindow({ hoursAgo: 0 });
        await freeMaker(w);
      }
      first = false;
      current = tamper;
      const run = await w.run();
      assert.deepEqual(
        Object.values(run.trades),
        ["RELEASED:ENVELOPE_INVALID:" + reason],
        reason,
      );
    }
    assert.deepEqual(w.dispatcher.calls, [], "nothing was sent to be signed");
    assert.deepEqual(await w.intents(), []);
    assert.equal(
      (
        await w.query<{ reason: string }>(
          "SELECT reason FROM operations.audit_log WHERE action='trader.quote_refused'",
        )
      ).length,
      Object.keys(cases).length,
    );
    // The same pipeline accepts the untouched quote.
    current = null;
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    assert.deepEqual(Object.values((await w.run()).trades), ["FILL_INCLUDED"]);

    // A stored envelope that is not a signed quote at all is refused too. This one's approve is
    // already out, so the risk is not given back for it: it stays until the quote expires.
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    w.dispatcher.modes.APPROVE = "pending";
    assert.ok(
      Object.values((await w.run()).trades).includes("WAITING:APPROVE"),
    );
    await w.query(
      `UPDATE trading.quotes SET envelope='{"quote":"garbage"}'::jsonb WHERE id=(SELECT id FROM trading.quotes ORDER BY created_at DESC LIMIT 1)`,
    );
    const garbled = await w.run();
    assert.equal(Object.values(garbled.trades).at(-1), "WAITING:HANDED_OVER");
    assert.equal((await w.reservations()).at(-1)!.state, "HELD");
    const [newest] = await w.query<{ expires_at: string }>(
      "SELECT expires_at::text FROM trading.quotes ORDER BY created_at DESC LIMIT 1",
    );
    await w.setCursor({
      number: HEAD_NUMBER,
      timestamp: BigInt(newest!.expires_at),
    });
    assert.equal(
      Object.values((await w.run()).trades).at(-1),
      "RELEASED:QUOTE_EXPIRED",
    );
  } finally {
    await w.close();
  }
});

test("an approve or a fill that fails for good gives the risk back; one that is pending keeps it and resumes the same intents", async () => {
  const w = await traderWorld();
  try {
    const modes = w.dispatcher.modes;
    const states = async () =>
      (await w.intents()).map((i) => `${i.kind}:${i.state}`);
    let first = true;
    const next = async () => {
      if (!first) {
        await w.seedWindow({ hoursAgo: 0 });
        await freeMaker(w);
      }
      first = false;
    };
    // Buys still in flight are carried on by every run: the one under test is the newest.
    const only = async () => Object.values((await w.run()).trades).slice(-1);

    modes.APPROVE = "revert";
    await next();
    assert.deepEqual(await only(), ["RELEASED:APPROVE_FAILED"]);
    modes.APPROVE = "reject";
    await next();
    assert.deepEqual(await only(), ["RELEASED:APPROVE_FAILED"]);
    assert.deepEqual(await states(), ["APPROVE:FAILED", "APPROVE:FAILED"]);

    modes.APPROVE = "mine";
    modes.FILL = "revert";
    await next();
    assert.deepEqual(await only(), ["RELEASED:FILL_FAILED"]);
    modes.FILL = "reject";
    await next();
    assert.deepEqual(await only(), ["RELEASED:FILL_FAILED"]);
    modes.FILL = "mine";

    // Pending is not failure: the risk stays and the next run carries on with the same intents.
    modes.APPROVE = "pending";
    await next();
    assert.deepEqual(await only(), ["WAITING:APPROVE"]);
    assert.deepEqual(
      (await w.reservations()).map((r) => r.state).at(-1),
      "HELD",
    );
    modes.APPROVE = "mine";
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);
    modes.FILL = "pending";
    await next();
    assert.deepEqual(await only(), ["WAITING:FILL"]);
    modes.FILL = "mine";
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);

    // A block holds the approve with a failed receipt, but that block is not final: no fill, no release.
    modes.APPROVE = "reverted-receipt";
    await next();
    assert.deepEqual(await only(), ["WAITING:APPROVE"]);
    modes.APPROVE = "mine";

    assert.deepEqual(await states(), [
      "APPROVE:FAILED",
      "APPROVE:FAILED",
      "APPROVE:INCLUDED",
      "FILL:FAILED",
      "APPROVE:INCLUDED",
      "FILL:FAILED",
      "APPROVE:INCLUDED",
      "FILL:INCLUDED",
      "APPROVE:INCLUDED",
      "FILL:INCLUDED",
      "APPROVE:INCLUDED",
    ]);
    assert.deepEqual(
      (await w.reservations()).map((r) => r.release_reason ?? r.state),
      [
        "APPROVE_FAILED",
        "APPROVE_FAILED",
        "FILL_FAILED",
        "FILL_FAILED",
        "HELD",
        "HELD",
        "HELD",
      ],
    );
    // One approve intent per buy, however many times it was carried on.
    assert.equal(w.apiCalls.length, 7);
  } finally {
    await w.close();
  }
});

test("the canonical chain decides: a fill is accounted, a reorged fill is held again, expiry is block time only", async () => {
  const w = await traderWorld();
  try {
    const stateOf = async () => (await w.reservations())[0]!.state;
    const only = async () => Object.values((await w.run()).trades);
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);
    const [quoted] = await w.query<{ expires_at: string }>(
      "SELECT expires_at::text FROM trading.quotes",
    );
    const expiresAt = BigInt(quoted!.expires_at);

    // The business clock is far past the quote's expiry; the canonical cursor is not.
    await w.setDbClock(400);
    await w.setCursor({ number: HEAD_NUMBER, timestamp: w.ts });
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);
    assert.equal(await stateOf(), "HELD");
    await w.setDbClock(0);
    await w.setCursor({ number: HEAD_NUMBER, timestamp: w.ts });

    // The indexer shows the fill: accounted once, tracked to finality.
    await w.fillDigest();
    assert.deepEqual(await only(), ["ACCOUNTED"]);
    assert.equal(await stateOf(), "ACCOUNTED");
    assert.ok(w.tracked.length >= 2);
    assert.deepEqual(await only(), ["ACCOUNTED"]);

    // Its block is reorged away: the risk is occupied again, never counted twice.
    await w.unfill();
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);
    assert.equal(await stateOf(), "HELD");

    // A projection under repair settles nothing, even past the expiry.
    await w.setCursor({
      number: HEAD_NUMBER,
      timestamp: expiresAt + 5n,
      gate: "REORG_IN_PROGRESS",
    });
    assert.deepEqual(await only(), ["WAITING:INDEXER_GATED"]);
    assert.equal(await stateOf(), "HELD");

    // One second before the expiry nothing is released; at the expiry second the quote can no longer fill.
    await w.setCursor({ number: HEAD_NUMBER, timestamp: expiresAt - 1n });
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);
    await w.setCursor({ number: HEAD_NUMBER, timestamp: expiresAt });
    assert.deepEqual(await only(), ["RELEASED:QUOTE_EXPIRED"]);
    assert.equal(await stateOf(), "RELEASED");
    // Released is final, whatever the chain shows later.
    await w.fillDigest();
    assert.deepEqual(await only(), []);
    assert.equal(await stateOf(), "RELEASED");
  } finally {
    await w.close();
  }
});

test("a cancelled quote, an epoch bump and a fill that is already final", async () => {
  const w = await traderWorld();
  try {
    const only = async () => Object.values((await w.run()).trades);
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);
    await w.fillDigest("CANCELLED");
    assert.deepEqual(await only(), ["RELEASED:QUOTE_CANCELLED"]);

    await w.unfill();
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);
    await w.query("UPDATE chain.maker_state SET epoch=epoch+1");
    assert.deepEqual(await only(), ["RELEASED:QUOTE_CANCELLED"]);

    await w.query("UPDATE chain.maker_state SET epoch=3");
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    assert.deepEqual(await only(), ["FILL_INCLUDED"]);
    await w.unfill();
    await w.fillDigest();
    assert.deepEqual(await only(), ["ACCOUNTED"]);
    // Once the filled block is final the buy leaves the working set: nothing more to carry.
    await w.setCursor({
      number: HEAD_NUMBER,
      timestamp: w.ts,
      finalized: 100n,
    });
    assert.deepEqual(await only(), []);
    assert.deepEqual(
      (await w.reservations()).map((r) => r.state),
      ["RELEASED", "RELEASED", "ACCOUNTED"],
    );
  } finally {
    await w.close();
  }
});

test("switching the mandate off stops spending but not settling", async () => {
  const w = await traderWorld();
  try {
    w.dispatcher.modes.APPROVE = "pending";
    const id = intentOf(w, w.windowId!);
    assert.deepEqual((await w.run()).trades, { [id]: "WAITING:APPROVE" });
    const calls = w.dispatcher.calls.length;
    await w.query("UPDATE trading.mandates SET enabled=false");
    const off = await w.run();
    assert.equal(off.stopped, "MANDATE_DISABLED");
    assert.deepEqual(off.trades, { [id]: "WAITING:DISABLED" });
    assert.equal(w.dispatcher.calls.length, calls, "no approve was attempted");

    // The quote still expires on block time and gives its capacity back.
    const [quoted] = await w.query<{ expires_at: string }>(
      "SELECT expires_at::text FROM trading.quotes",
    );
    await w.setCursor({
      number: HEAD_NUMBER,
      timestamp: BigInt(quoted!.expires_at),
    });
    assert.deepEqual((await w.run()).trades, {
      [id]: "RELEASED:QUOTE_EXPIRED",
    });
  } finally {
    await w.close();
  }
});

test("a FINAL market's shares are redeemed once; a failed redeem is audited, never repeated", async () => {
  const w = await traderWorld();
  try {
    const q = <R = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      w.query<R>(sql, params);
    const position = (market: number, yes: number) =>
      q(
        `INSERT INTO chain.positions(deployment_id,market_id,account,yes_shares,no_shares,as_of_block_hash)
        VALUES($1,$2,decode($3,'hex'),$4,0,decode(repeat('22',32),'hex'))
        ON CONFLICT (deployment_id,market_id,account) DO UPDATE SET yes_shares=$4`,
        [DEPLOYMENT, market, testAccounts.trader.address.slice(2), yes],
      );
    const finalize = (market: number) =>
      q(
        "UPDATE chain.markets SET state='FINAL',final_outcome='YES',final_reason='UNCHALLENGED' WHERE market_id=$1",
        [market],
      );
    // No new buys here: the point is the redeem path.
    await q("UPDATE trading.mandates SET enabled=false");
    await q(
      `INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,
        challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
      SELECT deployment_id,2,decode(repeat('33',32),'hex'),spec_uri,mode,close_at,proposal_deadline,hard_deadline,
        challenge_seconds,max_pairs,max_taker_shares,'OPEN',created_block_number,created_tx_hash,as_of_block_hash
      FROM chain.markets WHERE market_id=1`,
    );

    // A position in a market that is not FINAL is not redeemable.
    await position(1, 10);
    assert.deepEqual((await w.run()).redeemed, {});

    // A FINAL market with a position: a failed redeem is audited once and not tried again.
    await position(2, 7);
    await finalize(2);
    w.dispatcher.modes.REDEEM = "revert";
    assert.deepEqual((await w.run()).redeemed, { "2": "FAILED" });
    assert.deepEqual((await w.run()).redeemed, { "2": "FAILED" });
    assert.equal(
      (await w.intents()).filter((i) => i.kind === "REDEEM").length,
      1,
    );
    assert.equal(
      (
        await q(
          "SELECT id FROM operations.audit_log WHERE action='trader.redeem_failed'",
        )
      ).length,
      1,
    );

    // A silent indexer holds the redeem back; a fresh one lets it through, exactly once.
    w.dispatcher.modes.REDEEM = "mine";
    await finalize(1);
    await w.setDbClock(30);
    assert.equal((await w.run()).redeemed["1"], "WAITING:INDEXER_LAG");
    await w.setDbClock(0);
    await w.setCursor({ number: HEAD_NUMBER, timestamp: w.ts });
    assert.deepEqual((await w.run()).redeemed, {
      "1": "INCLUDED",
      "2": "FAILED",
    });
    assert.deepEqual((await w.run()).redeemed, {
      "1": "INCLUDED",
      "2": "FAILED",
    });
    const redeems = await q<{ payload: unknown }>(
      "SELECT payload FROM signing.economic_intents WHERE kind='REDEEM' ORDER BY created_at",
    );
    assert.equal(redeems.length, 2, "one intent per market");
    const [call] = await q<{ unsigned_payload: unknown }>(
      `SELECT r.unsigned_payload FROM signing.sign_requests r JOIN signing.economic_intents i ON i.id=r.intent_id
      WHERE i.kind='REDEEM' AND i.state='INCLUDED'`,
    );
    assert.deepEqual(call!.unsigned_payload, {
      to: w.manifest.contracts.BlinkMarket.toLowerCase(),
      functionName: "redeem",
      args: ["1"],
    });
    assert.equal(
      w.dispatcher.calls.filter((c) => c.kind === "REDEEM").length,
      2,
      "the redeem that is already in a block is not dispatched again",
    );
    // The indexer folds the redeem: the position is gone.
    await position(1, 0);
    assert.deepEqual((await w.run()).redeemed, { "2": "FAILED" });
  } finally {
    await w.close();
  }
});

test("no mandate, an ambiguous mandate and an aborted run", async () => {
  const w = await traderWorld();
  try {
    const none = await w.build({ role: "FORECASTER_B" }).evaluate(w.signal);
    assert.deepEqual(none, {
      stopped: "NO_MANDATE",
      markets: {},
      trades: {},
      redeemed: {},
    });
    assert.deepEqual(await w.reservations(), []);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      w.build().evaluate(controller.signal),
      /OPERATION_ABORTED/,
    );
    assert.deepEqual(await w.reservations(), [], "aborted before it spent");

    const seen: AbortSignal[] = [];
    await createTraderHandler({
      evaluate: async (signal) => {
        seen.push(signal);
        return none;
      },
    })({ job: { id: "j", payload: {} }, signal: w.signal });
    assert.deepEqual(seen, [w.signal]);

    const twin = await inviteAgent(w.t, {
      name: "second-trader",
      scopes: ["trade:quote"],
    });
    await w.query(
      `INSERT INTO trading.mandates(agent_id,wallet,forecaster_role,policy_version)
      VALUES($1,decode(repeat('44',20),'hex'),'FORECASTER_A','trader-v1')`,
      [twin.agentId],
    );
    await assert.rejects(w.run(), /TRADER_MANDATE_AMBIGUOUS/);
  } finally {
    await w.close();
  }
});

const reservationId = async (w: TraderWorld) =>
  (
    await w.query<{ id: string }>(
      "SELECT id FROM trading.risk_reservations ORDER BY created_at DESC LIMIT 1",
    )
  )[0]!.id;

test("a slow run and a later run on the same buy end on one buy: never a released reservation with a fill", async () => {
  // Run A waits for its RFQ answer; meanwhile 200 seconds pass and run B carries the same buy all
  // the way. A used to find no quote row at that age and give the risk back, after which B (or A)
  // approved and filled it: a position the mandate no longer counted.
  let world: TraderWorld | null = null;
  let nested = false;
  const w = await traderWorld({
    before: async () => {
      if (nested) return;
      nested = true;
      await world!.setDbClock(200);
      await world!.setCursor({ number: HEAD_NUMBER, timestamp: world!.ts });
      assert.deepEqual(Object.values((await world!.run()).trades), [
        "FILL_INCLUDED",
      ]);
    },
  });
  world = w;
  try {
    const outcome = Object.values((await w.run()).trades);
    assert.deepEqual(outcome, ["FILL_INCLUDED"]);
    assert.deepEqual(await w.reservations(), [
      {
        state: "HELD",
        side: "YES",
        shares: 10,
        ask_bps: 6700,
        release_reason: null,
        notional_micros: "10000000",
      },
    ]);
    assert.deepEqual(
      (await w.intents()).map((i) => i.kind),
      ["APPROVE", "FILL"],
      "one approve and one fill, however many runs carried the buy",
    );
    assert.equal(
      (await w.query("SELECT id FROM trading.quotes")).length,
      1,
      "one quote under the one key",
    );
  } finally {
    await w.close();
  }
});

test("a buy given back between two steps is not spent any further", async () => {
  const w = await traderWorld();
  try {
    const q = <R = Record<string, unknown>>(sql: string) => w.query<R>(sql);
    const fills = async () =>
      (await w.intents()).filter((i) => i.kind === "FILL").length;

    // Released by another run right after the approve was sent: no fill is prepared or sent.
    w.dispatcher.hooks.afterDispatch = async (kind) => {
      if (kind === "APPROVE")
        await w.store.release(await reservationId(w), "OTHER_RUN");
    };
    assert.deepEqual(Object.values((await w.run()).trades), [
      "WAITING:NOT_AUTHORIZED",
    ]);
    assert.deepEqual(w.dispatcher.kinds(), ["APPROVE"]);
    assert.equal(await fills(), 0);
    assert.deepEqual(
      (await w.reservations()).map((r) => r.release_reason),
      ["OTHER_RUN"],
    );

    // Released while the approve is still pending: the very next dispatch is not made.
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    w.dispatcher.modes.APPROVE = "pending";
    w.dispatcher.calls.length = 0;
    w.dispatcher.hooks.afterDispatch = async () => {
      await w.store.release(await reservationId(w), "OTHER_RUN");
    };
    assert.deepEqual(Object.values((await w.run()).trades).slice(-1), [
      "WAITING:NOT_AUTHORIZED",
    ]);
    assert.equal(w.dispatcher.calls.length, 1, "asked once, not polled");
    w.dispatcher.hooks.afterDispatch = null;
    w.dispatcher.modes.APPROVE = "mine";

    // The mandate switched off mid-run stops the fill (and nothing is released by it).
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    w.dispatcher.hooks.afterDispatch = async (kind) => {
      if (kind === "APPROVE")
        await q("UPDATE trading.mandates SET enabled=false");
    };
    const before = await fills();
    assert.deepEqual(Object.values((await w.run()).trades).slice(-1), [
      "WAITING:NOT_AUTHORIZED",
    ]);
    assert.equal(await fills(), before);
    assert.equal((await w.reservations()).at(-1)!.state, "HELD");
    w.dispatcher.hooks.afterDispatch = null;
    await q("UPDATE trading.mandates SET enabled=true");
    assert.deepEqual(Object.values((await w.run()).trades).slice(-1), [
      "FILL_INCLUDED",
    ]);
    assert.equal(
      w.dispatcher.calls.filter((c) => c.kind === "APPROVE").length,
      2,
      "the mined approve is not sent again when the buy resumes",
    );

    // A quote gate opened mid-run stops the fill too.
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    w.dispatcher.hooks.afterDispatch = async (kind) => {
      if (kind === "APPROVE")
        await q(
          `INSERT INTO trading.quote_gates(id,deployment_id,market_id,reason,actor,note)
          VALUES(gen_random_uuid(),'${DEPLOYMENT}',1,'OUTCOME_KNOWN','test','outcome is public')`,
        );
    };
    const gated = await fills();
    assert.deepEqual(Object.values((await w.run()).trades).slice(-1), [
      "WAITING:OUTCOME_KNOWN",
    ]);
    assert.equal(await fills(), gated);
  } finally {
    await w.close();
  }
});

test("a quote priced from another forecast window than the decision is left unspent", async () => {
  const w = await traderWorld();
  try {
    // The decision is taken on window 1 but the RFQ is not answered yet.
    w.chain.state.headFails = true;
    const first = intentOf(w, w.windowId!);
    assert.deepEqual((await w.run()).trades, {
      [first]: "WAITING:RFQ:CHAIN_UNAVAILABLE",
    });
    // A newer window closes (ensemble 0.60, ask 0.62: cheaper than the 0.67 decided on).
    w.chain.state.headFails = false;
    const second = await w.seedWindow({ a: 0.8, b: 0.4, hoursAgo: 0 });
    const run = await w.run();
    assert.equal(run.trades[first], "RELEASED:QUOTE_WINDOW_MISMATCH");
    assert.deepEqual(
      (await w.reservations()).map((r) => [r.state, r.ask_bps]),
      [
        ["RELEASED", 6700],
        ["HELD", 6200],
      ],
    );
    // Nothing was approved for the first buy; the new window is its own buy.
    assert.deepEqual(
      (
        await w.query<{ dedupe_key: string }>(
          "SELECT dedupe_key FROM signing.economic_intents WHERE role='trader' ORDER BY created_at",
        )
      ).map((i) => i.dedupe_key.split(":").slice(0, 2).join(":")),
      ["trader:approve", "trader:fill"],
    );
    assert.equal(run.trades[intentOf(w, second)], "FILL_INCLUDED");
    assert.equal(
      (
        await w.query(
          "SELECT id FROM operations.audit_log WHERE action='trader.quote_refused' AND reason='QUOTE_WINDOW_MISMATCH'",
        )
      ).length,
      1,
    );
  } finally {
    await w.close();
  }
});

test("a run never waits more than its budget: it returns while the fill is pending and a resume run completes it", async () => {
  const w = await traderWorld();
  try {
    // A second market with its own edge, to show what a spent budget defers.
    await w.query(
      `INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,
        challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
      SELECT deployment_id,2,decode(repeat('33',32),'hex'),spec_uri,mode,close_at,proposal_deadline,hard_deadline,
        challenge_seconds,max_pairs,max_taker_shares,'OPEN',created_block_number,created_tx_hash,as_of_block_hash
      FROM chain.markets WHERE market_id=1`,
    );
    await w.seedWindow({ marketId: 2 });
    const id = intentOf(w, w.windowId!);

    w.dispatcher.modes.APPROVE = "pending";
    const first = await w.run();
    assert.equal(first.trades[id], "WAITING:APPROVE");
    assert.ok(w.clock.ms <= 5000, "slept " + w.clock.ms + " ms in total");
    assert.equal(
      first.markets["2"],
      "DEFERRED",
      "no new buy once the budget is spent",
    );
    assert.equal((await w.reservations()).length, 1);
    assert.ok(w.resumes.count >= 1, "a resume run is asked for");

    // The resume run: the approve is mined, the fill goes out, and the second market is decided.
    w.dispatcher.modes.APPROVE = "mine";
    w.clock.ms = 0;
    const second = await w.run();
    assert.equal(second.trades[id], "FILL_INCLUDED");
    assert.equal(second.markets["2"], "RESERVED");
    assert.deepEqual(
      (await w.reservations()).map((r) => r.state),
      ["HELD", "HELD"],
    );
    assert.equal(
      (await w.intents()).filter((i) => i.kind === "APPROVE").length,
      2,
      "one approve per buy: the pending one was resumed, not repeated",
    );

    // A pending fill: the run returns within the budget as well.
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    w.dispatcher.modes.FILL = "pending";
    w.clock.ms = 0;
    const pending = await w.run();
    assert.ok(Object.values(pending.trades).includes("WAITING:FILL"));
    assert.ok(w.clock.ms <= 5000, "slept " + w.clock.ms + " ms in total");
    w.dispatcher.modes.FILL = "mine";
    w.clock.ms = 0;
    assert.ok(
      !Object.values((await w.run()).trades).includes("WAITING:FILL"),
      "the resume run completed it",
    );
  } finally {
    await w.close();
  }
});

test("only a stored business refusal releases the risk: every other RFQ answer keeps the buy held and asks again under the same key", async () => {
  // [status, code, retryable, releases]
  const answers = [
    [404, "NOT_FOUND", false, true],
    [409, "NO_QUOTE", false, true],
    [409, "PRICE_LIMIT_EXCEEDED", false, true],
    [409, "IDEMPOTENCY_CONFLICT", false, false],
    [409, "REQUEST_IN_PROGRESS", true, false],
    [500, "INTERNAL_ERROR", false, false],
    [401, "UNAUTHORIZED", false, false],
    [403, "WALLET_NOT_VERIFIED", false, false],
    [429, "RATE_LIMITED", true, false],
    [503, "SERVICE_NOT_READY", true, false],
    [0, "API_UNAVAILABLE", true, false],
  ] as const;
  for (const [status, code, retryable, releases] of answers) {
    let canned: TraderQuoteResult | null = {
      ok: false,
      status,
      code,
      retryable,
    };
    const w = await traderWorld({ answer: () => canned });
    try {
      const label = `${status} ${code}`;
      const id = intentOf(w, w.windowId!);
      const audits = async () =>
        (
          await w.query(
            "SELECT id FROM operations.audit_log WHERE action='trader.rfq_unanswered'",
          )
        ).length;
      const first = await w.run();
      if (releases) {
        assert.deepEqual(
          first.trades,
          { [id]: "RELEASED:RFQ_REJECTED:" + code },
          label,
        );
        assert.deepEqual(
          (await w.reservations()).map((r) => r.state),
          ["RELEASED"],
          label,
        );
        continue;
      }
      assert.deepEqual(first.trades, { [id]: "WAITING:RFQ:" + code }, label);
      assert.deepEqual(
        (await w.run()).trades,
        { [id]: "WAITING:RFQ:" + code },
        label,
      );
      assert.deepEqual(
        (await w.reservations()).map((r) => r.state),
        ["HELD"],
        label,
      );
      // An odd answer is audited once per buy and code; a routine retryable one is not audited.
      assert.equal(await audits(), retryable ? 0 : 1, label);
      // The API answers again: the same key carries the buy through.
      canned = null;
      assert.deepEqual(
        (await w.run()).trades,
        { [id]: "FILL_INCLUDED" },
        label,
      );
      assert.deepEqual(
        [...new Set(w.apiCalls.map((c) => c.key))],
        ["trader-" + id],
        label,
      );
    } finally {
      await w.close();
    }
  }
});

test("a run with a stale view gets a refusal or an error on the same-key replay after another run approved and filled: the buy is never released", async () => {
  // Run B read its buys while the buy had no quote row; run A then requested the quote, approved and
  // filled; B's replay of the same key answers with an API error (the 500 the API gives to any
  // unexpected failure) or, in the second case, even with a stored-looking refusal.
  const replays = [
    { ok: false, status: 500, code: "INTERNAL_ERROR", retryable: false },
    { ok: false, status: 409, code: "NO_QUOTE", retryable: false },
  ] as const;
  for (const replay of replays) {
    let world: TraderWorld | null = null;
    let calls = 0;
    let nestedDone = false;
    const w = await traderWorld({
      before: async () => {
        calls += 1;
        if (calls > 1) return;
        await world!.run();
        nestedDone = true;
      },
      answer: () => (nestedDone ? replay : null),
    });
    world = w;
    try {
      const id = intentOf(w, w.windowId!);
      const outer = await w.run();
      assert.equal(
        outer.trades[id],
        replay.status === 500
          ? "WAITING:RFQ:INTERNAL_ERROR"
          : "WAITING:HANDED_OVER",
        replay.code,
      );
      assert.deepEqual(
        (await w.reservations()).map((r) => [r.state, r.release_reason]),
        [["HELD", null]],
        replay.code,
      );
      assert.deepEqual(
        (await w.intents()).map((i) => [i.kind, i.state]),
        [
          ["APPROVE", "INCLUDED"],
          ["FILL", "INCLUDED"],
        ],
      );
      // The indexer shows the fill: the buy is accounted, never lost.
      await w.fillDigest();
      assert.deepEqual((await w.run()).trades, { [id]: "ACCOUNTED" });
      assert.equal((await w.reservations())[0]!.state, "ACCOUNTED");
    } finally {
      await w.close();
    }
  }
});

test("a buy that spent nothing is released only while nothing says otherwise, read under the lock", async () => {
  let world: TraderWorld | null = null;
  let first = true;
  const w = await traderWorld({
    // The first RFQ runs the budget out: the quote exists, no intent was prepared.
    before: async () => {
      if (!first) return;
      first = false;
      world!.clock.ms += 6000;
    },
  });
  world = w;
  try {
    const id = intentOf(w, w.windowId!);
    assert.deepEqual((await w.run()).trades, { [id]: "WAITING:BUDGET" });
    assert.equal((await w.query("SELECT id FROM trading.quotes")).length, 1);
    assert.deepEqual(await w.intents(), []);
    const reservation = await reservationId(w);
    // A quote row means "no quote" releases are refused; the ones that expect a quote may go ahead.
    assert.equal(
      await w.store.releaseUnspent(reservation, "NO_QUOTE_RELEASE", {
        quoteAllowed: false,
      }),
      false,
    );
    assert.equal((await w.reservations())[0]!.state, "HELD");
    assert.equal(
      await w.store.releaseUnspent(reservation, "UNSPENT_WITH_QUOTE", {
        quoteAllowed: true,
      }),
      true,
    );
    assert.deepEqual(
      (await w.reservations()).map((r) => r.release_reason),
      ["UNSPENT_WITH_QUOTE"],
    );

    // An approve intent for the buy refuses both kinds, and a buy already released refuses again.
    await w.seedWindow({ hoursAgo: 0 });
    await freeMaker(w);
    w.clock.ms = 0;
    w.dispatcher.modes.APPROVE = "pending";
    await w.run();
    const pending = await reservationId(w);
    for (const quoteAllowed of [false, true])
      assert.equal(
        await w.store.releaseUnspent(pending, "AFTER_APPROVE", {
          quoteAllowed,
        }),
        false,
      );
    assert.equal(
      await w.store.releaseUnspent(reservation, "AGAIN", {
        quoteAllowed: true,
      }),
      false,
    );
    assert.equal((await w.reservations()).at(-1)!.state, "HELD");
  } finally {
    await w.close();
  }
});

test("the database holds the line: the worker cannot widen its mandate, read rationales or retake released risk", async () => {
  const w = await traderWorld();
  try {
    await w.run();
    const worker = poolAs(w.t, "blink_worker");
    const api = poolAs(w.t, "blink_api");
    const denied = (pool: typeof worker, sql: string) =>
      assert.rejects(pool.query(sql), /permission denied/, sql);
    await denied(
      worker,
      "UPDATE trading.mandates SET daily_notional_cap_micros=1",
    );
    await denied(
      worker,
      `INSERT INTO trading.mandates(agent_id,wallet,forecaster_role,policy_version)
      VALUES (gen_random_uuid(),decode(repeat('11',20),'hex'),'FORECASTER_A','x')`,
    );
    // The embargo on forecast answers is untouched: the worker has no grant on them at all...
    await denied(worker, "SELECT 1 FROM forecasts.submissions");
    await denied(worker, "SELECT probability FROM forecasts.submissions");
    await denied(worker, "SELECT rationale FROM forecasts.submissions");
    await denied(worker, "SELECT * FROM forecasts.annotations");
    // ...and the trader's view shows a window only once it has closed, and only the latest one.
    const open = await w.seedWindow({ a: 0.99, b: 0.01, hoursAgo: -1 });
    const closed = await w.seedWindow({ hoursAgo: 0 });
    const visible = await worker.query(
      "SELECT window_id,a_probability::float8 AS a FROM trading.trader_snapshots",
    );
    assert.deepEqual(
      visible.rows.map((r) => [r.window_id, r.a]),
      [[closed, 0.8]],
      "the newest closed window; the open one (" + open + ") is not shown",
    );
    await denied(api, "SELECT * FROM trading.trader_snapshots");
    // The snapshot-to-window view is all the worker sees of snapshots.
    await worker.query(
      "SELECT snapshot_id FROM trading.trader_snapshot_windows",
    );
    await denied(worker, "SELECT * FROM forecasts.snapshots");
    await denied(api, "SELECT * FROM trading.trader_snapshot_windows");
    await denied(worker, "DELETE FROM trading.risk_reservations");
    await denied(
      worker,
      "UPDATE trading.risk_reservations SET notional_micros=1",
    );
    await denied(worker, "UPDATE trading.risk_reservations SET shares=1");
    await denied(api, "SELECT * FROM trading.mandates");
    await denied(api, "SELECT * FROM trading.risk_reservations");

    // Transitions: HELD -> ACCOUNTED -> HELD is a reorg; nothing leaves RELEASED; ACCOUNTED never releases directly.
    const [held] = await w.query<{ id: string }>(
      "SELECT id FROM trading.risk_reservations",
    );
    const id = held!.id;
    const move = (set: string) =>
      worker.query(
        `UPDATE trading.risk_reservations SET ${set} WHERE id='${id}'`,
      );
    await move("state='ACCOUNTED'");
    await assert.rejects(
      move("state='RELEASED',release_reason='x'"),
      /illegal risk reservation transition/,
    );
    await move("state='HELD'");
    await move("state='RELEASED',release_reason='x'");
    await assert.rejects(
      move("state='HELD',release_reason=NULL"),
      /illegal risk reservation transition/,
    );
    await assert.rejects(
      move("state='ACCOUNTED'"),
      /illegal risk reservation transition/,
    );
    // The notional must be the shares' maximum payout.
    await assert.rejects(
      w.query(
        `INSERT INTO trading.risk_reservations(id,agent_id,intent_id,day,notional_micros,state,deployment_id,market_id,
          window_id,side,shares,ask_bps,own_probability_millionths)
        SELECT gen_random_uuid(),agent_id,gen_random_uuid(),day,1,'HELD',deployment_id,market_id,window_id,side,shares,ask_bps,own_probability_millionths
        FROM trading.risk_reservations`,
      ),
      /violates check constraint/,
    );
  } finally {
    await w.close();
  }
});
