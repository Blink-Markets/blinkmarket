import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../apps/api/src/server.js";

async function statuses(
  trustedProxies: string[] | undefined,
  remoteAddress: string,
  forwarded: string[],
) {
  const app = buildApi({
    publicReadLimit: { capacity: 1, refillPerSecond: 1, now: () => 0 },
    ...(trustedProxies ? { trustedProxies } : {}),
  });
  try {
    const result: number[] = [];
    for (const address of forwarded)
      result.push(
        (
          await app.inject({
            method: "GET",
            url: "/health/ready",
            remoteAddress,
            headers: { "x-forwarded-for": address },
          })
        ).statusCode,
      );
    return result;
  } finally {
    await app.close();
  }
}

for (const remote of ["127.0.0.1", "::ffff:127.0.0.1"])
  test(`a trusted proxy (${remote}) makes the limiter key the forwarded client`, async () => {
    const [first, again, other] = await statuses(["127.0.0.1"], remote, [
      "198.51.100.1",
      "198.51.100.1",
      "198.51.100.2",
    ]);
    assert.notEqual(first, 429);
    assert.equal(again, 429);
    assert.notEqual(other, 429);
  });

test("without trusted proxies a forged X-Forwarded-For buys no new bucket", async () => {
  const [first, second] = await statuses(undefined, "127.0.0.1", [
    "198.51.100.1",
    "198.51.100.2",
  ]);
  assert.notEqual(first, 429);
  assert.equal(second, 429);
});

test("an untrusted peer cannot forge X-Forwarded-For either", async () => {
  const [first, second] = await statuses(["127.0.0.1"], "203.0.113.9", [
    "198.51.100.3",
    "198.51.100.4",
  ]);
  assert.notEqual(first, 429);
  assert.equal(second, 429);
});
