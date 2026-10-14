import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignerServer } from "../apps/signer/src/server.js";

const service = () => {
  const calls: { token: string | undefined; body: unknown }[] = [];
  return {
    calls,
    handle: async (token: string | undefined, body: unknown) => {
      calls.push({ token, body });
      return { status: 200, body: { state: "SIGNED" } };
    },
  };
};

test("the signer server carries a bearer token and the body to the service, and nothing else", async () => {
  const fake = service();
  const app = buildSignerServer(fake);
  try {
    const body = { signRequestId: "a", expectedRequestHash: "b" };
    const ok = await app.inject({
      method: "POST",
      url: "/internal/sign",
      headers: { authorization: "Bearer secret-token" },
      payload: body,
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["cache-control"], "no-store");
    for (const authorization of [
      undefined,
      "secret-token",
      "Basic secret-token",
      "Bearer",
      "Bearer a b",
    ])
      await app.inject({
        method: "POST",
        url: "/internal/sign",
        headers: authorization ? { authorization } : {},
        payload: body,
      });
    assert.deepEqual(
      fake.calls.map((c) => c.token),
      ["secret-token", undefined, undefined, undefined, undefined, undefined],
    );
    assert.deepEqual(fake.calls[0]!.body, body);
    assert.equal(
      (await app.inject({ method: "GET", url: "/internal/sign" })).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("readiness is the signer's own check, and a failing check is not ready", async () => {
  let state: "ready" | "not-ready" | "throws" = "ready";
  const app = buildSignerServer(service(), async () => {
    if (state === "throws") throw new Error("database down");
    return state === "ready";
  });
  const status = async () =>
    (await app.inject({ method: "GET", url: "/health/ready" })).statusCode;
  try {
    assert.equal(await status(), 200);
    state = "not-ready";
    assert.equal(await status(), 503);
    state = "throws";
    assert.equal(await status(), 503);
    // The error never reaches the response.
    assert.doesNotMatch(
      (await app.inject({ method: "GET", url: "/health/ready" })).body,
      /database down/,
    );
  } finally {
    await app.close();
  }
  // Without a readiness check the process never claims to be ready.
  const bare = buildSignerServer(service());
  try {
    assert.equal(
      (await bare.inject({ method: "GET", url: "/health/ready" })).statusCode,
      503,
    );
    assert.equal(
      (await bare.inject({ method: "GET", url: "/health/live" })).statusCode,
      200,
    );
  } finally {
    await bare.close();
  }
});
