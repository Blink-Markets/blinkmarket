import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { decodeFunctionData, recoverTypedDataAddress, type Hex } from "viem";
import {
  ConfigResponse,
  SignedQuoteResponse,
} from "../packages/schemas/src/index.js";
import { blinkMarketAbi } from "../packages/adapters/src/blink-abi.js";
import {
  quoteRequestHash,
  quoteTypedData,
} from "../packages/application/src/signer.js";
import {
  parseQuoteMessage,
  SIGNING_POLICY_VERSION,
} from "../packages/domain/src/signing-policy.js";
import { createTradingReadiness } from "../packages/application/src/rfq.js";
import { createSnapshotReader } from "../packages/application/src/forecasts.js";
import { postgresForecastStore } from "../packages/adapters/src/forecast-store.js";
import type { IndexedMarketRow } from "../packages/ports/src/index.js";
import { prepareRequest, testAccounts } from "./helpers/signer-fixture.js";
import {
  CLOSE_AT,
  DEPLOYMENT,
  HEAD_NUMBER,
  HEAD_TS,
  SIGNER_TOKEN,
  blockHash,
  rfqBody,
  seedSnapshot,
  tradingWorld,
  type TradingWorld,
} from "./helpers/trading.js";

const counts = async (w: TradingWorld) => {
  const one = async (sql: string) =>
    Number((await w.query<{ n: number }>(sql))[0]!.n);
  return {
    quotes: await one("SELECT count(*)::int AS n FROM trading.quotes"),
    reservations: await one(
      "SELECT count(*)::int AS n FROM trading.collateral_reservations",
    ),
    intents: await one(
      "SELECT count(*)::int AS n FROM signing.economic_intents",
    ),
    requests: await one("SELECT count(*)::int AS n FROM signing.sign_requests"),
  };
};
const reservation = async (w: TradingWorld) =>
  (
    await w.query<{ state: string; amount: string }>(
      "SELECT state, amount_micros::text AS amount FROM trading.collateral_reservations ORDER BY created_at",
    )
  )[0]!;
const idempotency = (w: TradingWorld) =>
  w.query<{ state: string; response_status: number | null }>(
    "SELECT state, response_status FROM operations.idempotency_records WHERE endpoint_scope='POST /v1/rfqs' ORDER BY created_at",
  );

test("an RFQ is priced from the ensemble, reserved, signed by the maker and answered with a verifiable envelope", async () => {
  const w = await tradingWorld();
  try {
    const res = await w.post("k1");
    assert.equal(res.statusCode, 200, res.body);
    const envelope = SignedQuoteResponse.parse(res.json());
    // Spec 10.2 vector: 10 YES at 6200 bps costs 6.2 bUSD; the maker puts up 3.8.
    assert.equal(envelope.takerCostMicros, "6200000");
    assert.equal(envelope.makerCostMicros, "3800000");
    assert.deepEqual(envelope.message, {
      marketId: "1",
      specHash: "0x" + "11".repeat(32),
      maker: testAccounts.maker.address.toLowerCase(),
      taker: testAccounts.taker.address.toLowerCase(),
      side: "0",
      quantity: "10",
      priceBps: "6200",
      validAfter: String(HEAD_TS),
      expiresAt: String(HEAD_TS + 30n),
      nonce: "1",
      epoch: "3",
    });
    assert.equal(envelope.expiresAt, String(HEAD_TS + 30n));
    assert.equal(envelope.mode, "REPLAY");
    assert.equal(envelope.verifyingContract, w.manifest.contracts.BlinkMarket);
    assert.deepEqual(envelope.chainCursor, {
      blockNumber: String(HEAD_NUMBER),
      blockHash: blockHash(HEAD_NUMBER),
      finality: "INCLUDED",
    });
    // The quote id is the EIP-712 digest and the signature is the maker's over exactly this message.
    assert.equal(
      envelope.quoteId,
      quoteRequestHash(w.manifest, envelope.message),
    );
    const typed = quoteTypedData(
      w.manifest,
      parseQuoteMessage(envelope.message)!,
    );
    assert.equal(
      await recoverTypedDataAddress({
        ...typed,
        signature: envelope.signature as Hex,
      }),
      testAccounts.maker.address,
    );
    const decoded = decodeFunctionData({
      abi: blinkMarketAbi,
      data: envelope.calldata as Hex,
    });
    assert.equal(decoded.functionName, "fillQuote");
    const [message, signature] = decoded.args as unknown as [
      Record<string, unknown>,
      Hex,
    ];
    assert.equal(signature, envelope.signature);
    assert.equal(message.priceBps, 6200);
    assert.equal(message.quantity, 10n);
    assert.equal(message.taker, testAccounts.taker.address);

    const [quote] = await w.query<{ status: string; digest: string }>(
      "SELECT status, '0x'||encode(digest,'hex') AS digest FROM trading.quotes",
    );
    assert.deepEqual(quote, { status: "SIGNED", digest: envelope.quoteId });
    assert.deepEqual(await reservation(w), {
      state: "HELD",
      amount: "3800000",
    });
    assert.deepEqual(
      await w.query(
        "SELECT from_state, to_state, reason FROM trading.reservation_events",
      ),
      [{ from_state: null, to_state: "HELD", reason: "QUOTE_RESERVED" }],
    );
    assert.deepEqual(await counts(w), {
      quotes: 1,
      reservations: 1,
      intents: 1,
      requests: 1,
    });
    assert.deepEqual(await idempotency(w), [
      { state: "COMPLETED", response_status: 200 },
    ]);
    const [request] = await w.query<{ state: string; request_hash: string }>(
      "SELECT state, '0x'||encode(request_hash,'hex') AS request_hash FROM signing.sign_requests",
    );
    assert.deepEqual(request, {
      state: "SIGNED",
      request_hash: envelope.quoteId,
    });
  } finally {
    await w.close();
  }
});

test("NO quotes use the complement of the ensemble; the price is clamped into 1..9999", async () => {
  const w = await tradingWorld();
  try {
    const res = await w.post("no", {
      ...rfqBody,
      side: "NO",
      maxCostMicros: "5000000",
    });
    assert.equal(res.statusCode, 200, res.body);
    const envelope = SignedQuoteResponse.parse(res.json());
    assert.equal(envelope.message.side, "1");
    assert.equal(envelope.message.priceBps, "4200");
    assert.equal(envelope.takerCostMicros, "4200000");
  } finally {
    await w.close();
  }
});

test("a completed request replays the stored envelope after expiry without touching the chain or the signer", async () => {
  const w = await tradingWorld();
  try {
    const first = await w.post("k1");
    assert.equal(first.statusCode, 200);
    // The quote is long expired by block time, and the RPC is down.
    await w.setCursor({ number: 101n, timestamp: HEAD_TS + 3600n });
    w.chain.state.headFails = true;
    const heads = w.chain.state.headCalls;
    const replay = await w.post("k1");
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), first.json());
    assert.equal(w.chain.state.headCalls, heads);
    assert.equal(w.signing.calls.length, 1);
    assert.deepEqual((await counts(w)).quotes, 1);
  } finally {
    await w.close();
  }
});

test("the same key with a different payload is a conflict; another key is a new request", async () => {
  const w = await tradingWorld();
  try {
    assert.equal((await w.post("k1")).statusCode, 200);
    const conflict = await w.post("k1", { ...rfqBody, quantity: "11" });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, "IDEMPOTENCY_CONFLICT");
    assert.equal(
      (
        await w.post("k2", {
          ...rfqBody,
          quantity: "11",
          maxCostMicros: "7000000",
        })
      ).statusCode,
      200,
    );
    assert.equal((await counts(w)).quotes, 2);
  } finally {
    await w.close();
  }
});

test("identity: a key, the quote scope and a bound wallet are all required", async () => {
  const w = await tradingWorld();
  try {
    const anonymous = await w.app.inject({
      method: "POST",
      url: "/v1/rfqs",
      headers: { "idempotency-key": "x" },
      payload: rfqBody,
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(
      (await w.post("a", rfqBody, w.agents.noScope)).json().code,
      "SCOPE_DENIED",
    );
    const unbound = await w.post("b", rfqBody, w.agents.noWallet);
    assert.equal(unbound.statusCode, 403);
    assert.equal(unbound.json().code, "WALLET_NOT_VERIFIED");
    // A body that is not the contract's is refused before anything else happens.
    const invalid = await w.post("c", { ...rfqBody, quantity: "101" });
    assert.equal(invalid.statusCode, 400);
    assert.equal((await counts(w)).quotes, 0);
    assert.equal(w.chain.state.headCalls, 0);
  } finally {
    await w.close();
  }
});

test("deployment and market rejections are terminal answers stored under the key", async () => {
  const w = await tradingWorld();
  try {
    const wrong = await w.post("d", { ...rfqBody, deploymentId: "other" });
    assert.equal(wrong.statusCode, 409);
    assert.equal(wrong.json().code, "DEPLOYMENT_MISMATCH");
    const missing = await w.post("m", { ...rfqBody, marketId: "2" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, "NOT_FOUND");
    assert.deepEqual(await idempotency(w), [
      { state: "COMPLETED", response_status: 409 },
      { state: "COMPLETED", response_status: 404 },
    ]);
    assert.deepEqual(await counts(w), {
      quotes: 0,
      reservations: 0,
      intents: 0,
      requests: 0,
    });
    // The stored answer is returned as it was, with the current request id.
    const replay = await w.post("d", { ...rfqBody, deploymentId: "other" });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().code, "DEPLOYMENT_MISMATCH");
  } finally {
    await w.close();
  }
});

test("a disabled deployment or a manifest with trading off is SERVICE_NOT_READY, and is not stored", async () => {
  const off = await tradingWorld({ manifest: { tradingEnabled: false } });
  try {
    const res = await off.post("k");
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "SERVICE_NOT_READY");
    assert.equal(res.json().details.reason, "TRADING_DISABLED");
    assert.equal(res.json().retryable, true);
    assert.deepEqual(await idempotency(off), []);
  } finally {
    await off.close();
  }
  const w = await tradingWorld();
  try {
    await w.query("UPDATE markets.deployments SET enabled=false");
    const res = await w.post("k");
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().details.reason, "TRADING_DISABLED");
    await w.query("UPDATE markets.deployments SET enabled=true");
    assert.equal(
      (await w.post("k")).statusCode,
      200,
      "the same key works once trading is back",
    );
  } finally {
    await w.close();
  }
});

test("freshness: indexer lag, a stale or gated cursor and an unreachable RPC refuse to quote and can be retried", async () => {
  const w = await tradingWorld();
  try {
    const state = w.chain.state;
    const code = async (key: string) => {
      const res = await w.post(key);
      return [res.statusCode, res.json().code, res.json().retryable] as const;
    };
    // Exactly three blocks behind is still fresh; four is not.
    state.head = { number: 103n, hash: blockHash(103), timestamp: HEAD_TS };
    assert.equal((await w.post("lag3")).statusCode, 200);
    state.head = { number: 104n, hash: blockHash(104), timestamp: HEAD_TS };
    assert.deepEqual(await code("lag4"), [503, "INDEXER_LAG", true]);
    // An RPC head below the cursor is a lagging provider, not an indexer problem.
    state.head = { number: 99n, hash: blockHash(99), timestamp: HEAD_TS };
    assert.deepEqual(await code("behind"), [503, "CHAIN_UNAVAILABLE", true]);
    state.head = {
      number: HEAD_NUMBER,
      hash: blockHash(HEAD_NUMBER),
      timestamp: HEAD_TS,
    };
    state.headFails = true;
    assert.deepEqual(await code("head-down"), [503, "CHAIN_UNAVAILABLE", true]);
    state.headFails = false;
    state.readFails = true;
    assert.deepEqual(await code("read-down"), [503, "CHAIN_UNAVAILABLE", true]);
    state.readFails = false;
    // The cursor was last synced more than ten seconds ago on the database clock.
    await w.setDbClock(11);
    assert.deepEqual(await code("stale"), [503, "INDEXER_LAG", true]);
    await w.setDbClock(0);
    await w.setCursor({
      number: HEAD_NUMBER,
      timestamp: HEAD_TS,
      gate: "REORG_IN_PROGRESS",
    });
    assert.deepEqual(await code("gated"), [503, "INDEXER_LAG", true]);
    await w.setCursor({ number: HEAD_NUMBER, timestamp: HEAD_TS });
    // None of those were stored: only the one answered request has an idempotency record, and the
    // keys that failed can be used again.
    assert.deepEqual(await idempotency(w), [
      { state: "COMPLETED", response_status: 200 },
    ]);
    for (const key of ["lag4", "stale"])
      assert.equal((await w.post(key)).statusCode, 200, key);
    assert.equal((await counts(w)).quotes, 3);
  } finally {
    await w.close();
  }
});

test("a gated maker pool refuses new quotes until reconciliation clears it", async () => {
  const w = await tradingWorld();
  try {
    await w.query(
      "INSERT INTO trading.maker_pools(deployment_id,gate_reason) VALUES ($1,'OVERCOMMITTED')",
      [DEPLOYMENT],
    );
    const res = await w.post("k");
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "SERVICE_NOT_READY");
    assert.equal(res.json().details.reason, "OVERCOMMITTED");
    await w.query("UPDATE trading.maker_pools SET gate_reason=NULL");
    assert.equal((await w.post("k")).statusCode, 200);
  } finally {
    await w.close();
  }
});

test("chain-state rejections: pauses, closing, allow-list, caps and operator gates", async () => {
  const w = await tradingWorld();
  try {
    const view = w.chain.state.view;
    const reject = async (
      key: string,
      status: number,
      code: string,
      reason?: string,
    ) => {
      const res = await w.post(key);
      assert.equal(res.statusCode, status, key + " " + res.body);
      assert.equal(res.json().code, code, key);
      if (reason) assert.equal(res.json().details.reason, reason, key);
      assert.equal(res.json().retryable, false, key);
      return res;
    };
    view.globalTradingPaused = true;
    await reject("global-pause", 409, "TRADING_PAUSED");
    view.globalTradingPaused = false;
    view.market.paused = true;
    await reject("market-pause", 409, "TRADING_PAUSED");
    view.market.paused = false;
    view.market.state = "PROPOSED";
    await reject("proposed", 409, "MARKET_CLOSED");
    view.market.state = "OPEN";
    // Block time at the close is closed, whatever the stored state says.
    w.chain.state.head = { ...w.chain.state.head, timestamp: CLOSE_AT };
    await reject("at-close", 409, "MARKET_CLOSED");
    w.chain.state.head = { ...w.chain.state.head, timestamp: HEAD_TS };
    view.takerAllowed = false;
    await reject("not-allowed", 409, "NO_QUOTE", "TAKER_NOT_ALLOWED");
    view.takerAllowed = true;
    view.market.totalMintedPairs = 9_995n;
    await reject("pairs-cap", 409, "NO_QUOTE", "CAP_EXCEEDED");
    view.market.totalMintedPairs = 9_990n;
    assert.equal(
      (await w.post("pairs-exact")).statusCode,
      200,
      "exactly the cap is allowed",
    );
    view.market.totalMintedPairs = 0n;
    view.cumulativeTakerShares = 491n;
    await reject("taker-cap", 409, "NO_QUOTE", "CAP_EXCEEDED");
    view.cumulativeTakerShares = 490n;
    assert.equal((await w.post("taker-exact")).statusCode, 200);
    view.cumulativeTakerShares = 0n;
    await w.query(
      "INSERT INTO trading.quote_gates(id,deployment_id,market_id,reason,actor,note) VALUES (gen_random_uuid(),$1,1,'OUTCOME_KNOWN','op','answer is public')",
      [DEPLOYMENT],
    );
    await reject("gate", 409, "NO_QUOTE", "OUTCOME_KNOWN");
    await w.query(
      "UPDATE trading.quote_gates SET reopened_at=blink.now(), reopened_by='op'",
    );
    assert.equal((await w.post("reopened")).statusCode, 200);
    await w.query(
      "INSERT INTO trading.quote_gates(id,deployment_id,market_id,reason,actor,note) VALUES (gen_random_uuid(),$1,1,'ANNOUNCEMENT_EARLY','op','results leaked early')",
      [DEPLOYMENT],
    );
    await reject("early-announcement", 409, "NO_QUOTE", "ANNOUNCEMENT_EARLY");
    await w.query(
      "UPDATE trading.quote_gates SET reopened_at=blink.now(), reopened_by='op' WHERE reopened_at IS NULL",
    );
    // Rejections are stored terminally: the closed gate does not change an answered key.
    assert.equal((await w.post("gate")).json().details.reason, "OUTCOME_KNOWN");
  } finally {
    await w.close();
  }
});

test("pricing rejections: no fresh ensemble, price limit, too close to the close, maker balance", async () => {
  const none = await tradingWorld({ snapshot: false });
  try {
    const res = await none.post("k");
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, "STALE_FORECAST");
    // An ensemble older than 24 hours does not count either.
    await seedSnapshot(none.t, { hoursAgo: 25 });
    assert.equal((await none.post("k2")).json().code, "STALE_FORECAST");
  } finally {
    await none.close();
  }
  const w = await tradingWorld();
  try {
    const limit = await w.post("limit", {
      ...rfqBody,
      maxCostMicros: "6199999",
    });
    assert.equal(limit.statusCode, 409);
    assert.equal(limit.json().code, "PRICE_LIMIT_EXCEEDED");
    assert.deepEqual(limit.json().details, {
      priceBps: "6200",
      takerCostMicros: "6200000",
    });
    assert.equal(
      (await w.post("exact", { ...rfqBody, maxCostMicros: "6200000" }))
        .statusCode,
      200,
    );

    w.chain.state.view.market.closeAt = HEAD_TS + 4n;
    const close = await w.post("close");
    assert.equal(close.json().code, "NO_QUOTE");
    assert.equal(close.json().details.reason, "TOO_CLOSE_TO_CLOSE");
    w.chain.state.view.market.closeAt = CLOSE_AT;

    w.chain.state.view.makerFreeMicros = 3_799_999n;
    const poor = await w.post("poor");
    assert.equal(poor.statusCode, 409);
    assert.equal(poor.json().code, "INSUFFICIENT_MAKER_BALANCE");
    w.chain.state.view.makerFreeMicros = 10_000_000n;
    // The first quote's 3.8 bUSD is already reserved: only one more fits in 10.
    assert.equal((await w.post("fits")).statusCode, 200);
    assert.equal(
      (await w.post("overdrawn")).json().code,
      "INSUFFICIENT_MAKER_BALANCE",
    );
    assert.equal((await counts(w)).quotes, 2);
  } finally {
    await w.close();
  }
});

test("the quote lifetime is capped by the close, and the signer sees the shortened expiry", async () => {
  const w = await tradingWorld();
  try {
    w.chain.state.view.market.closeAt = HEAD_TS + 12n;
    await w.query("UPDATE chain.markets SET close_at=$1", [
      String(HEAD_TS + 12n),
    ]);
    const res = await w.post("k");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().expiresAt, String(HEAD_TS + 12n));
  } finally {
    await w.close();
  }
});

test("at most five quotes of one taker are outstanding on block time; expired ones stop counting", async () => {
  const w = await tradingWorld();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await w.post("q" + i, {
            ...rfqBody,
            quantity: "1",
            maxCostMicros: "1000000",
          })
        ).statusCode,
        200,
      );
    const sixth = await w.post("q5", {
      ...rfqBody,
      quantity: "1",
      maxCostMicros: "1000000",
    });
    assert.equal(sixth.statusCode, 409);
    assert.equal(sixth.json().code, "NO_QUOTE");
    assert.equal(sixth.json().details.reason, "OUTSTANDING_QUOTE_LIMIT");
    // Another taker has its own five.
    assert.equal(
      (await w.post("other", rfqBody, w.agents.taker2)).statusCode,
      200,
    );
    // Thirty-one seconds of block time later the first five are expired.
    w.chain.state.head = {
      number: 101n,
      hash: blockHash(101),
      timestamp: HEAD_TS + 31n,
    };
    await w.setCursor({ number: 101n, timestamp: HEAD_TS + 31n });
    w.setSignerClock(Number(HEAD_TS + 32n) * 1000);
    assert.equal(
      (
        await w.post("q6", {
          ...rfqBody,
          quantity: "1",
          maxCostMicros: "1000000",
        })
      ).statusCode,
      200,
    );
  } finally {
    await w.close();
  }
});

test("rate limit: a key gets a burst of five and then 429 with Retry-After", async () => {
  const w = await tradingWorld({
    limiter: { capacity: 5, refillPerSecond: 2 },
  });
  try {
    const statuses: number[] = [];
    let limited;
    for (let i = 0; i < 6; i++) {
      const res = await w.post("r" + i, {
        ...rfqBody,
        quantity: "1",
        maxCostMicros: "1000000",
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) limited = res;
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    assert.equal(limited!.json().code, "RATE_LIMITED");
    assert.equal(limited!.json().retryable, true);
    assert.equal(limited!.headers["retry-after"], "1");
    // Another key is unaffected; half a second later this key has earned one token back.
    assert.equal((await w.post("o", rfqBody, w.agents.taker2)).statusCode, 200);
    w.advanceLimiter(500);
    assert.equal(
      (
        await w.post("r5", {
          ...rfqBody,
          quantity: "1",
          maxCostMicros: "1000000",
        })
      ).statusCode,
      409,
      "limiter passed; the outstanding limit answers",
    );
  } finally {
    await w.close();
  }
});

test("a signer that never answers leaves SIGN_UNKNOWN with the reservation held; a retry returns the same quote", async () => {
  const w = await tradingWorld();
  try {
    // The signer signed and committed but the answer was lost.
    w.signing.faults.loseAnswer = true;
    const first = await w.post("k");
    assert.equal(first.statusCode, 503);
    assert.equal(first.json().code, "SERVICE_NOT_READY");
    assert.equal(first.json().retryable, true);
    assert.equal(first.headers["retry-after"], "1");
    const [quote] = await w.query<{
      status: string;
      digest: string;
      envelope: unknown;
    }>(
      "SELECT status, '0x'||encode(digest,'hex') AS digest, envelope FROM trading.quotes",
    );
    assert.equal(quote!.status, "SIGN_UNKNOWN");
    assert.equal(quote!.envelope, null);
    assert.deepEqual(await reservation(w), {
      state: "HELD",
      amount: "3800000",
    });
    assert.deepEqual(await idempotency(w), [
      { state: "IN_PROGRESS", response_status: null },
    ]);

    // Still failing: the retry asks the signer about the same request and creates nothing.
    assert.equal((await w.post("k")).statusCode, 503);
    assert.deepEqual(await counts(w), {
      quotes: 1,
      reservations: 1,
      intents: 1,
      requests: 1,
    });

    w.signing.faults.loseAnswer = false;
    const retry = await w.post("k");
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().quoteId, quote!.digest);
    SignedQuoteResponse.parse(retry.json());
    assert.deepEqual(await counts(w), {
      quotes: 1,
      reservations: 1,
      intents: 1,
      requests: 1,
    });
    assert.deepEqual(
      new Set(w.signing.calls.map((c) => c.signRequestId)).size,
      1,
    );
    // The signer produced one artifact, and the envelope carries exactly its signature.
    const [artifact] = await w.query<{ signature: string; n: number }>(
      "SELECT signature, count(*) OVER ()::int AS n FROM signing.artifacts",
    );
    assert.equal(artifact!.n, 1);
    assert.equal(retry.json().signature, artifact!.signature);
    assert.deepEqual(await reservation(w), {
      state: "HELD",
      amount: "3800000",
    });
    assert.deepEqual(await idempotency(w), [
      { state: "COMPLETED", response_status: 200 },
    ]);
    assert.deepEqual((await w.post("k")).json(), retry.json());
  } finally {
    await w.close();
  }
});

test("a request lost on the way to the signer is signed on retry, still as one quote", async () => {
  const w = await tradingWorld();
  try {
    w.signing.faults.loseRequest = true;
    assert.equal((await w.post("k")).statusCode, 503);
    assert.equal((await counts(w)).quotes, 1);
    w.signing.faults.loseRequest = false;
    const retry = await w.post("k");
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(await counts(w), {
      quotes: 1,
      reservations: 1,
      intents: 1,
      requests: 1,
    });
  } finally {
    await w.close();
  }
});

test("a retry while the first attempt is still at the signer is told to wait, never signed twice", async () => {
  const w = await tradingWorld();
  try {
    let release!: () => void;
    w.signing.faults.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = w.post("k");
    while (w.signing.calls.length < 1) await delay(5);
    const second = await w.post("k");
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, "REQUEST_IN_PROGRESS");
    assert.equal(second.json().retryable, true);
    assert.equal(second.headers["retry-after"], "1");
    release();
    const done = await first;
    assert.equal(done.statusCode, 200);
    assert.equal(w.signing.calls.length, 1);
    assert.deepEqual(await counts(w), {
      quotes: 1,
      reservations: 1,
      intents: 1,
      requests: 1,
    });
    assert.deepEqual((await w.post("k")).json(), done.json());
  } finally {
    await w.close();
  }
});

test("a quote that expired while its signing was unknown ends the key with NO_QUOTE", async () => {
  const w = await tradingWorld();
  try {
    w.signing.faults.loseRequest = true;
    assert.equal((await w.post("k")).statusCode, 503);
    // Reconciliation expired the unsigned quote on block time and released its reservation.
    await w.query("UPDATE trading.quotes SET status='EXPIRED'");
    w.signing.faults.loseRequest = false;
    const res = await w.post("k");
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, "NO_QUOTE");
    assert.equal(res.json().details.reason, "QUOTE_EXPIRED");
    assert.equal(
      w.signing.calls.length,
      1,
      "an expired quote is never offered to the signer again",
    );
    assert.equal((await w.post("k")).json().details.reason, "QUOTE_EXPIRED");
  } finally {
    await w.close();
  }
});

test("a signer rejection is final: the reservation is released and the answer is stored", async () => {
  const w = await tradingWorld();
  try {
    // The signer's own clock is past the quote's expiry minus its two second margin.
    w.setSignerClock(Number(HEAD_TS + 29n) * 1000);
    const res = await w.post("k");
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, "NO_QUOTE");
    assert.deepEqual(res.json().details, {
      reason: "SIGNER_REJECTED",
      signerCode: "QUOTE_EXPIRED",
    });
    assert.deepEqual(await reservation(w), {
      state: "RELEASED",
      amount: "3800000",
    });
    assert.deepEqual(
      await w.query(
        "SELECT from_state, to_state FROM trading.reservation_events ORDER BY created_at",
      ),
      [
        { from_state: null, to_state: "HELD" },
        { from_state: "HELD", to_state: "RELEASED" },
      ],
    );
    assert.equal(
      (
        await w.query<{ status: string }>("SELECT status FROM trading.quotes")
      )[0]!.status,
      "SIGN_REJECTED",
    );
    w.setSignerClock(Number(HEAD_TS) * 1000 + 1000);
    assert.deepEqual((await w.post("k")).json().details, res.json().details);
    assert.equal(w.signing.calls.length, 1);
    // The released collateral is available to the next request.
    assert.equal((await w.post("again")).statusCode, 200);
  } finally {
    await w.close();
  }
});

test("GET /v1/quotes/:id is visible to the quote's agent and to admins only, and never extends the quote", async () => {
  const w = await tradingWorld();
  try {
    const created = (await w.post("k")).json();
    const id = created.quoteId as string;
    const own = await w.get(id, w.agents.taker);
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.json().status, "SIGNED");
    assert.deepEqual(own.json().quote, created);
    assert.deepEqual(own.json().chainCursor, {
      blockNumber: "100",
      blockHash: blockHash(100),
      finality: "INCLUDED",
    });
    assert.equal((await w.get(id, w.agents.admin)).statusCode, 200);
    assert.equal((await w.get(id, w.agents.taker2)).statusCode, 404);
    assert.equal((await w.get(id)).statusCode, 401);
    assert.equal(
      (await w.get("0x" + "ab".repeat(32), w.agents.taker)).statusCode,
      404,
    );
    assert.equal((await w.get("not-a-hash", w.agents.taker)).statusCode, 400);
  } finally {
    await w.close();
  }
});

test("quote status follows canonical state: consumed, cancelled, epoch bump, block-time expiry", async () => {
  const w = await tradingWorld();
  try {
    const status = async (id: string) =>
      (await w.get(id, w.agents.taker)).json().status;
    const id = (await w.post("k")).json().quoteId as string;
    const digest = id.slice(2);
    assert.equal(await status(id), "SIGNED");

    // Expiry is the cursor's block time, not the host clock.
    await w.setDbClock(3600);
    assert.equal(await status(id), "SIGNED");
    await w.setDbClock(0);
    await w.setCursor({ number: 101n, timestamp: HEAD_TS + 30n });
    assert.equal(await status(id), "EXPIRED");
    await w.setCursor({ number: 100n, timestamp: HEAD_TS });

    await w.query("UPDATE chain.maker_state SET epoch=4");
    assert.equal(await status(id), "CANCELLED");
    await w.query("UPDATE chain.maker_state SET epoch=3");
    assert.equal(await status(id), "SIGNED");

    await w.query(
      `INSERT INTO chain.quote_digests(deployment_id,digest,state,block_number,block_hash,tx_hash)
      VALUES ($1,decode($2,'hex'),'CANCELLED',100,decode($3,'hex'),decode($3,'hex'))`,
      [DEPLOYMENT, digest, blockHash(100).slice(2)],
    );
    assert.equal(await status(id), "CANCELLED");
    await w.query("DELETE FROM chain.quote_digests");
    await w.query(
      `INSERT INTO chain.quote_digests(deployment_id,digest,state,market_id,taker,side,quantity,price_bps,taker_cost_micros,maker_cost_micros,block_number,block_hash,tx_hash)
      VALUES ($1,decode($2,'hex'),'FILLED',1,decode($3,'hex'),'YES',10,6200,6200000,3800000,100,decode($4,'hex'),decode($4,'hex'))`,
      [
        DEPLOYMENT,
        digest,
        testAccounts.taker.address.slice(2),
        blockHash(100).slice(2),
      ],
    );
    // A fill outranks every other state, expiry included.
    await w.setCursor({ number: 101n, timestamp: HEAD_TS + 3600n });
    assert.equal(await status(id), "CONSUMED");
  } finally {
    await w.close();
  }
});

test("the signer signs a quote only while a HELD reservation of the exact maker cost backs it", async () => {
  const w = await tradingWorld();
  try {
    const snapshot = await createSnapshotReader(
      postgresForecastStore(w.apiPool),
    ).latest(DEPLOYMENT, "1");
    const messageFor = (nonce: string) => ({
      marketId: "1",
      specHash: "0x" + "11".repeat(32),
      maker: testAccounts.maker.address.toLowerCase(),
      taker: testAccounts.taker.address.toLowerCase(),
      side: "0",
      quantity: "10",
      priceBps: "6200",
      validAfter: String(HEAD_TS),
      expiresAt: String(HEAD_TS + 30n),
      nonce,
      epoch: "3",
    });
    const sign = async (signRequestId: string, expectedRequestHash: string) => {
      const { status, body } = await w.signerService.handle(SIGNER_TOKEN, {
        signRequestId,
        expectedRequestHash,
      });
      return [status, body.code ?? body.state] as const;
    };
    // The quote and its reservation as the RFQ creates them; `makerCost` can be made wrong.
    const reserve = (nonce: string, makerCost = 3_800_000n) =>
      w.tradingStore.run(async (tx) => {
        const message = messageFor(nonce);
        const digest = quoteRequestHash(w.manifest, message);
        await tx.lockPool(DEPLOYMENT);
        const { signRequestId } = await tx.createQuote({
          id: randomUUID(),
          reservationId: randomUUID(),
          operatorId: w.agents.taker.operatorId,
          idempotencyKey: "direct-" + nonce,
          deploymentId: DEPLOYMENT,
          marketId: 1n,
          agentId: w.agents.taker.agentId,
          keyId: w.agents.taker.keyId,
          taker: message.taker as Hex,
          side: "YES",
          quantity: 10n,
          priceBps: 6200,
          takerCostMicros: 10_000_000n - makerCost,
          makerCostMicros: makerCost,
          maxCostMicros: 7_000_000n,
          validAfter: HEAD_TS,
          expiresAt: HEAD_TS + 30n,
          nonce: BigInt(nonce),
          epoch: 3n,
          specHash: message.specHash as Hex,
          digest,
          forecastSnapshotId: snapshot!.snapshotId,
          snapshotBlockNumber: HEAD_NUMBER,
          snapshotBlockHash: blockHash(HEAD_NUMBER),
          message,
          policyVersion: SIGNING_POLICY_VERSION,
        });
        return { signRequestId, digest };
      });

    // A quote nobody reserved collateral for.
    await w.owner(async () => undefined);
    const bare = await prepareRequest(w.t.pool as never, w.manifest, {
      kind: "MAKER_QUOTE",
      payload: messageFor("900"),
    });
    assert.deepEqual(await sign(bare.signRequestId, bare.requestHash), [
      422,
      "RESERVATION_MISSING",
    ]);

    const wrongAmount = await reserve("901", 4_000_000n);
    assert.deepEqual(
      await sign(wrongAmount.signRequestId, wrongAmount.digest),
      [422, "RESERVATION_MISSING"],
    );

    const released = await reserve("902");
    await w.query(
      "UPDATE trading.collateral_reservations SET state='RELEASED' WHERE amount_micros=3800000 AND state='HELD'",
    );
    assert.deepEqual(await sign(released.signRequestId, released.digest), [
      422,
      "RESERVATION_MISSING",
    ]);

    const expired = await reserve("903");
    await w.query(
      "UPDATE trading.quotes SET status='EXPIRED' WHERE digest=decode($1,'hex')",
      [expired.digest.slice(2)],
    );
    assert.deepEqual(await sign(expired.signRequestId, expired.digest), [
      422,
      "RESERVATION_MISSING",
    ]);

    const fresh = await reserve("904");
    assert.deepEqual(await sign(fresh.signRequestId, fresh.digest), [
      200,
      "SIGNED",
    ]);
    // A quote whose first signing outcome was unknown may be asked about again.
    const unknown = await reserve("905");
    await w.query(
      "UPDATE trading.quotes SET status='SIGN_UNKNOWN' WHERE digest=decode($1,'hex')",
      [unknown.digest.slice(2)],
    );
    assert.deepEqual(await sign(unknown.signRequestId, unknown.digest), [
      200,
      "SIGNED",
    ]);
  } finally {
    await w.close();
  }
});

test("readiness: /v1/config is truthful about trading, and canTrade names every reason", async () => {
  const w = await tradingWorld();
  try {
    const readiness = createTradingReadiness({
      store: w.tradingStore,
      snapshots: createSnapshotReader(postgresForecastStore(w.apiPool)),
      deploymentId: DEPLOYMENT,
    });
    const config = ConfigResponse.parse(await readiness.config());
    assert.equal(config.stage, "m2-trading");
    assert.equal(config.tradingEnabled, true);
    assert.equal(config.deployment?.deploymentId, DEPLOYMENT);
    assert.deepEqual(config.deployment?.contracts, w.manifest.contracts);
    // Only the public allow-list leaves: no git commit, no trading flag.
    assert.equal("tradingEnabled" in (config.deployment ?? {}), false);
    assert.equal("gitCommit" in (config.deployment?.artifacts ?? {}), false);

    const market = {
      deploymentId: DEPLOYMENT,
      marketId: "1",
      effectiveState: "OPEN",
      paused: false,
    } as IndexedMarketRow;
    assert.deepEqual(await readiness.canTrade(market, null), {
      canTrade: true,
      reasons: [],
    });

    await w.setDbClock(11);
    assert.equal((await readiness.config()).tradingEnabled, false);
    assert.deepEqual((await readiness.canTrade(market, null)).reasons, [
      "INDEXER_LAG",
    ]);
    await w.setDbClock(0);
    await w.query("UPDATE chain.cursors SET head_number=104");
    assert.equal((await readiness.config()).tradingEnabled, false);
    await w.query("UPDATE chain.cursors SET head_number=100");
    await w.query(
      "INSERT INTO trading.maker_pools(deployment_id,gate_reason) VALUES ($1,'OVERCOMMITTED')",
      [DEPLOYMENT],
    );
    assert.equal((await readiness.config()).tradingEnabled, false);
    assert.deepEqual((await readiness.canTrade(market, null)).reasons, [
      "SERVICE_NOT_READY",
    ]);
    await w.query("UPDATE trading.maker_pools SET gate_reason=NULL");
    await w.query(
      "INSERT INTO trading.quote_gates(id,deployment_id,market_id,reason,actor,note) VALUES (gen_random_uuid(),$1,1,'OPERATOR_PAUSE','op','pause')",
      [DEPLOYMENT],
    );
    assert.deepEqual((await readiness.canTrade(market, null)).reasons, [
      "OPERATOR_PAUSE",
    ]);
    assert.equal(
      (await readiness.config()).tradingEnabled,
      true,
      "a market gate closes the market, not the deployment",
    );
    assert.deepEqual(
      (
        await readiness.canTrade(
          { ...market, effectiveState: "CLOSED", paused: true },
          null,
        )
      ).reasons,
      ["MARKET_CLOSED", "TRADING_PAUSED", "OPERATOR_PAUSE"],
    );
    await w.query("UPDATE markets.deployments SET enabled=false");
    assert.equal((await readiness.config()).tradingEnabled, false);
    assert.ok(
      (await readiness.canTrade(market, null)).reasons.includes(
        "TRADING_DISABLED",
      ),
    );
  } finally {
    await w.close();
  }
});

test("readiness without a fresh ensemble reports NO_FORECAST; an unknown deployment publishes nothing", async () => {
  const w = await tradingWorld({ snapshot: false });
  try {
    const readiness = createTradingReadiness({
      store: w.tradingStore,
      snapshots: createSnapshotReader(postgresForecastStore(w.apiPool)),
      deploymentId: DEPLOYMENT,
    });
    const market = {
      deploymentId: DEPLOYMENT,
      marketId: "1",
      effectiveState: "OPEN",
      paused: false,
    } as IndexedMarketRow;
    assert.deepEqual(await readiness.canTrade(market, null), {
      canTrade: false,
      reasons: ["NO_FORECAST"],
    });
    const other = createTradingReadiness({
      store: w.tradingStore,
      snapshots: createSnapshotReader(postgresForecastStore(w.apiPool)),
      deploymentId: "missing",
    });
    const config = await other.config();
    assert.equal(config.deployment, null);
    assert.equal(config.tradingEnabled, false);
  } finally {
    await w.close();
  }
});
