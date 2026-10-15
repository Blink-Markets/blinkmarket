import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256 } from "viem";
import {
  BlinkApiError,
  createBlinkClient,
} from "../packages/client/src/index.js";
import { configFromEnv, runAgent } from "../examples/agent/run.js";
import { testAccounts } from "./helpers/signer-fixture.js";

const DEPLOYMENT = "client-test";
const MARKET = "7";
const UUID = "00000000-0000-4000-8000-000000000001";
const HASH = "0x" + "ab".repeat(32);
const WALLET = testAccounts.taker.address.toLowerCase();
const API_KEY = "test-api-key";
const SPEC_BYTES = readFileSync("fixtures/replay/market-spec.json");

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
const ref = { deploymentId: DEPLOYMENT, marketId: MARKET, mode: "REPLAY" };
const summary = {
  ...ref,
  specHash: HASH,
  storedState: "OPEN",
  effectiveState: "OPEN",
  paused: false,
  canTrade: true,
  reasons: [],
  chainCursor: cursor,
};
const spec = JSON.parse(SPEC_BYTES.toString("utf8"));
const resolution = {
  ...ref,
  proposedOutcome: null,
  finalOutcome: null,
  proposalEvidenceHash: null,
  finalEvidenceHash: null,
  proposedAt: null,
  challengeEndsAt: null,
  hardDeadline: "2025-05-10T00:00:00.000Z",
  chainCursor: cursor,
};
const quote = {
  deploymentId: DEPLOYMENT,
  quoteId: HASH,
  marketId: MARKET,
  mode: "REPLAY",
  chainId: 84532,
  verifyingContract: testAccounts.admin.address,
  domain: {
    name: "Blink RFQ",
    version: "0.1",
    chainId: 84532,
    verifyingContract: testAccounts.admin.address,
  },
  types: {
    Quote: [
      "marketId:uint256",
      "specHash:bytes32",
      "maker:address",
      "taker:address",
      "side:uint8",
      "quantity:uint64",
      "priceBps:uint16",
      "validAfter:uint64",
      "expiresAt:uint64",
      "nonce:uint256",
      "epoch:uint256",
    ].map((entry) => {
      const [name, type] = entry.split(":");
      return { name, type };
    }),
  },
  message: {
    marketId: MARKET,
    specHash: HASH,
    maker: testAccounts.maker.address.toLowerCase(),
    taker: WALLET,
    side: "0",
    quantity: "10",
    priceBps: "6000",
    validAfter: "1000",
    expiresAt: "1030",
    nonce: "1",
    epoch: "1",
  },
  signature: "0x" + "11".repeat(65),
  takerCostMicros: "6000000",
  makerCostMicros: "4000000",
  expiresAt: "1030",
  calldata: "0x00",
  forecastSnapshotId: UUID,
  chainCursor: cursor,
};
const rfq = {
  deploymentId: DEPLOYMENT,
  marketId: MARKET,
  side: "YES",
  quantity: "10",
  maxCostMicros: "6500000",
} as const;
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
    call: (c) =>
      c.listMarkets({
        deploymentId: DEPLOYMENT,
        mode: "REPLAY",
        status: "OPEN",
        entity: "acme",
        limit: 5,
        cursor: "next",
      }),
    method: "GET",
    path: "/v1/markets",
    query: {
      deploymentId: DEPLOYMENT,
      mode: "REPLAY",
      status: "OPEN",
      entity: "acme",
      limit: "5",
      cursor: "next",
    },
    answer: page(summary),
  },
  {
    name: "getMarket",
    call: (c) => c.getMarket(ref as never),
    method: "GET",
    path: "/v1/markets/" + MARKET,
    query: { deploymentId: DEPLOYMENT },
    answer: {
      ...summary,
      spec,
      resolution,
      forecastSnapshotId: null,
      costMicros: "0",
    },
  },
  {
    name: "getEvidence",
    call: (c) => c.getEvidence(UUID),
    method: "GET",
    path: "/v1/evidence/" + UUID,
    answer: {
      evidenceId: UUID,
      sourceUrl: "https://example.com/fixture-only",
      observedAt: "2026-10-15T00:00:00.000Z",
      publishedAt: null,
      contentHash: HASH,
      accessPolicy: "PRIVATE",
      excerpt: null,
    },
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
    name: "requestQuote",
    call: (c) => c.requestQuote(rfq, "rfq-key"),
    method: "POST",
    path: "/v1/rfqs",
    body: rfq,
    answer: quote,
  },
  {
    name: "getQuote",
    call: (c) => c.getQuote(HASH),
    method: "GET",
    path: "/v1/quotes/" + HASH,
    answer: { quote, status: "SIGNED", chainCursor: cursor },
  },
  {
    name: "trackTransaction",
    call: (c) =>
      c.trackTransaction(
        {
          deploymentId: DEPLOYMENT,
          txHash: HASH,
          action: "FILL",
          quoteId: HASH,
        },
        "track-key",
      ),
    method: "POST",
    path: "/v1/transactions",
    body: {
      deploymentId: DEPLOYMENT,
      txHash: HASH,
      action: "FILL",
      quoteId: HASH,
    },
    answer: { trackingId: UUID, status: "UNKNOWN" },
    status: 202,
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
    call: (c) =>
      c.getPositions(
        { deploymentId: DEPLOYMENT, address: WALLET },
        { limit: 50 },
      ),
    method: "GET",
    path: `/v1/accounts/${WALLET}/positions`,
    query: { deploymentId: DEPLOYMENT, limit: "50" },
    answer: page({
      ...ref,
      yesShares: "10",
      noShares: "0",
      payoutMicros: null,
      pendingIntentIds: [],
      chainCursor: cursor,
    }),
  },
  {
    name: "submitResolutionReport",
    call: (c) =>
      c.submitResolutionReport(
        marketRef,
        { outcome: "YES", evidenceIds: [UUID], reason: "the release says so" },
        "report-key",
      ),
    method: "POST",
    path: `/v1/markets/${MARKET}/resolution-reports`,
    query: { deploymentId: DEPLOYMENT },
    body: {
      outcome: "YES",
      evidenceIds: [UUID],
      reason: "the release says so",
    },
    answer: { reportId: UUID, state: "RECEIVED" },
    status: 202,
  },
  {
    name: "getResolution",
    call: (c) => c.getResolution(marketRef),
    method: "GET",
    path: `/v1/markets/${MARKET}/resolution`,
    query: { deploymentId: DEPLOYMENT },
    answer: resolution,
  },
  {
    name: "claimFaucet",
    call: (c) => c.claimFaucet({ deploymentId: DEPLOYMENT }, "faucet-key"),
    method: "POST",
    path: "/v1/faucet/claims",
    body: { deploymentId: DEPLOYMENT },
    answer: { claimId: UUID, intentId: UUID, state: "QUEUED" },
    status: 202,
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
      spentUsdMicros: "0",
      reservedUsdMicros: "0",
      unknownUsdMicros: "0",
    },
  },
  {
    name: "createWalletChallenge",
    call: (c) => c.createWalletChallenge({ address: WALLET }, "challenge-key"),
    method: "POST",
    path: "/v1/auth/wallet-challenges",
    body: { address: WALLET },
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
      c.verifyWallet(
        { challengeId: UUID, signature: "0x" + "22".repeat(65) },
        "verify-key",
      ),
    method: "POST",
    path: "/v1/auth/wallet-verifications",
    body: { challengeId: UUID, signature: "0x" + "22".repeat(65) },
    answer: { wallet: WALLET, verifiedAt: "2026-10-15T00:00:00.000Z" },
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
        assert.ok(request!.headers["idempotency-key"]);
      } else assert.equal(request!.headers["idempotency-key"], undefined);
    } finally {
      await server.close();
    }
  });
}

test("the identity-and-preparation helpers keep their endpoints", async () => {
  const server = await scripted((seen) => ({
    status: 404,
    body: apiError("NOT_FOUND", false),
  }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    for (const call of [
      () => client.getCandidate(UUID),
      () => client.getCreationIntent(UUID),
      () => client.getCreationChainStatus(UUID),
    ])
      await assert.rejects(call, BlinkApiError);
    assert.deepEqual(
      server.seen.map((s) => s.path),
      [
        "/v1/candidates/" + UUID,
        "/v1/admin/creation-intents/" + UUID,
        "/v1/admin/creation-intents/" + UUID + "/chain-status",
      ],
    );
  } finally {
    await server.close();
  }
});

test("a POST without a key gets a fresh UUID per call; a given key is sent as it is", async () => {
  const server = await scripted(() => ({
    status: 202,
    body: { claimId: UUID, intentId: UUID, state: "QUEUED" },
  }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    await client.claimFaucet({ deploymentId: DEPLOYMENT });
    await client.claimFaucet({ deploymentId: DEPLOYMENT });
    await client.claimFaucet({ deploymentId: DEPLOYMENT }, "my-own-key");
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
    await assert.rejects(client.requestQuote(rfq, "has space"));
    await assert.rejects(client.requestQuote(rfq, "x".repeat(129)));
    await assert.rejects(client.requestQuote({ ...rfq, quantity: "101" }));
    await assert.rejects(client.requestQuote({ ...rfq, side: "BUY" } as never));
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
        : { body: quote },
  );
  try {
    const client = createBlinkClient(server.origin, API_KEY, {
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    });
    // No key given: the client picks one and keeps it for every attempt.
    assert.deepEqual(await client.requestQuote(rfq), quote);
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
      client.requestQuote(rfq, "stuck"),
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
      }).requestQuote(rfq, "once"),
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
      : { body: page(summary) },
  );
  const options = {
    sleep: async (milliseconds: number) => {
      slept.push(milliseconds);
    },
  };
  try {
    await assert.rejects(
      createBlinkClient(noQuote.origin, API_KEY, options).requestQuote(
        rfq,
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
      : { body: quote },
  );
  try {
    const started = Date.now();
    await createBlinkClient(server.origin, API_KEY).requestQuote(rfq, "k");
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
      : { body: quote },
  );
  try {
    await createBlinkClient(slow.origin, API_KEY, {
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    }).requestQuote(rfq, "k");
    assert.deepEqual(slept, [10_000]);
  } finally {
    await slow.close();
  }
});

test("getMarketSpec returns the spec only when the bytes hash to the expected specHash", async () => {
  const specHash = keccak256(SPEC_BYTES);
  const altered = Buffer.from(
    SPEC_BYTES.toString("utf8").replace(
      '"thresholdBps": 7000',
      '"thresholdBps": 7001',
    ),
  );
  assert.notEqual(altered.toString(), SPEC_BYTES.toString());
  let served: Uint8Array = SPEC_BYTES;
  const server = await scripted(() => ({ body: served }));
  try {
    const client = createBlinkClient(server.origin, API_KEY);
    assert.deepEqual(await client.getMarketSpec(marketRef, specHash), spec);
    assert.equal(server.seen[0]!.path, `/v1/markets/${MARKET}/spec`);
    assert.deepEqual(server.seen[0]!.query, { deploymentId: DEPLOYMENT });
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

test("the faucet's own refusals reach the caller as BlinkApiError codes", async () => {
  for (const [status, code] of [
    [409, "FAUCET_PENDING"],
    [409, "FAUCET_NOT_ALLOWED"],
  ] as const) {
    const server = await scripted(() => ({
      status,
      body: apiError(code, false),
    }));
    try {
      await assert.rejects(
        createBlinkClient(server.origin, API_KEY).claimFaucet({
          deploymentId: DEPLOYMENT,
        }),
        (error) =>
          error instanceof BlinkApiError &&
          error.status === status &&
          error.body.code === code,
      );
    } finally {
      await server.close();
    }
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
      client.getQuote(HASH),
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
  const rpc = await scripted((seen) => ({
    body: {
      jsonrpc: "2.0",
      id: (JSON.parse(seen.body) as { id: number }).id,
      result: "0x2105", // chain ID 8453
    },
  }));
  try {
    const agent = (rpcUrl: string) =>
      runAgent({
        apiUrl: api.origin,
        apiKey: API_KEY,
        privateKey: dummyKey,
        rpcUrl,
        log: () => undefined,
      });
    await assert.rejects(
      agent("https://rpc.blink.invalid"),
      /RPC_NOT_LOOPBACK/,
    );
    await assert.rejects(agent(rpc.origin), /RPC_CHAIN_MISMATCH/);
    assert.equal(rpc.seen.length, 1);
    assert.equal(api.seen.length, 0);
  } finally {
    await api.close();
    await rpc.close();
  }
  assert.throws(() => configFromEnv({}), /BLINK_API_URL/);
  assert.deepEqual(
    configFromEnv({
      BLINK_API_URL: "http://127.0.0.1:3001",
      BLINK_API_KEY: "k",
      AGENT_PRIVATE_KEY: dummyKey,
      RPC_URL: "http://127.0.0.1:8545",
    }),
    {
      apiUrl: "http://127.0.0.1:3001",
      apiKey: "k",
      privateKey: dummyKey,
      rpcUrl: "http://127.0.0.1:8545",
    },
  );
});
