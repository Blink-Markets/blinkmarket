import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../apps/api/src/server.js";
import {
  createTokenBucket,
  createWindowLimiter,
} from "../apps/api/src/rate-limit.js";
import { IdentityError } from "../packages/application/src/identity.js";
import type { IdentityService } from "../packages/application/src/identity.js";
import type {
  RouteService,
  ServiceRequest,
  ServiceResponse,
} from "../packages/application/src/route-service.js";
import {
  ConfigResponse,
  PublicDeployment,
} from "../packages/schemas/src/index.js";
import { deploymentFixture } from "./helpers/deployment-fixture.js";

function fakeService(
  paths: string[],
  respond: (request: ServiceRequest) => ServiceResponse = () => ({
    status: 200,
    body: { items: [], nextCursor: null },
  }),
) {
  const calls: ServiceRequest[] = [];
  const service: RouteService = {
    paths,
    async handle(request) {
      calls.push(request);
      return respond(request);
    },
  };
  return { service, calls };
}
const key = { "idempotency-key": "route-service-test" };
const rawBody = { fixture: "raw request body" };

test("a service owns its path: status, body, request fields and default no-store", async () => {
  const { service, calls } = fakeService(["/v1/markets"], () => ({
    status: 200,
    body: { items: [{ marketId: "1" }], nextCursor: null },
  }));
  const app = buildApi({ services: [service] });
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v1/markets?limit=5",
      headers: { authorization: "Bearer token" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      items: [{ marketId: "1" }],
      nextCursor: null,
    });
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.method, "GET");
    assert.equal(call.path, "/v1/markets");
    assert.deepEqual(call.params, {});
    assert.deepEqual(
      call.query,
      { limit: 5 },
      "query is coerced by the contract",
    );
    assert.equal(call.body, undefined);
    assert.equal(call.authorization, "Bearer token");
    assert.equal(call.idempotencyKey, undefined);
    assert.equal(call.ip, "127.0.0.1");
    assert.ok(call.requestId.length > 0);
  } finally {
    await app.close();
  }
});

test("service response headers override the defaults, and error bodies get a requestId", async () => {
  const app = buildApi({
    services: [
      fakeService(["/v1/markets"], () => ({
        status: 200,
        body: { items: [], nextCursor: null },
        headers: { "Cache-Control": "public, max-age=5", ETag: '"v1"' },
      })).service,
      fakeService(["/v1/metrics"], () => ({
        status: 404,
        body: {
          code: "NOT_FOUND",
          message: "x",
          retryable: false,
          details: {},
        },
      })).service,
    ],
  });
  try {
    const ok = await app.inject("/v1/markets");
    assert.equal(ok.headers["cache-control"], "public, max-age=5");
    assert.equal(ok.headers.etag, '"v1"');
    const missing = await app.inject("/v1/metrics?mode=REPLAY");
    assert.equal(missing.statusCode, 404);
    assert.equal(typeof missing.json().requestId, "string");
    assert.equal(missing.json().code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("a path claimed twice, by two services or by a built-in option, fails at build time", () => {
  assert.throws(
    () =>
      buildApi({
        services: [
          fakeService(["/v1/markets"]).service,
          fakeService(["/v1/markets"]).service,
        ],
      }),
    /DUPLICATE_ROUTE_SERVICE/,
  );
  assert.throws(
    () =>
      buildApi({
        services: [fakeService(["/v1/markets", "/v1/markets"]).service],
      }),
    /DUPLICATE_ROUTE_SERVICE/,
  );
  assert.throws(
    () =>
      buildApi({
        identity: {} as IdentityService,
        services: [fakeService(["/v1/auth/wallet-challenges"]).service],
      }),
    /DUPLICATE_ROUTE_SERVICE/,
  );
  assert.throws(
    () => buildApi({ services: [fakeService(["/v1/not-a-contract"]).service] }),
    /UNKNOWN_ROUTE_SERVICE_PATH/,
  );
});

test("invalid params or query are rejected with 400 before the service runs", async () => {
  const { service, calls } = fakeService(["/v1/markets/:id"]);
  const app = buildApi({ services: [service] });
  try {
    const badParam = await app.inject("/v1/markets/abc?deploymentId=x");
    assert.equal(badParam.statusCode, 400);
    assert.equal(badParam.json().code, "INVALID_REQUEST");
    assert.equal(badParam.json().retryable, false);
    assert.equal(typeof badParam.json().requestId, "string");
    assert.equal((await app.inject("/v1/markets/1")).statusCode, 400);
    assert.equal(
      (await app.inject("/v1/markets/1?deploymentId=x&extra=1")).statusCode,
      400,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (await app.inject("/v1/markets/1?deploymentId=x")).statusCode,
      200,
    );
    assert.equal(calls.length, 1);
  } finally {
    await app.close();
  }
});

test("POST needs a valid Idempotency-Key and passes the raw body through", async () => {
  const { service, calls } = fakeService(["/v1/markets/:id/forecasts"], () => ({
    status: 200,
    body: { ok: true },
  }));
  const app = buildApi({ services: [service] });
  try {
    const send = (headers: Record<string, string>, payload: object = rawBody) =>
      app.inject({
        method: "POST",
        url: "/v1/markets/1/forecasts?deploymentId=x",
        headers,
        payload,
      });
    for (const headers of [
      {},
      { "idempotency-key": "" },
      { "idempotency-key": "has space" },
      { "idempotency-key": "k".repeat(129) },
    ])
      assert.equal(
        (await send(headers)).statusCode,
        400,
        JSON.stringify(headers),
      );
    assert.equal(calls.length, 0);
    const ok = await send(key, { not: "validated here" });
    assert.equal(ok.statusCode, 200);
    assert.equal(calls[0]!.idempotencyKey, "route-service-test");
    assert.deepEqual(calls[0]!.body, { not: "validated here" });
    assert.equal(calls[0]!.method, "POST");
  } finally {
    await app.close();
  }
});

test("IdentityError maps to the envelope with details, retryable and Retry-After", async () => {
  const errors = [
    new IdentityError(409, "NO_QUOTE", {
      details: { reason: "STALE_FORECAST" },
      retryAfterSeconds: 2,
    }),
    new IdentityError(409, "REQUEST_IN_PROGRESS"),
    new IdentityError(503, "CHAIN_UNAVAILABLE", { retryable: true }),
    new IdentityError(404, "NOT_FOUND"),
  ];
  const app = buildApi({
    services: [
      {
        paths: ["/v1/markets"],
        async handle() {
          throw errors.shift();
        },
      },
    ],
  });
  try {
    const first = await app.inject("/v1/markets");
    assert.equal(first.statusCode, 409);
    assert.equal(first.headers["retry-after"], "2");
    assert.equal(first.headers["cache-control"], "no-store");
    const { requestId, ...envelope } = first.json();
    assert.deepEqual(envelope, {
      code: "NO_QUOTE",
      message: "NO_QUOTE",
      retryable: false,
      details: { reason: "STALE_FORECAST" },
    });
    assert.equal(typeof requestId, "string");
    const inProgress = await app.inject("/v1/markets");
    assert.equal(inProgress.json().retryable, true);
    assert.equal(inProgress.headers["retry-after"], "1");
    const explicit = await app.inject("/v1/markets");
    assert.equal(explicit.statusCode, 503);
    assert.equal(explicit.json().retryable, true);
    assert.equal(explicit.headers["retry-after"], undefined);
    const plain = await app.inject("/v1/markets");
    assert.deepEqual(plain.json().details, {});
    assert.equal(plain.json().retryable, false);
  } finally {
    await app.close();
  }
});

test("IdentityError defaults leave existing call sites unchanged", () => {
  const error = new IdentityError(401, "UNAUTHORIZED");
  assert.equal(error.status, 401);
  assert.equal(error.code, "UNAUTHORIZED");
  assert.equal(error.message, "UNAUTHORIZED");
  assert.deepEqual(error.details, {});
  assert.equal(error.retryable, false);
  assert.equal(error.retryAfterSeconds, undefined);
  assert.equal(new IdentityError(409, "REQUEST_IN_PROGRESS").retryable, true);
});

test("a Uint8Array body is sent byte for byte with its content type", async () => {
  const bytes = new TextEncoder().encode('{ "b" : 1,\n "a":2 }\n');
  const app = buildApi({
    services: [
      fakeService(["/v1/content/:hash"], () => ({
        status: 200,
        body: bytes,
        contentType: "application/json",
        headers: { ETag: '"spec"' },
      })).service,
    ],
  });
  try {
    const res = await app.inject(`/v1/content/0x${"ab".repeat(32)}`);
    assert.equal(res.statusCode, 200);
    assert.ok(Buffer.from(bytes).equals(res.rawPayload));
    assert.match(String(res.headers["content-type"]), /^application\/json/);
    assert.equal(res.headers.etag, '"spec"');
  } finally {
    await app.close();
  }
});

test("a thrown plain Error is a 500 INTERNAL_ERROR that leaks nothing", async () => {
  const app = buildApi({
    services: [
      {
        paths: ["/v1/markets"],
        async handle() {
          throw new Error("password=hunter2");
        },
      },
    ],
  });
  app.log.level = "silent";
  try {
    const res = await app.inject("/v1/markets");
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().code, "INTERNAL_ERROR");
    assert.deepEqual(res.json().details, {});
    assert.equal(res.json().retryable, false);
    assert.equal(typeof res.json().requestId, "string");
    assert.doesNotMatch(res.body, /hunter2/);
  } finally {
    await app.close();
  }
});

const withCode = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

test("a database that cannot be reached is a retryable 503, not a permanent 500", async () => {
  let thrown: unknown;
  const app = buildApi({
    services: [
      {
        paths: ["/v1/markets"],
        async handle() {
          throw thrown;
        },
      },
    ],
  });
  app.log.level = "silent";
  try {
    const unreachable = [
      new Error("timeout exceeded when trying to connect"),
      new Error("Connection terminated unexpectedly"),
      new Error("Connection terminated due to connection timeout"),
      new Error(
        "Client has encountered a connection error and is not queryable",
      ),
      withCode("terminating connection due to administrator command", "57P01"),
      withCode("the database system is starting up", "57P03"),
      withCode("connection failure", "08006"),
      withCode("unable to establish connection", "08001"),
      withCode("connection does not exist", "08003"),
      withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED"),
      withCode("read ECONNRESET", "ECONNRESET"),
      withCode("connect ETIMEDOUT 10.0.0.1:5432", "ETIMEDOUT"),
    ];
    for (const error of unreachable) {
      thrown = error;
      const res = await app.inject("/v1/markets");
      const label = String((error as Error).message);
      assert.equal(res.statusCode, 503, label);
      assert.deepEqual(
        { ...(res.json() as object), requestId: "x" },
        {
          code: "SERVICE_NOT_READY",
          message: "SERVICE_NOT_READY",
          requestId: "x",
          retryable: true,
          details: { reason: "DATABASE_UNAVAILABLE" },
        },
        label,
      );
      assert.equal(res.headers["retry-after"], "1", label);
      assert.equal(res.headers["cache-control"], "no-store", label);
      assert.doesNotMatch(res.body, /ECONN|127\.0\.0\.1|10\.0\.0\.1/, label);
    }
  } finally {
    await app.close();
  }
});

test("every other unexpected error stays a non-retryable 500", async () => {
  let thrown: unknown;
  const app = buildApi({
    services: [
      {
        paths: ["/v1/markets"],
        async handle() {
          throw thrown;
        },
      },
    ],
  });
  app.log.level = "silent";
  try {
    const others = [
      new Error("password=hunter2"),
      new Error("connection string is invalid"),
      new TypeError("fetch failed"),
      withCode("duplicate key value violates unique constraint", "23505"),
      withCode("canceling statement due to statement timeout", "57014"),
      withCode("relation does not exist", "42P01"),
      withCode("division by zero", "22012"),
      withCode("deadlock detected", "40P01"),
      withCode("too many connections", "53300"),
      withCode("connection refused by the signer", "SIGNER_ERROR"),
      "timeout exceeded when trying to connect",
      null,
    ];
    for (const error of others) {
      thrown = error;
      const res = await app.inject("/v1/markets");
      const label = String((error as Error | null)?.message ?? error);
      assert.equal(res.statusCode, 500, label);
      assert.equal(res.json().code, "INTERNAL_ERROR", label);
      assert.equal(res.json().retryable, false, label);
      assert.deepEqual(res.json().details, {}, label);
    }
  } finally {
    await app.close();
  }
});

test("the identity routes map an unreachable database the same way, and keep an IdentityError as it is", async () => {
  let thrown: unknown;
  const app = buildApi({
    identity: {
      async mutate() {
        throw thrown;
      },
    } as unknown as IdentityService,
  });
  app.log.level = "silent";
  const post = () =>
    app.inject({
      method: "POST",
      url: "/v1/auth/wallet-challenges",
      headers: key,
      payload: {},
    });
  try {
    thrown = new Error("timeout exceeded when trying to connect");
    const down = await post();
    assert.equal(down.statusCode, 503);
    assert.equal(down.json().code, "SERVICE_NOT_READY");
    assert.equal(down.json().retryable, true);
    assert.equal(down.headers["retry-after"], "1");

    // A business error keeps its own status, and any other failure stays a 500.
    thrown = new IdentityError(409, "REQUEST_IN_PROGRESS");
    assert.equal((await post()).statusCode, 409);
    thrown = new Error("password=hunter2");
    const other = await post();
    assert.equal(other.statusCode, 500);
    assert.equal(other.json().retryable, false);
  } finally {
    await app.close();
  }
});

test("Address and Hash params reach the service lowercased", async () => {
  const { service, calls } = fakeService([
    "/v1/accounts/:address/positions",
    "/v1/transactions/:txHash",
  ]);
  const app = buildApi({ services: [service] });
  try {
    const mixedAddress = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const mixedHash = "0x" + "aB".repeat(32);
    const positions = await app.inject(
      `/v1/accounts/${mixedAddress}/positions?deploymentId=test`,
    );
    assert.equal(positions.statusCode, 200);
    assert.deepEqual(calls[0]!.params, { address: mixedAddress.toLowerCase() });
    const tx = await app.inject(
      `/v1/transactions/${mixedHash}?deploymentId=test`,
    );
    assert.equal(tx.statusCode, 200);
    assert.deepEqual(calls[1]!.params, { txHash: mixedHash.toLowerCase() });
    assert.equal(
      (await app.inject("/v1/accounts/0x12/positions?deploymentId=test"))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

test("/openapi.json marks service paths enabled and leaves the rest planned", async () => {
  const app = buildApi({
    services: [fakeService(["/v1/markets", "/v1/markets/:id"]).service],
  });
  try {
    const { paths } = (await app.inject("/openapi.json")).json();
    assert.equal(paths["/v1/markets"].get["x-status"], "enabled");
    assert.equal(paths["/v1/markets/{id}"].get["x-status"], "enabled");
    assert.equal(paths["/v1/metrics"].get["x-status"], "not-implemented");
  } finally {
    await app.close();
  }
});

test("public reads are rate limited per IP; other routes are not", async () => {
  let clock = 0;
  const app = buildApi({
    services: [fakeService(["/v1/markets"]).service],
    publicReadLimit: { capacity: 60, refillPerSecond: 1, now: () => clock },
  });
  const get = (url: string, remoteAddress = "10.0.0.1") =>
    app.inject({ method: "GET", url, remoteAddress });
  try {
    for (let i = 0; i < 60; ++i)
      assert.equal((await get("/v1/markets")).statusCode, 200, "request " + i);
    const limited = await get("/v1/markets");
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "RATE_LIMITED");
    assert.equal(limited.json().retryable, true);
    assert.equal(typeof limited.json().requestId, "string");
    assert.equal(limited.headers["retry-after"], "1");
    // A public route without a service is limited by the same bucket.
    assert.equal((await get("/v1/metrics?mode=REPLAY")).statusCode, 429);
    // Another client, a non-public route and the health endpoints are unaffected.
    assert.equal((await get("/v1/markets", "10.0.0.2")).statusCode, 200);
    for (let i = 0; i < 70; ++i)
      assert.equal((await get("/v1/admin/pause")).statusCode, 501);
    assert.equal((await get("/health/live")).statusCode, 200);
    // Tokens refill with the injected clock.
    clock += 1000;
    assert.equal((await get("/v1/markets")).statusCode, 200);
    assert.equal((await get("/v1/markets")).statusCode, 429);
  } finally {
    await app.close();
  }
});

test("token bucket: refill, Retry-After, burst cap and bounded memory", () => {
  let clock = 0;
  const bucket = createTokenBucket({
    capacity: 2,
    refillPerSecond: 0.5,
    now: () => clock,
    maxKeys: 2,
  });
  assert.deepEqual(bucket.take("a"), { allowed: true });
  assert.deepEqual(bucket.take("a"), { allowed: true });
  assert.deepEqual(bucket.take("a"), { allowed: false, retryAfterSeconds: 2 });
  clock += 1000;
  assert.deepEqual(bucket.take("a"), { allowed: false, retryAfterSeconds: 1 });
  clock += 1000;
  assert.deepEqual(bucket.take("a"), { allowed: true });
  clock += 60_000;
  assert.deepEqual(bucket.take("a"), { allowed: true });
  assert.deepEqual(
    bucket.take("a"),
    { allowed: true },
    "refill is capped at capacity",
  );
  assert.equal(bucket.take("a").allowed, false);
  // maxKeys: a third key evicts the least recently used one, which then starts fresh.
  bucket.take("b");
  bucket.take("c");
  assert.deepEqual(bucket.take("a"), { allowed: true });
  for (const maxKeys of [0, -1, 1.5, Number.NaN])
    assert.throws(
      () => createTokenBucket({ capacity: 1, refillPerSecond: 1, maxKeys }),
      /INVALID_RATE_LIMIT/,
    );
});

test("window limiter: at most N accepted per trailing window, refusals not counted", () => {
  let clock = 0;
  const limiter = createWindowLimiter({
    limit: 3,
    windowSeconds: 10,
    now: () => clock,
    maxKeys: 2,
  });
  assert.deepEqual(limiter.take("a"), { allowed: true });
  clock = 4000;
  assert.deepEqual(limiter.take("a"), { allowed: true });
  clock = 5000;
  assert.deepEqual(limiter.take("a"), { allowed: true });
  // Retry-After: seconds until the oldest counted event (t=0) leaves the window.
  clock = 6000;
  assert.deepEqual(limiter.take("a"), { allowed: false, retryAfterSeconds: 4 });
  // Refusing does not extend the wait: the refused call at t=6s was not counted.
  clock = 10_000;
  assert.deepEqual(limiter.take("a"), { allowed: true });
  clock = 10_500;
  assert.deepEqual(limiter.take("a"), { allowed: false, retryAfterSeconds: 4 });
  // An event leaves the window exactly one window after it was counted.
  clock = 14_000;
  assert.deepEqual(limiter.take("a"), { allowed: true });
  // Keys are independent, and maxKeys evicts the least recently used one.
  assert.deepEqual(limiter.take("b"), { allowed: true });
  assert.deepEqual(limiter.take("c"), { allowed: true });
  assert.deepEqual(
    limiter.take("a"),
    { allowed: true },
    "a was evicted and starts empty",
  );
  for (const bad of [
    { limit: 0, windowSeconds: 1 },
    { limit: 1.5, windowSeconds: 1 },
    { limit: 1, windowSeconds: 0 },
    { limit: 1, windowSeconds: Number.NaN },
    { limit: 1, windowSeconds: 1, maxKeys: 0 },
  ])
    assert.throws(() => createWindowLimiter(bad), /INVALID_RATE_LIMIT/);
});

test("/v1/config can be supplied, with a public deployment and an explicit stage", async () => {
  const { manifest } = deploymentFixture();
  const config = ConfigResponse.parse({
    chainId: 84532,
    stage: "m2-markets",
    tradingEnabled: true,
    deployment: PublicDeployment.parse({
      deploymentId: manifest.deploymentId,
      chainId: manifest.chainId,
      deploymentBlock: manifest.deploymentBlock,
      contracts: manifest.contracts,
      artifacts: {
        abiHashes: manifest.artifacts.abiHashes,
        bytecodeHashes: manifest.artifacts.bytecodeHashes,
      },
      roles: manifest.roles,
      parameters: manifest.parameters,
    }),
    asset: {
      name: "Blink Test USD",
      symbol: "bUSD",
      decimals: 6,
      hasValue: false,
    },
  });
  const app = buildApi({ stage: "m2-markets", config: async () => config });
  try {
    assert.deepEqual((await app.inject("/v1/config")).json(), config);
    assert.equal((await app.inject("/health/live")).json().stage, "m2-markets");
  } finally {
    await app.close();
  }
  const scaffold = buildApi();
  try {
    const body = (await scaffold.inject("/v1/config")).json();
    assert.equal(body.tradingEnabled, false);
    assert.equal(body.deployment, null);
    assert.equal(ConfigResponse.safeParse(body).success, true);
  } finally {
    await scaffold.close();
  }
});

test("PublicDeployment keeps the public manifest fields and rejects private ones", () => {
  const { manifest } = deploymentFixture();
  assert.equal(
    PublicDeployment.safeParse(manifest).success,
    false,
    "full manifest",
  );
  const publicView = {
    deploymentId: manifest.deploymentId,
    chainId: manifest.chainId,
    deploymentBlock: manifest.deploymentBlock,
    contracts: manifest.contracts,
    artifacts: {
      abiHashes: manifest.artifacts.abiHashes,
      bytecodeHashes: manifest.artifacts.bytecodeHashes,
    },
    roles: manifest.roles,
    parameters: manifest.parameters,
  };
  assert.deepEqual(PublicDeployment.parse(publicView), publicView);
  for (const extra of [
    { status: "DEPLOYED" },
    { tradingEnabled: true },
    { artifacts: { ...publicView.artifacts, gitCommit: "1".repeat(40) } },
    { artifacts: { ...publicView.artifacts, compiler: "0.8.30" } },
    { artifacts: { ...publicView.artifacts, dependencies: { a: "1" } } },
  ])
    assert.equal(
      PublicDeployment.safeParse({ ...publicView, ...extra }).success,
      false,
      JSON.stringify(Object.keys(extra)),
    );
  assert.equal(
    PublicDeployment.safeParse({ ...publicView, chainId: 8453 }).success,
    false,
  );
});
