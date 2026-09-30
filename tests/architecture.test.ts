import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../apps/api/src/server.js";
import {
  MarketSpec,
  Quote,
  quoteTypes,
} from "../packages/schemas/src/index.js";
import { readFileSync } from "node:fs";

test("scaffold never advertises deployment or transaction readiness", async () => {
  const app = buildApi();
  try {
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    const config = (await app.inject("/v1/config")).json();
    assert.equal(config.chainId, 84532);
    assert.equal(config.deployment, null);
    assert.equal(config.tradingEnabled, false);
    const write = await app.inject({
      method: "POST",
      url: "/v1/rfqs",
      headers: { "idempotency-key": "smoke" },
      payload: {
        deploymentId: "test",
        marketId: "1",
        side: "YES",
        quantity: "10",
        maxCostMicros: "6500000",
      },
    });
    assert.equal(write.statusCode, 501);
    assert.equal(write.json().code, "NOT_IMPLEMENTED");
    const openapi = (await app.inject("/openapi.json")).json();
    assert.equal(
      openapi.paths["/v1/markets/{id}"].get["x-status"],
      "not-implemented",
    );
  } finally {
    await app.close();
  }
});
test("schemas enforce integer wire amounts and isolate LIVE challenge periods", () => {
  const spec = JSON.parse(
    readFileSync("fixtures/replay/market-spec.json", "utf8"),
  );
  assert.equal(MarketSpec.safeParse(spec).success, true);
  assert.equal(MarketSpec.safeParse({ ...spec, mode: "LIVE" }).success, false);
  assert.equal(
    MarketSpec.safeParse({ ...spec, hardDeadline: spec.proposalDeadline })
      .success,
    false,
  );
  const quote = {
    marketId: "1",
    specHash: "0x" + "1".repeat(64),
    maker: "0x" + "2".repeat(40),
    taker: "0x" + "3".repeat(40),
    side: "0",
    quantity: "10",
    priceBps: "6200",
    validAfter: "100",
    expiresAt: "130",
    nonce: "1",
    epoch: "0",
  };
  assert.equal(Quote.safeParse(quote).success, true);
  assert.equal(Quote.safeParse({ ...quote, quantity: 10 }).success, false);
  assert.equal(
    Quote.safeParse({ ...quote, nonce: (2n ** 256n).toString() }).success,
    false,
  );
  assert.equal(Quote.safeParse({ ...quote, expiresAt: "161" }).success, false);
});
test("EIP-712 field order and types match the Solidity interface", () => {
  const source = readFileSync(
    "contracts/src/interfaces/IBlinkMarket.sol",
    "utf8",
  );
  const body = source.match(/struct Quote\s*\{([^}]+)\}/)?.[1];
  assert.ok(body);
  const fields = [...body.matchAll(/(\w+)\s+(\w+)\s*;/g)].map((m) => ({
    name: m[2],
    type: m[1],
  }));
  assert.deepEqual(fields, quoteTypes.Quote);
});
