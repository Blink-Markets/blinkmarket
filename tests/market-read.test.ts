import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../apps/api/src/server.js";
import { createMarketReadService } from "../packages/application/src/market-read.js";
import {
  apiContracts,
  presets,
  type ProtocolMarket,
  type ProtocolVote,
} from "../packages/schemas/src/index.js";
import type { ContentStore, ProtocolReader } from "../packages/ports/src/index.js";
import { fakeProtocolReader } from "./helpers/protocol-reader.js";
import { readerContractState } from "./helpers/protocol-reader-contract.js";
import { address, hash, protocolManifest, readMarket } from "./helpers/protocol-index.js";
import { fixture } from "./helpers/market-read.js";

const encode = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const SPEC = {
  schema: "blink.market-spec/0.2",
  title: "Fixture market",
  question: "Will the fixture happen?",
  class: "B",
  resolution: { yes: "It happened.", no: "It did not." },
  sources: ["https://example.com/fixture-only"],
};
const NOW = 1_000_000;

/** Spec bytes by market id: valid, invalid JSON, missing, and damaged (the store throws). */
function content(): Pick<ContentStore, "get"> {
  const stored: Record<string, Uint8Array> = {
    [hash(1)]: encode(SPEC),
    [hash(2)]: encode("{not json"),
  };
  return {
    async get(h) {
      if (h === hash(4)) throw new Error("CONTENT_DAMAGED");
      const bytes = stored[h];
      return bytes
        ? { object: { hash: h, size: bytes.length, mediaType: "application/json" }, bytes }
        : null;
    },
  };
}
const markets = () =>
  [1, 2, 3, 4, 5].map((id) => readMarket(id, { state: id === 5 ? "FINAL" : "OPEN" })) as ProtocolMarket[];

function api(reader: ProtocolReader, options: Parameters<typeof buildApi>[0] = {}) {
  return buildApi({
    services: [
      createMarketReadService({
        reader,
        content: content(),
        deployment: async () => protocolManifest(),
        now: () => NOW,
        store: {
          async transaction() {
            return null;
          },
        },
      }),
    ],
    ...options,
  });
}
const parse = (path: string, body: unknown) => {
  const result = apiContracts
    .find((c) => c.method === "GET" && c.path === path)!
    .response.safeParse(body);
  assert.ok(result.success, path + ": " + JSON.stringify(result.error?.issues.slice(0, 3)) + JSON.stringify(body).slice(0, 300));
  return result.data as any;
};
const seeded = () => ({ ...readerContractState(), markets: markets() });

test("market with invalid spec bytes still listed with parse error", async () => {
  const app = api(fakeProtocolReader(seeded()));
  try {
    const list = await app.inject("/v1/markets?limit=10");
    assert.equal(list.statusCode, 200, list.body);
    const body = parse("/v1/markets", list.json());
    assert.deepEqual(
      body.items.map((i: any) => [i.market.marketId, i.spec.ok, i.spec.error ?? null]),
      [
        ["1", true, null],
        ["2", false, "INVALID_JSON"],
        ["3", false, "SPEC_UNAVAILABLE"], // never uploaded
        ["4", false, "SPEC_UNAVAILABLE"], // stored bytes are damaged
        ["5", false, "SPEC_UNAVAILABLE"],
      ],
    );
    assert.equal(body.index.stale, false);
    const detail = await app.inject("/v1/markets/2");
    assert.equal(parse("/v1/markets/:id", detail.json()).spec.error, "INVALID_JSON");
    assert.equal(parse("/v1/markets/:id", (await app.inject("/v1/markets/1")).json()).spec.ok, true);
    assert.equal((await app.inject("/v1/markets/99")).statusCode, 404);
    assert.equal(
      (await app.inject("/v1/markets?state=FINAL")).json().items.length,
      1,
    );
    assert.equal((await app.inject("/v1/markets?state=NOPE")).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("spec route serves the exact stored bytes under the content security headers and carries index health in headers", async () => {
  const reader = fakeProtocolReader({
    ...seeded(),
    health: { headBlock: 9, indexedBlock: 7, lagSeconds: 12, stale: true },
  });
  const app = api(reader);
  const health = (r: { headers: Record<string, unknown> }) => ({
    stale: r.headers["blink-index-stale"],
    indexed: r.headers["blink-index-indexed-block"],
    head: r.headers["blink-index-head-block"],
    lag: r.headers["blink-index-lag-seconds"],
  });
  const stale = { stale: "true", indexed: "7", head: "9", lag: "12" };
  try {
    const ok = await app.inject("/v1/markets/1/spec");
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.rawPayload.toString(), JSON.stringify(SPEC));
    assert.match(String(ok.headers["content-type"]), /^application\/json/);
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal(ok.headers["content-security-policy"], "sandbox");
    assert.equal(ok.headers["cache-control"], "no-cache");
    assert.deepEqual(health(ok), stale);
    const invalid = await app.inject("/v1/markets/2/spec");
    assert.equal(invalid.rawPayload.toString(), "{not json"); // the bytes, whatever they are
    for (const id of ["3", "4"]) {
      const missing = await app.inject(`/v1/markets/${id}/spec`);
      assert.equal(missing.statusCode, 503);
      assert.equal(missing.json().code, "SPEC_UNAVAILABLE");
      assert.deepEqual(health(missing), stale);
    }
    const unknown = await app.inject("/v1/markets/99/spec");
    assert.equal(unknown.statusCode, 404);
    assert.deepEqual(health(unknown), stale);
    reader.set({ health: { headBlock: 9, indexedBlock: 9, lagSeconds: 0, stale: false } });
    assert.equal(health(await app.inject("/v1/markets/1/spec")).stale, "false");
    const doc = (await app.inject("/openapi.json")).json();
    const responses = doc.paths["/v1/markets/{id}/spec"].get.responses;
    for (const status of ["200", "404", "503"])
      assert.deepEqual(Object.keys(responses[status].headers).sort(), [
        "Blink-Index-Head-Block",
        "Blink-Index-Indexed-Block",
        "Blink-Index-Lag-Seconds",
        "Blink-Index-Stale",
      ], status);
    for (const status of ["400", "429"])
      assert.equal(responses[status].headers, undefined, status);
  } finally {
    await app.close();
  }
});

test("votes sealed until reveal", async () => {
  const state = seeded();
  const reader = fakeProtocolReader(state);
  // A reader that leaks: the service must still show no choice for an unrevealed vote.
  const leaky: ProtocolReader = {
    ...reader,
    votes: async (id, q) => {
      const page = await reader.votes(id, q);
      const raw = state.votes!.filter((v) => v.disputeId === id);
      return { ...page, items: page.items.map((v) => raw.find((r) => r.round === v.round && r.juror === v.juror)!) };
    },
  };
  assert.ok(state.votes!.some((v) => !v.revealed && v.choice !== null));
  for (const r of [reader, leaky]) {
    const app = api(r);
    try {
      const seen: ProtocolVote[] = [];
      let after = "";
      do {
        const res = await app.inject(`/v1/disputes/9?limit=1${after}`);
        assert.equal(res.statusCode, 200, res.body);
        const body = parse("/v1/disputes/:id", res.json());
        assert.deepEqual(body.rounds.map((x: any) => x.round), [0, 1]);
        seen.push(...body.votes);
        after = body.next ? `&after=${encodeURIComponent(body.next)}` : "";
      } while (after);
      assert.equal(seen.length, 3);
      for (const v of seen) assert.equal(v.choice, v.revealed ? 1 : null);
      assert.equal((await app.inject("/v1/disputes/404")).statusCode, 404);
    } finally {
      await app.close();
    }
  }
});

test("pagination stable", async () => {
  const reader = fakeProtocolReader(seeded());
  const app = api(reader);
  try {
    const first = (await app.inject("/v1/markets?limit=2")).json();
    assert.deepEqual(first.items.map((i: any) => i.market.marketId), ["1", "2"]);
    // Rows added behind and ahead of the cursor change neither this page's successor nor its order.
    reader.set({ markets: [...markets(), readMarket(6) as ProtocolMarket] });
    const second = (await app.inject(`/v1/markets?limit=2&after=${first.next}`)).json();
    assert.deepEqual(second.items.map((i: any) => i.market.marketId), ["3", "4"]);
    const third = (await app.inject(`/v1/markets?limit=2&after=${second.next}`)).json();
    assert.deepEqual(third.items.map((i: any) => i.market.marketId), ["5", "6"]);
    assert.equal(third.next, null);
    for (const q of ["limit=0", "limit=101", "limit=x", "extra=1"])
      assert.equal((await app.inject("/v1/markets?" + q)).statusCode, 400, q);
    const d = (await app.inject("/v1/markets/1/disputes?limit=1")).json();
    assert.deepEqual(parse("/v1/markets/:id/disputes", d).items.map((x: any) => x.disputeId), ["9"]);
    const rest = (await app.inject(`/v1/markets/1/disputes?limit=1&after=${d.next}`)).json();
    assert.deepEqual(rest.items.map((x: any) => x.disputeId), ["10"]);
    assert.equal(rest.next, null);
  } finally {
    await app.close();
  }
});

test("the real reader refuses a malformed cursor with INVALID_CURSOR", async () => {
  const t = await fixture();
  try {
    await t.db.query(
      "INSERT INTO protocol.disputes(deployment_id,key,data,as_of_block_hash) VALUES ('d1','10',$1,decode($2,'hex'))",
      [readerContractState().disputes![0], hash(10).slice(2)],
    );
    await t.setRole("blink_api");
    for (const url of [
      "/v1/markets?after=abc",
      "/v1/markets/1/disputes?after=abc",
      "/v1/disputes/10?after=abc",
      "/v1/accounts/" + address(1) + "/positions?after=abc",
      "/v1/templates?after=abc",
    ]) {
      const r = await t.app.inject(url);
      assert.equal(r.statusCode, 400, url + r.body);
      assert.equal(r.json().code, "INVALID_CURSOR", url);
    }
  } finally {
    await t.close();
  }
});

test("account and position read models decay credit and compute payouts at request time", async () => {
  const reader = fakeProtocolReader({
    ...seeded(),
    jurors: [{ ...seeded().jurors![0]!, address: address(1) }],
    positions: [
      { marketId: "1", account: address(1), yesShares: "5", noShares: "2", takerBoughtShares: "0", redeemedPayoutMicros: "0" },
      { marketId: "5", account: address(1), yesShares: "5", noShares: "2", takerBoughtShares: "0", redeemedPayoutMicros: "0" },
    ],
    markets: markets().map((m) => (m.marketId === "5" ? { ...m, finalOutcome: "YES" as const } : m)),
  });
  const app = api(reader);
  try {
    // Stored credit 100 at t=1000 with the 30-day half-life; NOW is 999000 s later.
    const r = await app.inject(`/v1/accounts/${address(1).toUpperCase().replace("0X", "0x")}`);
    const body = parse("/v1/accounts/:address", r.json());
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(body.creditAt, NOW);
    assert.equal(
      body.roles.MAKER.credit,
      await reader.creditAt(address(1), "MAKER", NOW),
    );
    assert.equal(body.roles.MAKER.hasRole, true);
    assert.equal(body.roles.TAKER.hasRole, false);
    assert.equal(body.juror.address, address(1));
    assert.equal(body.juror.pendingUnstake, "200");
    assert.equal((await app.inject(`/v1/accounts/${address(99)}`)).statusCode, 404);
    const positions = parse(
      "/v1/accounts/:address/positions",
      (await app.inject(`/v1/accounts/${address(1)}/positions`)).json(),
    );
    assert.deepEqual(
      positions.items.map((p: any) => [p.marketId, p.marketState, p.payoutMicros]),
      [["1", "OPEN", null], ["5", "FINAL", "5000000"]],
    );
    const fees = parse("/v1/markets/:id/fees", (await app.inject("/v1/markets/5/fees")).json());
    assert.equal(fees.fees, null);
    assert.equal(
      parse("/v1/templates", (await app.inject("/v1/templates")).json()).items.length,
      2,
    );
    const dep = parse("/v1/deployment", (await app.inject("/v1/deployment")).json());
    assert.equal(dep.deployment.params.commitSeconds, presets.alpha.commitSeconds);
  } finally {
    await app.close();
  }
});

test("public GET rate limit covers every read route", async () => {
  const app = api(fakeProtocolReader(seeded()), {
    publicReadLimit: { capacity: 1, refillPerSecond: 1, now: () => 0 },
  });
  try {
    assert.equal((await app.inject("/v1/markets")).statusCode, 200);
    for (const url of [
      "/v1/deployment",
      "/v1/markets",
      "/v1/markets/1",
      "/v1/markets/1/spec",
      "/v1/markets/1/disputes",
      "/v1/disputes/9",
      "/v1/markets/1/fees",
      "/v1/accounts/" + address(1),
      "/v1/accounts/" + address(1) + "/positions",
      "/v1/templates",
    ]) {
      const r = await app.inject(url);
      assert.equal(r.statusCode, 429, url);
      assert.equal(r.json().code, "RATE_LIMITED");
    }
  } finally {
    await app.close();
  }
});

test("every read route is a public GET contract", () => {
  const read = apiContracts.filter(
    (c) => c.method === "GET" && /^\/v1\/(deployment|markets|disputes|accounts|templates)/.test(c.path) && !c.path.includes("forecast"),
  );
  assert.equal(read.length, 10);
  for (const c of read) assert.match(c.access, /^public/, c.path);
});
