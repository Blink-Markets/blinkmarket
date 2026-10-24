import { seedReadMaker } from "./helpers/protocol-index.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../apps/api/src/server.js";
import { createMarketReadService } from "../packages/application/src/market-read.js";
import { postgresMarketReadStore } from "../packages/adapters/src/market-read-store.js";
import { apiContracts } from "../packages/schemas/src/index.js";
import { fixture, hash, address } from "./helpers/market-read.js";
import { readFile } from "node:fs/promises";
import { keccak256 } from "viem";
function parse(path: string, body: unknown) {
  return apiContracts.find((c) => c.path === path)!.response.parse(body) as any;
}
test("public markets paginate in projection order and parse the response contract", async () => {
  const t = await fixture();
  try {
    await t.setRole("blink_api");
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let page = 0; page < 3; page++) {
      const r: Awaited<ReturnType<typeof t.app.inject>> = await t.app.inject({
        url: "/v1/markets?limit=2" + (cursor ? "&cursor=" + cursor : ""),
      });
      assert.equal(r.statusCode, 200, r.body);
      const body = parse("/v1/markets", r.json());
      ids.push(...body.items.map((m: any) => m.marketId));
      cursor = body.nextCursor;
      assert.equal(body.items[0].canTrade, false);
    }
    assert.deepEqual(ids, ["5", "4", "3", "2", "1"]);
    assert.equal(cursor, null);
  } finally {
    await t.close();
  }
});
test("list filters apply and malformed cursors are rejected", async () => {
  const t = await fixture();
  try {
    await t.setRole("blink_api");
    const get = async (q: string) => t.app.inject({ url: "/v1/markets?" + q });
    assert.deepEqual(
      parse(
        "/v1/markets",
        (await get("deploymentId=d1&mode=REPLAY&status=OPEN")).json(),
      ).items.map((m: any) => m.marketId),
      ["5", "4", "3", "2", "1"],
    );
    assert.equal((await get("deploymentId=other")).json().items.length, 0);
    assert.equal((await get("mode=LIVE")).json().items.length, 0);
    const cursor = (await get("limit=2")).json().nextCursor;
    for (const q of [
      "cursor=",
      "cursor=not-base64",
      "cursor=" + cursor + "&mode=LIVE",
      "cursor=" +
        Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(cursor, "base64url").toString()),
            b: "999",
          }),
        ).toString("base64url"),
    ]) {
      const r = await get(q);
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().code, "INVALID_CURSOR");
    }
  } finally {
    await t.close();
  }
});
test("DB clock determines effective close; pause, missing/stale/gated cursors keep trading disabled", async () => {
  const t = await fixture();
  try {
    await t.db.exec(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('closeAt',extract(epoch FROM blink.now())::bigint+1800) WHERE key::numeric=5; SET blink.test_clock_offset_seconds='3600'; UPDATE chain.cursors SET synced_at=blink.now()-interval '11 seconds'",
    );
    await seedReadMaker(t.db, "d1", { globalPaused: true });
    const r = await t.app.inject({ url: "/v1/markets?status=CLOSED" });
    const m = parse("/v1/markets", r.json()).items[0];
    assert.equal(m.marketId, "5");
    assert.equal(m.effectiveState, "CLOSED");
    assert.equal(m.paused, true);
    assert.deepEqual(m.reasons, [
      "TRADING_DISABLED",
      "MARKET_CLOSED",
      "TRADING_PAUSED",
      "INDEXER_LAG",
    ]);
    assert.equal(m.chainCursor.finality, "INCLUDED");
    await t.db.exec(
      "UPDATE chain.cursors SET synced_at=blink.now(),gate_reason='REORG_IN_PROGRESS'",
    );
    assert.ok(
      (await t.app.inject("/v1/markets"))
        .json()
        .items[0].reasons.includes("INDEXER_LAG"),
    );
    await t.db.exec("DELETE FROM chain.cursors");
    const missing = parse(
      "/v1/markets",
      (await t.app.inject("/v1/markets")).json(),
    ).items[0];
    assert.ok(missing.reasons.includes("INDEXER_LAG"));
    assert.equal(missing.chainCursor.finality, "UNKNOWN");
    assert.equal(missing.chainCursor.blockNumber, "0");
    assert.equal(missing.chainCursor.blockHash, hash(0));
  } finally {
    await t.close();
  }
});
async function seedSpec(t: Awaited<ReturnType<typeof fixture>>) {
  const bytes = await readFile(
    new URL("../fixtures/replay/market-spec.json", import.meta.url),
  );
  const h = keccak256(bytes);
  t.objects.set("memory:spec", bytes);
  await t.db.query(
    "UPDATE protocol.markets SET data=data||jsonb_build_object('specHash','0x'||encode(decode($1,'hex'),'hex')) WHERE key::numeric=1",
    [h.slice(2)],
  );
  await t.db.query(
    "INSERT INTO markets.specs(hash,object_uri,public_uri) VALUES (decode($1,'hex'),'memory:spec','https://spec.invalid')",
    [h.slice(2)],
  );
  return { bytes, h };
}
test("detail parses archived spec; spec serves exact bytes and integrity failures are audited", async () => {
  const t = await fixture();
  try {
    const { bytes, h } = await seedSpec(t);
    await t.db.query(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('state','PROPOSED','proposedAt',1700000000,'proposedOutcome','YES','proposalEvidenceHash','0x'||encode(decode($1,'hex'),'hex')) WHERE key::numeric=1",
      [hash(20).slice(2)],
    );
    await t.db.exec(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('specUri','memory:untrusted') WHERE key::numeric=1",
    );
    await t.setRole("blink_api");
    const r = await t.app.inject("/v1/markets/1?deploymentId=d1");
    assert.equal(r.statusCode, 200, r.body);
    const detail = parse("/v1/markets/:id", r.json());
    assert.deepEqual(detail.spec, JSON.parse(bytes.toString()));
    const resolution = parse(
      "/v1/markets/:id/resolution",
      (await t.app.inject("/v1/markets/1/resolution?deploymentId=d1")).json(),
    );
    assert.equal(resolution.proposedAt, "2023-11-14T22:13:20.000Z");
    assert.equal(resolution.challengeEndsAt, "2023-11-14T22:15:20.000Z");
    assert.equal(resolution.hardDeadline, "2100-01-01T00:20:00.000Z");
    const raw = await t.app.inject("/v1/markets/1/spec?deploymentId=d1");
    parse("/v1/markets/:id/spec", raw.json());
    assert.deepEqual(raw.rawPayload, bytes);
    assert.equal(raw.headers.etag, '"' + h + '"');
    assert.equal(
      raw.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
    assert.match(String(raw.headers["content-type"]), /^application\/json/);
    assert.equal(
      (await t.app.inject("/v1/markets/1?deploymentId=wrong")).statusCode,
      404,
    );
    assert.equal(
      (await t.app.inject("/v1/markets/999?deploymentId=d1")).statusCode,
      404,
    );
    t.objects.set(
      "memory:spec",
      new TextEncoder().encode(bytes.toString() + " "),
    );
    const broken = await t.app.inject("/v1/markets/1?deploymentId=d1");
    assert.equal(broken.statusCode, 503);
    assert.equal(broken.json().code, "SPEC_UNAVAILABLE");
    assert.equal(broken.json().retryable, false);
    await t.setRole(null);
    const audit = await t.db.query(
      "SELECT action FROM operations.audit_log WHERE action='spec.integrity_failed'",
    );
    assert.equal(audit.rows.length, 1);
  } finally {
    await t.close();
  }
});
test("positions return exact YES, NO, INVALID payouts and omit redeemed zero balances", async () => {
  const t = await fixture();
  try {
    for (const [id, outcome] of [
      [1, "YES"],
      [2, "NO"],
      [3, "INVALID"],
    ] as const)
      await t.db.query(
        "UPDATE protocol.markets SET data=data||jsonb_build_object('state','FINAL','finalOutcome',$2::text) WHERE key::numeric=$1",
        [id, outcome],
      );
    for (let id = 1; id <= 5; id++)
      await t.db.query(
        "INSERT INTO protocol.positions(deployment_id,key,data,as_of_block_hash) VALUES ('d1',$1::text||':0x'||$2::text,jsonb_build_object('marketId',$1::text,'account','0x'||$2::text,'yesShares',$3::text,'noShares',$4::text,'takerBoughtShares','0','redeemedPayoutMicros',$5::text),decode($6,'hex'))",
        [
          id,
          address.slice(2),
          id === 5 ? "0" : "9007199254740993",
          id === 5 ? "0" : "3",
          id === 5 ? "1000000" : "0",
          hash(10).slice(2),
        ],
      );
    await t.setRole("blink_api");
    const r = await t.app.inject(
      "/v1/accounts/" + address + "/positions?deploymentId=d1",
    );
    assert.equal(r.statusCode, 200, r.body);
    const list = parse("/v1/accounts/:address/positions", r.json());
    assert.equal(list.items.length, 4);
    assert.deepEqual(
      list.items.map((p: any) => p.payoutMicros),
      [null, "4503599627370498000000", "3000000", "9007199254740993000000"],
    );
    const first = await t.app.inject(
      "/v1/accounts/" + address + "/positions?deploymentId=d1&limit=2",
    );
    assert.ok(first.json().nextCursor);
    const second = await t.app.inject(
      "/v1/accounts/" +
        address +
        "/positions?deploymentId=d1&limit=2&cursor=" +
        first.json().nextCursor,
    );
    assert.equal(second.json().items.length, 2);
    assert.equal(second.json().nextCursor, null);
  } finally {
    await t.close();
  }
});
test("public GET rate limit covers every market-read GET contract", async () => {
  const t = await fixture();
  const app = buildApi({
    services: [
      createMarketReadService({
        store: postgresMarketReadStore(t.pool),
        archive: t.archive,
        identity: {
          async authenticate() {
            throw new Error("unused");
          },
        },
      }),
    ],
    publicReadLimit: { capacity: 1, refillPerSecond: 1, now: () => 0 },
  });
  try {
    assert.equal((await app.inject("/v1/markets")).statusCode, 200);
    for (const url of [
      "/v1/markets",
      "/v1/markets/1?deploymentId=d1",
      "/v1/markets/1/spec?deploymentId=d1",
      "/v1/markets/1/resolution?deploymentId=d1",
      "/v1/accounts/" + address + "/positions?deploymentId=d1",
      "/v1/transactions/" + hash(1) + "?deploymentId=d1",
    ]) {
      const r = await app.inject(url);
      assert.equal(r.statusCode, 429);
      assert.equal(r.json().code, "RATE_LIMITED");
      assert.ok(r.headers["retry-after"]);
    }
  } finally {
    await app.close();
    await t.close();
  }
});
test("the hook supplies trading permission", async () => {
  const t = await fixture({
    async canTrade(market, cursor) {
      return {
        canTrade: cursor !== null && market.effectiveState === "OPEN",
        reasons: [],
      };
    },
  });
  try {
    await seedSpec(t);
    await t.setRole("blink_api");
    const detail = parse(
      "/v1/markets/:id",
      (await t.app.inject("/v1/markets/1?deploymentId=d1")).json(),
    );
    assert.equal(detail.canTrade, true);
    assert.deepEqual(detail.reasons, []);
    const list = parse(
      "/v1/markets",
      (await t.app.inject("/v1/markets?limit=1")).json(),
    );
    assert.equal(list.items[0].canTrade, true);
  } finally {
    await t.close();
  }
});
