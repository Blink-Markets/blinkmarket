import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256 } from "viem";
import { RoleName } from "../packages/schemas/src/index.js";
import {
  BlinkApiError,
  createBlinkClient,
  forecastDigest,
  forecastLeaf,
  forecastTypedData,
} from "../packages/client/src/index.js";
import { loadAgentEnv } from "../examples/agents/src/lib/env.ts";
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
      resolution: {
        yes: "Median above 1 gwei.",
        no: "Median at or below 1 gwei.",
      },
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
const specResult = { ok: true, spec };
const marketsPage = {
  items: [{ market, spec: specResult }],
  next: null,
  index,
};
const dispute = {
  disputeId: "1",
  marketId: MARKET,
  kind: "RESULT",
  ground: 0,
  challenger: WALLET,
  evidenceHash: HASH,
  currentRound: 1,
  appealRound: 0,
  settled: false,
  timedOut: false,
  finalChoice: null,
};
const round = {
  disputeId: "1",
  round: 1,
  level: 0,
  snapshotAt: 10,
  commitEnd: 20,
  revealEnd: 30,
  appealEnd: 40,
  committedWeight: "5",
  revealedWeight: ["0", "0"],
  committers: 1,
  revealers: 0,
  leadingChoice: 0,
  restarted: false,
  settled: false,
  creditThreshold: 0,
};
const templatesPage = {
  items: [
    { templateId: HASH, class: "B", parserHash: HASH, uri: "ipfs://template" },
  ],
  next: null,
  index,
};
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
const forecast = {
  horizon: 0,
  scheduledAt: 1793016600,
  probabilityBps: 6200,
  contentHash: "0x" + "00".repeat(32),
  signature: "0x" + "22".repeat(65),
} as const;
const forecastAnswer = { digest: HASH, leaf: HASH };
const trackAnswer = { trackingId: UUID, status: "UNKNOWN" };
const windowView = {
  windowId: UUID,
  horizon: 0,
  horizonType: "DAILY",
  scheduledAt: 1793016600,
  openAt: 1793014800,
  deadline: 1793016600,
  status: "OPEN",
  root: null,
  rootAt: null,
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
    answer: marketsPage,
  },
  {
    name: "getMarket",
    call: (c) => c.getMarket(marketRef),
    method: "GET",
    path: "/v1/markets/" + MARKET,
    answer: { market, spec: specResult, proposal: null, index },
  },
  {
    name: "getDeployment",
    call: (c) => c.getDeployment(),
    method: "GET",
    path: "/v1/deployment",
    answer: { deployment: manifest, index },
  },
  {
    name: "listDisputes",
    call: (c) => c.listDisputes(marketRef, { limit: 2 }),
    method: "GET",
    path: `/v1/markets/${MARKET}/disputes`,
    query: { limit: "2" },
    answer: { items: [dispute], next: null, index },
  },
  {
    name: "getDispute",
    call: (c) => c.getDispute({ disputeId: "1" }, { round: 1 }),
    method: "GET",
    path: "/v1/disputes/1",
    query: { round: "1", limit: "20" },
    answer: { dispute, rounds: [round], votes: [], next: null, index },
  },
  {
    name: "getFees",
    call: (c) => c.getFees(marketRef),
    method: "GET",
    path: `/v1/markets/${MARKET}/fees`,
    answer: { marketId: MARKET, fees: null, index },
  },
  {
    name: "getAccount",
    call: (c) => c.getAccount({ address: WALLET }),
    method: "GET",
    path: `/v1/accounts/${WALLET}`,
    answer: {
      address: WALLET,
      registered: true,
      creditAt: 100,
      roles: Object.fromEntries(
        RoleName.options.map((role) => [
          role,
          {
            hasRole: role === "TAKER",
            stakeMicros: role === "TAKER" ? "100000000" : "0",
            active: role === "TAKER",
            exitRequestedAt: null,
            openObligations: 0,
            credit: 0,
          },
        ]),
      ),
      juror: null,
      index,
    },
  },
  {
    name: "listTemplates",
    call: (c) => c.listTemplates(),
    method: "GET",
    path: "/v1/templates",
    query: { limit: "20" },
    answer: templatesPage,
  },
  {
    name: "listForecastWindows",
    call: (c) =>
      c.listForecastWindows({ marketId: MARKET }, { limit: 3, cursor: "c1" }),
    method: "GET",
    path: `/v1/markets/${MARKET}/forecast-windows`,
    query: { limit: "3", cursor: "c1" },
    answer: page(windowView),
  },
  {
    name: "submitForecast",
    call: (c) => c.submitForecast({ marketId: MARKET }, forecast),
    method: "POST",
    path: `/v1/markets/${MARKET}/forecasts`,
    body: forecast,
    answer: forecastAnswer,
    status: 201,
  },
  {
    name: "listForecasts",
    call: (c) => c.listForecasts({ marketId: MARKET }, { windowId: UUID }),
    method: "GET",
    path: `/v1/markets/${MARKET}/forecasts`,
    query: { windowId: UUID, limit: "20" },
    answer: page({
      submissionId: UUID,
      windowId: UUID,
      forecaster: WALLET,
      probabilityBps: 6200,
      contentHash: forecast.contentHash,
      digest: HASH,
      leaf: HASH,
      signature: forecast.signature,
      verifiedBlock: 12,
      receivedAt: 1793016000,
      withdrawnAt: null,
    }),
  },
  {
    name: "getForecastWindow",
    call: (c) => c.getForecastWindow({ windowId: UUID }),
    method: "GET",
    path: `/v1/forecast-windows/${UUID}`,
    answer: {
      ...windowView,
      marketId: MARKET,
      leaves: [HASH],
      anchor: null,
      index,
    },
  },
  {
    name: "getForecastProof",
    call: (c) => c.getForecastProof({ windowId: UUID }, HASH),
    method: "GET",
    path: `/v1/forecast-windows/${UUID}/proof`,
    query: { leaf: HASH },
    answer: { root: HASH, leaf: HASH, proof: [] },
  },
  {
    name: "getConsensus",
    call: (c) => c.getConsensus({ marketId: MARKET }),
    method: "GET",
    path: `/v1/markets/${MARKET}/consensus`,
    query: { limit: "20" },
    answer: page({
      windowId: UUID,
      horizon: 0,
      horizonType: "DAILY",
      scheduledAt: 1793016600,
      deadline: 1793016600,
      probabilityBps: 4500,
      submissions: 2,
      contaminated: false,
    }),
  },
  {
    name: "listForecasters",
    call: (c) => c.listForecasters(),
    method: "GET",
    path: "/v1/forecasters",
    query: { sort: "weight", limit: "20" },
    answer: page({ address: WALLET, n: 5, meanBrier: 0.1, weightNumerator: "3", weightDenominator: "20" }),
  },
  {
    name: "getForecaster",
    call: (c) => c.getForecaster({ address: WALLET }),
    method: "GET",
    path: `/v1/forecasters/${WALLET}`,
    answer: { address: WALLET, n: 5, meanBrier: 0.1, weightNumerator: "3", weightDenominator: "20" },
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
    call: (c) => c.getPositions({ address: WALLET }, { limit: 50 }),
    method: "GET",
    path: `/v1/accounts/${WALLET}/positions`,
    query: { limit: "50" },
    answer: {
      items: [
        {
          marketId: MARKET,
          account: WALLET,
          yesShares: "10",
          noShares: "0",
          takerBoughtShares: "10",
          redeemedPayoutMicros: "0",
          marketState: "OPEN",
          finalOutcome: null,
          payoutMicros: null,
        },
      ],
      next: null,
      index,
    },
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
      consensusBrier: 0.2,
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

test("a forecast POST without a key gets a fresh UUID per call; a given key is sent as it is", async () => {
  const server = await scripted(() => ({ status: 201, body: forecastAnswer }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    const ref = { marketId: MARKET };
    await client.submitForecast(ref, forecast);
    await client.submitForecast(ref, forecast);
    await client.submitForecast(ref, forecast, "my-own-key");
    const keys = server.seen.map((s) => s.headers["idempotency-key"]);
    assert.match(String(keys[0]), /^[0-9a-f-]{36}$/);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(keys[2], "my-own-key");
    // A malformed key never leaves the process.
    await assert.rejects(client.submitForecast(ref, forecast, "has space"));
    assert.equal(server.seen.length, 3);
  } finally {
    await server.close();
  }
});

test("a malformed body or query never leaves the process", async () => {
  const server = await scripted(() => ({ body: {} }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    await assert.rejects(
      client.submitForecast(
        { marketId: MARKET },
        { ...forecast, probabilityBps: 10000 },
      ),
    );
    await assert.rejects(
      client.submitForecast(
        { marketId: MARKET },
        { ...forecast, rationale: "x" },
      ),
    );
    await assert.rejects(client.getForecastProof({ windowId: UUID }, "0x12"));
    await assert.rejects(
      client.getTransaction({ deploymentId: DEPLOYMENT, txHash: "0x12" }),
    );
    await assert.rejects(client.getMetrics("MAINNET" as never));
    assert.equal(server.seen.length, 0);
  } finally {
    await server.close();
  }
});

test("withdrawing sends no body and no key", async () => {
  const server = await scripted(() => ({
    body: { submissionId: UUID, withdrawnAt: 1793016000 },
  }));
  try {
    await createBlinkClient(server.origin, API_KEY).withdrawForecast({
      submissionId: UUID,
    });
    const [seen] = server.seen;
    assert.deepEqual(
      [seen!.method, seen!.path, seen!.body],
      ["POST", `/v1/forecasts/${UUID}/withdrawal`, ""],
    );
    assert.equal(seen!.headers["idempotency-key"], undefined);
    // A body-less POST must not claim a JSON body: Fastify answers an empty one with 400.
    assert.equal(seen!.headers["content-type"], undefined);
  } finally {
    await server.close();
  }
});

test("a forecast digest and leaf the client computes are the ones the platform returns", () => {
  const message = {
    forecaster: WALLET,
    markets: manifest.generation.markets,
    marketId: MARKET,
    horizon: 0 as const,
    scheduledAt: 1793016600,
    probabilityBps: 6200,
    contentHash: forecast.contentHash,
  };
  const digest = forecastDigest({ anchor: manifest.shared.anchor, message });
  assert.match(digest, /^0x[0-9a-f]{64}$/);
  assert.equal(forecastLeaf(digest), keccak256(keccak256(digest)));
  assert.equal(
    forecastTypedData({ anchor: manifest.shared.anchor, message }).domain.name,
    "Blink Forecast",
  );
});

test("a retryable refusal is retried with the same body, waiting as the server asks", async () => {
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
        : { body: trackAnswer },
  );
  try {
    const client = createBlinkClient(server.origin, API_KEY, {
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    });
    // The body is the same on every attempt.
    assert.deepEqual(
      await client.trackTransaction({ txHash: HASH }),
      trackAnswer,
    );
    assert.equal(server.seen.length, 3);
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
      client.trackTransaction({ txHash: HASH }),
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
      }).trackTransaction({ txHash: HASH }),
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
      : { body: marketsPage },
  );
  const options = {
    sleep: async (milliseconds: number) => {
      slept.push(milliseconds);
    },
  };
  try {
    await assert.rejects(
      createBlinkClient(noQuote.origin, API_KEY, options).trackTransaction({
        txHash: HASH,
      }),
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
      : { body: trackAnswer },
  );
  try {
    const started = Date.now();
    await createBlinkClient(server.origin, API_KEY).trackTransaction({
      txHash: HASH,
    });
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
      : { body: trackAnswer },
  );
  try {
    await createBlinkClient(slow.origin, API_KEY, {
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    }).trackTransaction({ txHash: HASH });
    assert.deepEqual(slept, [10_000]);
  } finally {
    await slow.close();
  }
});

test("getMarketSpec returns the spec only when the bytes hash to the expected specHash", async () => {
  const specHash = keccak256(SPEC_BYTES);
  const altered = Buffer.from(
    SPEC_BYTES.toString("utf8").replace("exceed 1 gwei on", "exceed 2 gwei on"),
  );
  assert.notEqual(altered.toString(), SPEC_BYTES.toString());
  let served: Uint8Array = SPEC_BYTES;
  const server = await scripted(() => ({ body: served }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    assert.deepEqual(await client.getMarketSpec(marketRef, specHash), spec);
    assert.equal(server.seen[0]!.path, `/v1/markets/${MARKET}/spec`);
    assert.deepEqual(server.seen[0]!.query, {});
    // The hash may be written in either case.
    assert.deepEqual(
      await client.getMarketSpec(
        marketRef,
        specHash.toUpperCase().replace("0X", "0x"),
      ),
      spec,
    );
    served = altered;
    await assert.rejects(
      client.getMarketSpec(marketRef, specHash),
      /SPEC_HASH_MISMATCH/,
    );
    // Bytes that match their hash but are not a market spec are refused as well.
    const notSpec = Buffer.from('{"schemaVersion":"other"}');
    served = notSpec;
    await assert.rejects(client.getMarketSpec(marketRef, keccak256(notSpec)));
    // And a wrong expectation is refused even though the server's bytes are fine.
    served = SPEC_BYTES;
    await assert.rejects(
      client.getMarketSpec(marketRef, "0x" + "00".repeat(32)),
      /SPEC_HASH_MISMATCH/,
    );
  } finally {
    await server.close();
  }
});

test("the retired v0.1 execution methods are gone, not stubbed", () => {
  const client = createBlinkClient("https://blink.example") as Record<
    string,
    unknown
  >;
  for (const name of [
    "requestQuote",
    "getQuote",
    "claimFaucet",
    "getResolution",
  ])
    assert.equal(client[name], undefined, name);
});

test("the read methods accept only the answer shapes of the read API", async () => {
  let served: unknown = { market, spec: specResult, proposal: null, index };
  const server = await scripted(() => ({ body: served }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    assert.equal((await client.getMarket(marketRef)).market.marketId, MARKET);
    // A flattened market, a bare manifest and a market that breaks the schema are all refused.
    served = { ...market, index };
    await assert.rejects(client.getMarket(marketRef));
    served = {
      market: { ...market, closeAt: "soon" },
      spec: specResult,
      proposal: null,
      index,
    };
    await assert.rejects(client.getMarket(marketRef));
    served = { deployment: manifest, index };
    assert.equal(
      (await client.getDeployment()).deployment.deploymentId,
      DEPLOYMENT,
    );
    served = { ...manifest, index };
    await assert.rejects(client.getDeployment());
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
    assert.deepEqual(
      await client.uploadContent(bytes, "application/json"),
      answer,
    );
    const [seen] = server.seen;
    assert.equal(seen!.method, "POST");
    assert.equal(seen!.path, "/v1/content");
    assert.equal(seen!.headers["content-type"], "application/json");
    assert.equal(seen!.body, bytes.toString());
    answer = { ...(answer as object), hash: HASH };
    await assert.rejects(
      client.uploadContent(bytes, "application/json"),
      /HASH_MISMATCH/,
    );
    answer = { ...(answer as object), hash, size: 3 };
    await assert.rejects(
      client.uploadContent(bytes, "application/json"),
      /HASH_MISMATCH/,
    );
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
    assert.deepEqual(
      Buffer.from(await client.getContent(keccak256(bytes))),
      bytes,
    );
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
    assert.deepEqual(
      await client.submitSuggestion({
        text: "Will it rain in Taipei tomorrow afternoon?",
        sourceUrls: [],
      }),
      { id: UUID },
    );
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
    await assert.rejects(
      client.createRfq({ marketId: MARKET, side: "MAYBE", quantity: "1" }),
    );
    await assert.rejects(
      client.createRfq({
        marketId: MARKET,
        side: "YES",
        quantity: "1",
        extra: 1,
      }),
    );
    await assert.rejects(
      client.postQuote(rfqId, {
        quote: { ...quote, priceBps: "70000" },
        signature: signedQuote.signature,
      }),
    );
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
      client.getMarket(marketRef),
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
  const right = await nodeOn("0x14a34"); // chain ID 84532
  try {
    const environment = (rpcUrl: string) => ({
      BLINK_AGENT_NAME: "taker",
      BLINK_AGENT_ROLES: "trader",
      BLINK_API_URL: api.origin,
      BLINK_RPC_URL: rpcUrl,
      BLINK_AGENT_KEY: dummyKey,
      BLINK_WORLD: "world.json",
      BLINK_AGENT_STATE_DIR: "state",
    });
    await assert.rejects(
      loadAgentEnv(environment("https://rpc.blink.invalid")),
      /RPC_NOT_LOOPBACK/,
    );
    // Base mainnet and any other chain are the same refusal: only chain ID 84532 is accepted.
    await assert.rejects(loadAgentEnv(environment(mainnet.origin)), /WRONG_CHAIN/);
    await assert.rejects(loadAgentEnv(environment(other.origin)), /WRONG_CHAIN/);
    assert.equal(mainnet.seen.length, 1);
    assert.equal(other.seen.length, 1);
    assert.equal(api.seen.length, 0);
    assert.deepEqual(await loadAgentEnv(environment(right.origin)), {
      name: "taker",
      roles: ["trader"],
      apiUrl: api.origin,
      rpcUrl: right.origin,
      key: dummyKey,
      worldPath: "world.json",
      stateDir: "state",
    });
    assert.equal(api.seen.length, 0);
  } finally {
    await api.close();
    await mainnet.close();
    await other.close();
    await right.close();
  }
  await assert.rejects(loadAgentEnv({}), /MISSING_ENV:BLINK_AGENT_NAME/);
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
