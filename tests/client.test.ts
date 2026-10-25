import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256 } from "viem";
import {
  BlinkApiError,
  createBlinkClient,
} from "../packages/client/src/index.js";
import { configFromEnv, runAgent } from "../examples/agent/run.js";
import { testAccounts } from "./helpers/protocol-fixture.js";
import { protocolManifest } from "./helpers/protocol-index.js";

const DEPLOYMENT = "client-test";
const MARKET = "7";
const UUID = "00000000-0000-4000-8000-000000000001";
const HASH = "0x" + "ab".repeat(32);
const WALLET = testAccounts.taker.address.toLowerCase();
const API_KEY = "test-api-key";
const manifest = protocolManifest(DEPLOYMENT);
const SPEC_BYTES = Buffer.from(
  JSON.stringify(
    {
      schema: "blink.market-spec/0.2",
      title: "Will the Base Sepolia gas price exceed 1 gwei on 2026-12-01?",
      question: "Does the median gas price of block 1,000,000 exceed 1 gwei?",
      class: "B",
      resolution: { yes: "Median above 1 gwei.", no: "Median at or below 1 gwei." },
      sources: ["https://sepolia.basescan.org/"],
    },
    null,
    2,
  ),
);

type Seen = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: string;
};
type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
};

/** A real HTTP server on a loopback port that answers from a script and records what it was asked. */
async function scripted(respond: (seen: Seen, count: number) => Reply) {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url!, "http://127.0.0.1");
      const entry: Seen = {
        method: request.method!,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      const reply = respond(entry, seen.length);
      response.writeHead(reply.status ?? 200, {
        "Content-Type": "application/json",
        ...reply.headers,
      });
      response.end(
        reply.body instanceof Uint8Array
          ? reply.body
          : JSON.stringify(reply.body),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  return {
    origin,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
const apiError = (code: string, retryable: boolean, extra = {}) => ({
  code,
  message: code,
  requestId: "req-1",
  retryable,
  details: {},
  ...extra,
});

// --- schema-valid answers for every operation ---------------------------------------------
const cursor = {
  blockNumber: "12",
  blockHash: "0x" + "cd".repeat(32),
  finality: "INCLUDED",
};
const index = { headBlock: 12, indexedBlock: 12, lagSeconds: 0, stale: false };
const market = {
  marketId: MARKET,
  creator: WALLET,
  class: "A",
  state: "OPEN",
  templateId: HASH,
  specHash: HASH,
  specUri: "https://blink.example/v1/content/" + HASH,
  replay: false,
  openAt: 1000,
  closeAt: 2000,
  proposalDeadline: 3000,
  hardDeadline: 4000,
  maxPairs: "100",
  mintedPairs: "0",
  escrowMicros: "0",
  feePoolMicros: "0",
  finalOutcome: null,
  feesDistributed: false,
  creationChallenged: false,
};
const spec = JSON.parse(SPEC_BYTES.toString("utf8"));
const protocolPage = (item: unknown) => ({ items: [item], next: null, index });
const rfqId = "00000000-0000-4000-8000-0000000000aa";
const quote = {
  marketId: MARKET,
  specHash: HASH,
  maker: testAccounts.maker.address.toLowerCase(),
  taker: WALLET,
  side: "0",
  quantity: "10",
  priceBps: "4000",
  validAfter: "1000",
  expiresAt: "1030",
  nonce: "1",
  epoch: "0",
};
const signedQuote = { quote, signature: "0x" + "22".repeat(65) };
const horizonKey = {
  horizonType: "DAILY",
  scheduledAt: "2026-10-15T00:00:00.000Z",
} as const;
const forecast = {
  horizonKey,
  probability: 0.62,
  evidenceIds: [UUID],
  rationale: "fixture rationale",
  agentVersion: "v1",
} as const;
const forecastAnswer = {
  submissionId: UUID,
  receivedAt: "2026-10-15T00:00:01.000Z",
  windowId: UUID,
};
const page = (item: unknown) => ({ items: [item], nextCursor: null });
const marketRef = { deploymentId: DEPLOYMENT, marketId: MARKET };

type Case = {
  name: string;
  call: (client: ReturnType<typeof createBlinkClient>) => Promise<unknown>;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  answer: unknown;
  status?: number;
  /** false: the contract defines no Idempotency-Key for this call. */
  idempotent?: boolean;
};
const cases: Case[] = [
  {
    name: "getConfig",
    call: (c) => c.getConfig(),
    method: "GET",
    path: "/v1/config",
    answer: {
      chainId: 84532,
      stage: "m2-trading",
      tradingEnabled: false,
      deployment: null,
      asset: {
        name: "Blink Test USD",
        symbol: "bUSD",
        decimals: 6,
        hasValue: false,
      },
    },
  },
  {
    name: "listMarkets",
    call: (c) => c.listMarkets({ state: "OPEN", limit: 5, after: "3" }),
    method: "GET",
    path: "/v1/markets",
    query: { state: "OPEN", limit: "5", after: "3" },
    answer: protocolPage(market),
  },
  {
    name: "getMarket",
    call: (c) => c.getMarket(MARKET),
    method: "GET",
    path: "/v1/markets/" + MARKET,
    answer: { ...market, index },
  },
  {
    name: "getDeployment",
    call: (c) => c.getDeployment(),
    method: "GET",
    path: "/v1/deployment",
    answer: manifest,
  },
  {
    name: "listDisputes",
    call: (c) => c.listDisputes(MARKET, { limit: 2 }),
    method: "GET",
    path: `/v1/markets/${MARKET}/disputes`,
    query: { limit: "2" },
    answer: protocolPage({ disputeId: "1" }),
  },
  {
    name: "getDispute",
    call: (c) => c.getDispute("1"),
    method: "GET",
    path: "/v1/disputes/1",
    answer: { disputeId: "1", index },
  },
  {
    name: "getFees",
    call: (c) => c.getFees(MARKET),
    method: "GET",
    path: `/v1/markets/${MARKET}/fees`,
    answer: { feePoolMicros: "0", index },
  },
  {
    name: "getAccount",
    call: (c) => c.getAccount(WALLET),
    method: "GET",
    path: `/v1/accounts/${WALLET}`,
    answer: { address: WALLET, index },
  },
  {
    name: "listTemplates",
    call: (c) => c.listTemplates(),
    method: "GET",
    path: "/v1/templates",
    answer: protocolPage({ templateId: HASH }),
  },
  {
    name: "listForecastWindows",
    call: (c) => c.listForecastWindows(marketRef, { limit: 3, cursor: "c1" }),
    method: "GET",
    path: `/v1/markets/${MARKET}/forecast-windows`,
    query: { deploymentId: DEPLOYMENT, limit: "3", cursor: "c1" },
    answer: page({
      windowId: UUID,
      horizonKey,
      openAt: "2026-10-14T23:30:00.000Z",
      deadline: "2026-10-15T00:00:00.000Z",
      status: "OPEN",
    }),
  },
  {
    name: "submitForecast",
    call: (c) => c.submitForecast(marketRef, forecast, "forecast-key"),
    method: "POST",
    path: `/v1/markets/${MARKET}/forecasts`,
    query: { deploymentId: DEPLOYMENT },
    body: forecast,
    answer: {
      submissionId: UUID,
      receivedAt: "2026-10-15T00:00:01.000Z",
      windowId: UUID,
    },
    status: 201,
  },
  {
    name: "listForecasts",
    call: (c) => c.listForecasts(marketRef, { windowId: UUID }),
    method: "GET",
    path: `/v1/markets/${MARKET}/forecasts`,
    query: { deploymentId: DEPLOYMENT, windowId: UUID, limit: "20" },
    answer: page({
      submissionId: UUID,
      agentId: UUID,
      windowId: UUID,
      probability: 0.62,
      receivedAt: "2026-10-15T00:00:01.000Z",
      evidenceIds: [UUID],
      rationale: "fixture rationale",
      agentVersion: "v1",
      withdrawnAt: null,
      contaminated: false,
    }),
  },
  {
    name: "trackTransaction",
    call: (c) => c.trackTransaction({ txHash: HASH }),
    method: "POST",
    path: "/v1/transactions",
    body: { txHash: HASH },
    answer: { trackingId: UUID, status: "UNKNOWN" },
    status: 202,
    idempotent: false,
  },
  {
    name: "createRfq",
    call: (c) => c.createRfq({ marketId: MARKET, side: "YES", quantity: "10" }),
    method: "POST",
    path: "/v1/rfqs",
    body: { marketId: MARKET, side: "YES", quantity: "10" },
    answer: { rfqId, expiresAt: 1030 },
    status: 201,
    idempotent: false,
  },
  {
    name: "listRfqs",
    call: (c) => c.listRfqs({ limit: 10, after: "4" }),
    method: "GET",
    path: "/v1/rfqs",
    query: { limit: "10", after: "4" },
    answer: {
      items: [
        {
          rfqId,
          marketId: MARKET,
          specHash: HASH,
          side: "YES",
          quantity: "10",
          taker: WALLET,
          expiresAt: 1030,
        },
      ],
      next: null,
    },
  },
  {
    name: "postQuote",
    call: (c) => c.postQuote(rfqId, signedQuote),
    method: "POST",
    path: `/v1/rfqs/${rfqId}/quotes`,
    body: signedQuote,
    answer: { digest: HASH },
    status: 201,
    idempotent: false,
  },
  {
    name: "listQuotes",
    call: (c) => c.listQuotes(rfqId),
    method: "GET",
    path: `/v1/rfqs/${rfqId}/quotes`,
    answer: { items: [signedQuote] },
  },
  {
    name: "getMakerStats",
    call: (c) => c.getMakerStats(WALLET),
    method: "GET",
    path: `/v1/makers/${WALLET}/stats`,
    answer: {
      quotesRelayed: 3,
      quotesFilled: 1,
      quotesCancelledBeforeExpiry: 0,
    },
  },
  {
    name: "getTransaction",
    call: (c) => c.getTransaction({ deploymentId: DEPLOYMENT, txHash: HASH }),
    method: "GET",
    path: "/v1/transactions/" + HASH,
    query: { deploymentId: DEPLOYMENT },
    answer: {
      deploymentId: DEPLOYMENT,
      txHash: HASH,
      status: "INCLUDED",
      replacementOf: null,
      rejectReason: null,
      chainCursor: cursor,
    },
  },
  {
    name: "getPositions",
    call: (c) => c.getPositions(WALLET, { limit: 50 }),
    method: "GET",
    path: `/v1/accounts/${WALLET}/positions`,
    query: { limit: "50" },
    answer: protocolPage({ marketId: MARKET, yes: "10", no: "0" }),
  },
  {
    name: "getMetrics",
    call: (c) => c.getMetrics("REPLAY"),
    method: "GET",
    path: "/v1/metrics",
    query: { mode: "REPLAY" },
    answer: {
      mode: "REPLAY",
      eventCount: "4",
      missingCount: "0",
      invalidCount: "0",
      brier: 0.25,
    },
  },
  {
    name: "createWalletChallenge",
    call: (c) => c.createWalletChallenge({ address: WALLET, action: "issue" }),
    idempotent: false,
    method: "POST",
    path: "/v1/auth/wallet-challenges",
    body: { address: WALLET, action: "issue" },
    answer: {
      challengeId: UUID,
      message: "Bind this wallet to Blink",
      expiresAt: "2026-10-15T00:10:00.000Z",
    },
    status: 201,
  },
  {
    name: "verifyWallet",
    call: (c) =>
      c.verifyWallet({ challengeId: UUID, signature: "0x" + "22".repeat(65) }),
    idempotent: false,
    method: "POST",
    path: "/v1/auth/wallet-verifications",
    body: { challengeId: UUID, signature: "0x" + "22".repeat(65) },
    answer: {
      apiKey: API_KEY,
      keyId: UUID,
      expiresAt: "2026-11-14T00:00:00.000Z",
    },
  },
];

for (const c of cases) {
  test(`${c.name} sends ${c.method} ${c.path.replace(/0x[0-9a-f]{40,64}/g, "0x…")} with the bearer key and returns the validated answer`, async () => {
    const server = await scripted(() => ({
      status: c.status ?? 200,
      body: c.answer,
    }));
    try {
      const result = await c.call(createBlinkClient(server.origin, API_KEY));
      assert.deepEqual(result, c.answer);
      assert.equal(server.seen.length, 1);
      const [request] = server.seen;
      assert.equal(request!.method, c.method);
      assert.equal(request!.path, c.path);
      assert.deepEqual(request!.query, c.query ?? {});
      assert.equal(request!.headers.authorization, "Bearer " + API_KEY);
      if (c.method === "POST") {
        assert.deepEqual(JSON.parse(request!.body), c.body);
        assert.equal(request!.headers["content-type"], "application/json");
        // The wallet endpoints are public and single use: no key is sent for them.
        if (c.idempotent === false)
          assert.equal(request!.headers["idempotency-key"], undefined);
        else assert.ok(request!.headers["idempotency-key"]);
      } else assert.equal(request!.headers["idempotency-key"], undefined);
    } finally {
      await server.close();
    }
  });
}

test("a POST without a key gets a fresh UUID per call; a given key is sent as it is", async () => {
  const server = await scripted(() => ({
    status: 202,
    body: forecastAnswer,
  }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    await client.submitForecast(marketRef, forecast);
    await client.submitForecast(marketRef, forecast);
    await client.submitForecast(marketRef, forecast, "my-own-key");
    const keys = server.seen.map((s) => s.headers["idempotency-key"]);
    assert.match(String(keys[0]), /^[0-9a-f-]{36}$/);
    assert.match(String(keys[1]), /^[0-9a-f-]{36}$/);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(keys[2], "my-own-key");
  } finally {
    await server.close();
  }
});

test("a malformed key or a body that breaks the contract never leaves the process", async () => {
  const server = await scripted(() => ({ body: {} }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    await assert.rejects(
      client.submitForecast(marketRef, forecast, "has space"),
    );
    await assert.rejects(
      client.submitForecast(marketRef, forecast, "x".repeat(129)),
    );
    await assert.rejects(
      client.submitForecast(marketRef, { ...forecast, probability: 2 }),
    );
    await assert.rejects(
      client.submitForecast(marketRef, { ...forecast, rationale: "" }),
    );
    await assert.rejects(
      client.getTransaction({ deploymentId: DEPLOYMENT, txHash: "0x12" }),
    );
    await assert.rejects(client.getMetrics("MAINNET" as never));
    assert.equal(server.seen.length, 0);
  } finally {
    await server.close();
  }
});

test("a retryable refusal is retried with the same key and the same body, waiting as the server asks", async () => {
  const slept: number[] = [];
  const server = await scripted((_seen, count) =>
    count === 1
      ? {
          status: 503,
          headers: { "Retry-After": "1" },
          body: apiError("SERVICE_NOT_READY", true),
        }
      : count === 2
        ? {
            status: 409,
            headers: { "Retry-After": "2" },
            body: apiError("REQUEST_IN_PROGRESS", true),
          }
        : { body: forecastAnswer },
  );
  try {
    const client = createBlinkClient(server.origin, API_KEY, {
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    });
    // No key given: the client picks one and keeps it for every attempt.
    assert.deepEqual(
      await client.submitForecast(marketRef, forecast),
      forecastAnswer,
    );
    assert.equal(server.seen.length, 3);
    const keys = new Set(server.seen.map((s) => s.headers["idempotency-key"]));
    assert.equal(keys.size, 1);
    assert.match([...keys][0] as string, /^[0-9a-f-]{36}$/);
    assert.equal(new Set(server.seen.map((s) => s.body)).size, 1);
    assert.deepEqual(slept, [1000, 2000]);
  } finally {
    await server.close();
  }
});

test("without Retry-After the wait grows, and the answer after the last attempt is thrown as it is", async () => {
  const slept: number[] = [];
  const server = await scripted(() => ({
    status: 503,
    body: apiError("CHAIN_UNAVAILABLE", true),
  }));
  try {
    const client = createBlinkClient(server.origin, API_KEY, {
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    });
    await assert.rejects(
      client.submitForecast(marketRef, forecast, "stuck"),
      (error) =>
        error instanceof BlinkApiError &&
        error.status === 503 &&
        error.body.code === "CHAIN_UNAVAILABLE",
    );
    assert.equal(server.seen.length, 3);
    assert.equal(slept.length, 2);
    assert.ok(slept[0]! > 0 && slept[1]! > slept[0]!);
    // A single attempt never sleeps.
    slept.length = 0;
    server.seen.length = 0;
    await assert.rejects(
      createBlinkClient(server.origin, API_KEY, {
        maxAttempts: 1,
        sleep: async (milliseconds) => {
          slept.push(milliseconds);
        },
      }).submitForecast(marketRef, forecast, "once"),
      BlinkApiError,
    );
    assert.deepEqual([server.seen.length, slept.length], [1, 0]);
  } finally {
    await server.close();
  }
});

test("a business refusal is final, and reads are retried too", async () => {
  const slept: number[] = [];
  const noQuote = await scripted(() => ({
    status: 409,
    body: apiError("NO_QUOTE", false, { details: { reason: "CAP_EXCEEDED" } }),
  }));
  const limited = await scripted((_seen, count) =>
    count === 1
      ? {
          status: 429,
          headers: { "Retry-After": "3" },
          body: apiError("RATE_LIMITED", true),
        }
      : { body: protocolPage(market) },
  );
  const options = {
    sleep: async (milliseconds: number) => {
      slept.push(milliseconds);
    },
  };
  try {
    await assert.rejects(
      createBlinkClient(noQuote.origin, API_KEY, options).submitForecast(
        marketRef,
        forecast,
        "k",
      ),
      (error) =>
        error instanceof BlinkApiError &&
        error.body.details["reason"] === "CAP_EXCEEDED",
    );
    assert.equal(noQuote.seen.length, 1);
    await createBlinkClient(limited.origin, API_KEY, options).listMarkets();
    assert.equal(limited.seen.length, 2);
    assert.deepEqual(slept, [3000]);
  } finally {
    await noQuote.close();
    await limited.close();
  }
});

test("the default policy really waits, and never longer than ten seconds", async () => {
  const server = await scripted((_seen, count) =>
    count === 1
      ? {
          status: 503,
          headers: { "Retry-After": "0" },
          body: apiError("INDEXER_LAG", true),
        }
      : { body: forecastAnswer },
  );
  try {
    const started = Date.now();
    await createBlinkClient(server.origin, API_KEY).submitForecast(
      marketRef,
      forecast,
      "k",
    );
    assert.equal(server.seen.length, 2);
    assert.ok(Date.now() - started < 5000);
  } finally {
    await server.close();
  }
  const slept: number[] = [];
  const slow = await scripted((_seen, count) =>
    count === 1
      ? {
          status: 503,
          headers: { "Retry-After": "3600" },
          body: apiError("INDEXER_LAG", true),
        }
      : { body: forecastAnswer },
  );
  try {
    await createBlinkClient(slow.origin, API_KEY, {
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    }).submitForecast(marketRef, forecast, "k");
    assert.deepEqual(slept, [10_000]);
  } finally {
    await slow.close();
  }
});

test("getMarketSpec returns the spec only when the bytes hash to the expected specHash", async () => {
  const specHash = keccak256(SPEC_BYTES);
  const altered = Buffer.from(
    SPEC_BYTES.toString("utf8").replace(
      "exceed 1 gwei on",
      "exceed 2 gwei on",
    ),
  );
  assert.notEqual(altered.toString(), SPEC_BYTES.toString());
  let served: Uint8Array = SPEC_BYTES;
  const server = await scripted(() => ({ body: served }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    assert.deepEqual(await client.getMarketSpec(MARKET, specHash), spec);
    assert.equal(server.seen[0]!.path, `/v1/markets/${MARKET}/spec`);
    assert.deepEqual(server.seen[0]!.query, {});
    // The hash may be written in either case.
    assert.deepEqual(
      await client.getMarketSpec(
        MARKET,
        specHash.toUpperCase().replace("0X", "0x"),
      ),
      spec,
    );
    served = altered;
    await assert.rejects(
      client.getMarketSpec(MARKET, specHash),
      /HASH_MISMATCH/,
    );
    // Bytes that match their hash but are not a market spec are refused as well.
    const notSpec = Buffer.from('{"schemaVersion":"other"}');
    served = notSpec;
    await assert.rejects(client.getMarketSpec(MARKET, keccak256(notSpec)));
    // And a wrong expectation is refused even though the server's bytes are fine.
    served = SPEC_BYTES;
    await assert.rejects(
      client.getMarketSpec(MARKET, "0x" + "00".repeat(32)),
      /HASH_MISMATCH/,
    );
  } finally {
    await server.close();
  }
});

test("the retired v0.1 execution methods are gone, not stubbed", () => {
  const client = createBlinkClient("https://blink.example") as Record<string, unknown>;
  for (const name of ["requestQuote", "getQuote", "claimFaucet", "getResolution"])
    assert.equal(client[name], undefined, name);
});

test("getMarket accepts the market flattened or nested, and getDeployment the manifest bare or wrapped", async () => {
  const flat = { ...market, spec: { a: 1 }, proposal: null, index };
  let served: unknown = flat;
  const server = await scripted(() => ({ body: served }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    assert.deepEqual(await client.getMarket(MARKET), flat);
    served = { market, spec: { a: 1 }, index };
    assert.equal((await client.getMarket(MARKET)).marketId, MARKET);
    served = { deployment: manifest, index };
    assert.equal((await client.getDeployment()).deploymentId, DEPLOYMENT);
    served = { ...manifest, index };
    assert.equal((await client.getDeployment()).deploymentId, DEPLOYMENT);
    served = { ...market, closeAt: "soon" };
    await assert.rejects(client.getMarket(MARKET));
  } finally {
    await server.close();
  }
});

test("uploadContent sends the raw bytes and accepts only an answer that names their keccak256 hash", async () => {
  const bytes = Buffer.from('{"hello":"world"}');
  const hash = keccak256(bytes);
  let answer: unknown = {
    hash,
    size: bytes.length,
    mediaType: "application/json",
    uri: "https://blink.example/v1/content/" + hash,
  };
  const server = await scripted(() => ({ status: 201, body: answer }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    assert.deepEqual(await client.uploadContent(bytes, "application/json"), answer);
    const [seen] = server.seen;
    assert.equal(seen!.method, "POST");
    assert.equal(seen!.path, "/v1/content");
    assert.equal(seen!.headers["content-type"], "application/json");
    assert.equal(seen!.body, bytes.toString());
    answer = { ...(answer as object), hash: HASH };
    await assert.rejects(client.uploadContent(bytes, "application/json"), /HASH_MISMATCH/);
    answer = { ...(answer as object), hash, size: 3 };
    await assert.rejects(client.uploadContent(bytes, "application/json"), /HASH_MISMATCH/);
  } finally {
    await server.close();
  }
});

test("getContent returns bytes only when they hash to the name asked for", async () => {
  const bytes = Buffer.from("proof");
  let served: Uint8Array = bytes;
  const server = await scripted(() => ({ body: served }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    assert.deepEqual(Buffer.from(await client.getContent(keccak256(bytes))), bytes);
    served = Buffer.from("forged");
    await assert.rejects(client.getContent(keccak256(bytes)), /HASH_MISMATCH/);
  } finally {
    await server.close();
  }
});

test("suggestions are submitted without a key and listed, read and claimed through the contract", async () => {
  const suggestion = {
    id: UUID,
    text: "Will it rain?",
    sourceUrls: [],
    status: "OPEN",
    claimCount: 0,
    specHashes: [],
    createdAt: "2026-10-15T00:00:00.000Z",
  };
  const server = await scripted((seen) => ({
    status: seen.method === "POST" ? 201 : 200,
    body:
      seen.path === "/v1/suggestions" && seen.method === "POST"
        ? { id: UUID }
        : seen.path === "/v1/suggestions"
          ? { items: [suggestion], nextCursor: null }
          : suggestion,
  }));
  try {
    const client = createBlinkClient(server.origin);
    assert.deepEqual(await client.submitSuggestion({ text: "Will it rain in Taipei tomorrow afternoon?", sourceUrls: [] }), { id: UUID });
    await client.listSuggestions({ status: "OPEN", limit: 5 });
    await client.getSuggestion(UUID);
    await client.claimSuggestion(UUID);
    assert.deepEqual(
      server.seen.map((s) => [s.method, s.path]),
      [
        ["POST", "/v1/suggestions"],
        ["GET", "/v1/suggestions"],
        ["GET", "/v1/suggestions/" + UUID],
        ["POST", "/v1/suggestions/" + UUID + "/claims"],
      ],
    );
    assert.deepEqual(server.seen[1]!.query, { status: "OPEN", limit: "5" });
  } finally {
    await server.close();
  }
});

test("an RFQ body or a quote that breaks the contract never leaves the process", async () => {
  const server = await scripted(() => ({ body: {} }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    await assert.rejects(client.createRfq({ marketId: MARKET, side: "MAYBE", quantity: "1" }));
    await assert.rejects(client.createRfq({ marketId: MARKET, side: "YES", quantity: "1", extra: 1 }));
    await assert.rejects(client.postQuote(rfqId, { quote: { ...quote, priceBps: "70000" }, signature: signedQuote.signature }));
    await assert.rejects(client.postQuote("not-a-uuid", signedQuote));
    await assert.rejects(client.trackTransaction({ txHash: "0x12" }));
    assert.equal(server.seen.length, 0);
  } finally {
    await server.close();
  }
});

test("an answer that breaks the contract is an error, an API refusal is a BlinkApiError, and loopback http is the only http", async () => {
  const server = await scripted((seen) =>
    seen.path === "/v1/config"
      ? { body: { chainId: 1 } }
      : { status: 404, body: apiError("NOT_FOUND", false) },
  );
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    await assert.rejects(
      client.getConfig(),
      (error) => !(error instanceof BlinkApiError),
    );
    await assert.rejects(
      client.getMarket(MARKET),
      (error) => error instanceof BlinkApiError && error.status === 404,
    );
  } finally {
    await server.close();
  }
  assert.throws(() => createBlinkClient("http://blink.test"), /HTTPS_REQUIRED/);
});

test("the example agent refuses a node that is not local or not chain 84532 before it touches the API", async () => {
  const dummyKey = ("0x" + "11".repeat(32)) as `0x${string}`;
  const api = await scripted(() => ({ body: {} }));
  const nodeOn = (chainId: string) =>
    scripted((seen) => ({
      body: {
        jsonrpc: "2.0",
        id: (JSON.parse(seen.body) as { id: number }).id,
        result: chainId,
      },
    }));
  const mainnet = await nodeOn("0x2105"); // chain ID 8453
  const other = await nodeOn("0x1"); // chain ID 1
  try {
    const agent = (rpcUrl: string) =>
      runAgent({
        apiUrl: api.origin,
        privateKey: dummyKey,
        rpcUrl,
        log: () => undefined,
      });
    await assert.rejects(
      agent("https://rpc.blink.invalid"),
      /RPC_NOT_LOOPBACK/,
    );
    // Base mainnet has its own refusal (the global MAINNET_REFUSED); any other chain is a mismatch.
    await assert.rejects(agent(mainnet.origin), /MAINNET_REFUSED/);
    await assert.rejects(agent(other.origin), /RPC_CHAIN_MISMATCH/);
    assert.equal(mainnet.seen.length, 1);
    assert.equal(other.seen.length, 1);
    assert.equal(api.seen.length, 0);
  } finally {
    await api.close();
    await mainnet.close();
    await other.close();
  }
  assert.throws(() => configFromEnv({}), /BLINK_API_URL/);
  assert.deepEqual(
    configFromEnv({
      BLINK_API_URL: "http://127.0.0.1:3001",
      AGENT_PRIVATE_KEY: dummyKey,
      RPC_URL: "http://127.0.0.1:8545",
    }),
    {
      apiUrl: "http://127.0.0.1:3001",
      privateKey: dummyKey,
      rpcUrl: "http://127.0.0.1:8545",
    },
  );
});

test("SDK refuses mainnet config and embedded domains before response parsing", async () => {
  for (const body of [
    { chainId: 8453 },
    { deployment: { chainId: 8453 } },
    { domain: { chainId: 8453 } },
  ]) {
    const server = await scripted(() => ({ body }));
    try {
      const client = createBlinkClient(server.origin);
      await assert.rejects(client.getConfig(), /MAINNET_REFUSED/);
    } finally {
      await server.close();
    }
  }
});
