import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  apiContracts,
  generateOpenApi,
} from "../packages/schemas/src/index.js";
import { marketFor, offchainFixture } from "./helpers/offchain-fixture.js";

type Fixture = Awaited<ReturnType<typeof offchainFixture>>;
const TEXT = "Will the Taipei 101 observatory close for a typhoon in 2026?";
// Limits far above what a test sends, for the tests that are not about the limits.
const roomy = {
  perIp: { limit: 1000, windowSeconds: 3600 },
  global: { limit: 1000, windowSeconds: 86_400 },
};
const suggest = (f: Fixture, body: unknown, remoteAddress = "10.0.0.1") =>
  f.app.inject({
    method: "POST",
    url: "/v1/suggestions",
    payload: body as object,
    remoteAddress,
  });
const claim = (f: Fixture, id: string, agent: { apiKey: string } | null) =>
  f.app.inject({
    method: "POST",
    url: `/v1/suggestions/${id}/claims`,
    headers: agent ? f.bearer(agent) : {},
  });
const contract = (method: string, path: string) =>
  apiContracts.find((c) => c.method === method && c.path === path)!;

test("anonymous suggestion accepted", async () => {
  const f = await offchainFixture({ suggestionLimits: roomy });
  try {
    const res = await suggest(f, {
      text: TEXT,
      sourceUrls: ["https://example.org/a"],
    });
    assert.equal(res.statusCode, 201, res.body);
    contract("POST", "/v1/suggestions").response.parse(res.json());
    const shown = await f.app.inject("/v1/suggestions/" + res.json().id);
    assert.equal(shown.statusCode, 200);
    contract("GET", "/v1/suggestions/:id").response.parse(shown.json());
    assert.equal(shown.json().text, TEXT);
    assert.deepEqual(shown.json().sourceUrls, ["https://example.org/a"]);
    assert.equal(shown.json().status, "OPEN");
    assert.equal(shown.json().claimCount, 0);
    const listed = await f.app.inject("/v1/suggestions");
    contract("GET", "/v1/suggestions").response.parse(listed.json());
    assert.deepEqual(
      listed.json().items.map((i: { id: string }) => i.id),
      [res.json().id],
    );
    // No Idempotency-Key and no credential are involved, and no source URL is fetched.
    assert.equal(
      (await f.app.inject("/v1/suggestions/" + randomUUID())).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("rate limit per IP", async () => {
  let clock = 0;
  const f = await offchainFixture({
    suggestionLimits: {
      perIp: { limit: 5, windowSeconds: 3600, now: () => clock },
      global: { limit: 500, windowSeconds: 86_400, now: () => clock },
    },
  });
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await suggest(f, { text: TEXT + " #" + i })).statusCode,
        201,
        "request " + i,
      );
    const limited = await suggest(f, { text: TEXT });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "RATE_LIMITED");
    assert.equal(limited.json().retryable, true);
    assert.equal(limited.headers["retry-after"], "3600");
    // Another client is unaffected.
    assert.equal(
      (await suggest(f, { text: TEXT }, "10.0.0.2")).statusCode,
      201,
    );
    // At 12 minutes five requests are still inside the hour: a refilling bucket would admit a sixth.
    clock = 12 * 60_000;
    const early = await suggest(f, { text: TEXT });
    assert.equal(early.statusCode, 429, "five per trailing hour, not a refill");
    assert.equal(early.headers["retry-after"], String(48 * 60));
    // The refused requests were not counted: the five accepted at t=0 leave the hour together, and
    // then five more fit, not six.
    clock = 3_600_000;
    for (let i = 0; i < 5; i++)
      assert.equal((await suggest(f, { text: TEXT })).statusCode, 201);
    assert.equal((await suggest(f, { text: TEXT })).statusCode, 429);
    // A refused request is not stored: five, one other client and five after the hour.
    assert.equal(
      (await f.app.inject("/v1/suggestions?limit=100")).json().items.length,
      11,
    );
  } finally {
    await f.close();
  }
});

test("global daily limit", async () => {
  let clock = 0;
  const f = await offchainFixture({
    suggestionLimits: {
      perIp: { limit: 1000, windowSeconds: 3600, now: () => clock },
      global: { limit: 500, windowSeconds: 86_400, now: () => clock },
    },
  });
  try {
    for (let i = 0; i < 500; i++)
      assert.equal(
        (await suggest(f, { text: TEXT }, `10.${i >> 8}.${i & 255}.1`))
          .statusCode,
        201,
        "request " + i,
      );
    // The 501st within the day is refused, even from a client that has not submitted yet...
    clock = 23 * 3_600_000;
    const limited = await suggest(f, { text: TEXT }, "10.200.0.1");
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "RATE_LIMITED");
    assert.equal(limited.headers["retry-after"], "3600");
    // ...and accepted once the first events have left the day.
    clock = 86_400_000;
    assert.equal(
      (await suggest(f, { text: TEXT }, "10.200.0.1")).statusCode,
      201,
    );
  } finally {
    await f.close();
  }
});

test("text bounds", async () => {
  const f = await offchainFixture({ suggestionLimits: roomy });
  try {
    const bad = async (body: unknown) =>
      assert.equal(
        (await suggest(f, body, "10.0.0.1")).statusCode,
        400,
        JSON.stringify(body).slice(0, 80),
      );
    await bad({ text: "x".repeat(19) });
    await bad({ text: " ".repeat(30) });
    await bad({ text: "x".repeat(2001) });
    await bad({ text: TEXT + "\u0000" });
    await bad({});
    await bad({ text: 12 });
    await bad({ text: TEXT, extra: true });
    await bad({
      text: TEXT,
      sourceUrls: Array(6).fill("https://example.org/"),
    });
    const notAnObject = await f.app.inject({
      method: "POST",
      url: "/v1/suggestions",
      headers: { "content-type": "application/json" },
      payload: '"not an object"',
    });
    assert.equal(notAnObject.statusCode, 400);
    assert.equal((await suggest(f, { text: "x".repeat(20) })).statusCode, 201);
    assert.equal(
      (await suggest(f, { text: "x".repeat(2000) })).statusCode,
      201,
    );
    // Length counts characters, not UTF-16 units: ten emoji are ten characters, too short.
    await bad({ text: "😀".repeat(10) });
    assert.equal((await suggest(f, { text: "😀".repeat(20) })).statusCode, 201);
    assert.equal(
      (
        await suggest(
          f,
          { text: TEXT, sourceUrls: Array(5).fill("https://example.org/") },
          "10.8.0.4",
        )
      ).statusCode,
      201,
    );
    // The request body is capped at 8 KiB.
    const big = await suggest(
      f,
      { text: TEXT, sourceUrls: [], pad: "p".repeat(9000) },
      "10.8.0.5",
    );
    assert.equal(big.statusCode, 413);
  } finally {
    await f.close();
  }
});

test("non-https source refused", async () => {
  const f = await offchainFixture({ suggestionLimits: roomy });
  try {
    for (const url of [
      "http://example.org/a",
      "ftp://example.org/a",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "example.org",
      "https://user:secret@example.org/a",
      "https://example.org/" + "a".repeat(2100),
    ]) {
      const res = await suggest(
        f,
        { text: TEXT, sourceUrls: [url] },
        "10.0.0.1",
      );
      assert.equal(res.statusCode, 400, url.slice(0, 40));
    }
    assert.equal(
      (await f.app.inject("/v1/suggestions")).json().items.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("claim needs CREATOR role", async () => {
  const f = await offchainFixture({ suggestionLimits: roomy });
  try {
    const { id } = (await suggest(f, { text: TEXT })).json();
    const refused = async (
      res: Promise<{ statusCode: number; json(): { code: string } }>,
      status: number,
      code: string,
    ) => {
      const r = await res;
      assert.equal(r.statusCode, status);
      assert.equal(r.json().code, code);
    };
    await refused(claim(f, id, null), 401, "UNAUTHORIZED");
    await refused(claim(f, id, f.agents.scopeless), 403, "SCOPE_DENIED");
    // Registered, with the scope, but no CREATOR role.
    await refused(claim(f, id, f.agents.forecaster), 403, "ROLE_REQUIRED");
    await refused(claim(f, id, f.agents.stranger), 403, "ROLE_REQUIRED");
    assert.equal(
      (await f.app.inject("/v1/suggestions/" + id)).json().claimCount,
      0,
    );
    const ok = await claim(f, id, f.agents.creator);
    assert.equal(ok.statusCode, 201, ok.body);
    contract("POST", "/v1/suggestions/:id/claims").response.parse(ok.json());
    assert.equal(ok.json().status, "CLAIMED");
    assert.equal(ok.json().claimCount, 1);
    // One claim per creator.
    await refused(claim(f, id, f.agents.creator), 409, "ALREADY_CLAIMED");
    await refused(claim(f, randomUUID(), f.agents.creator), 404, "NOT_FOUND");
    // The role is checked against the index at request time, and a stale index refuses.
    f.reader.set({ accounts: [] });
    await refused(claim(f, id, f.agents.creator), 403, "ROLE_REQUIRED");
    f.reader.set({
      health: { headBlock: 9, indexedBlock: 1, lagSeconds: 99, stale: true },
    });
    await refused(claim(f, id, f.agents.creator), 503, "INDEX_STALE");
  } finally {
    await f.close();
  }
});

test("status follows claims and created markets", async () => {
  const f = await offchainFixture({ suggestionLimits: roomy });
  try {
    const ids = [] as string[];
    for (let i = 0; i < 3; i++)
      ids.push(
        (await suggest(f, { text: TEXT + " #" + i }, "10.0.0.1")).json().id,
      );
    const statuses = async (query = "") =>
      Object.fromEntries(
        (await f.app.inject("/v1/suggestions?limit=100" + query))
          .json()
          .items.map((i: { id: string; status: string }) => [i.id, i.status]),
      );
    assert.deepEqual(Object.values(await statuses()), ["OPEN", "OPEN", "OPEN"]);
    assert.equal((await claim(f, ids[1]!, f.agents.creator)).statusCode, 201);
    assert.deepEqual(await statuses(), {
      [ids[0]!]: "OPEN",
      [ids[1]!]: "CLAIMED",
      [ids[2]!]: "OPEN",
    });
    // A spec naming the suggestion, once its market exists, outranks a claim.
    const hash = "0x" + "ab".repeat(32);
    await f.t.db.query(
      "INSERT INTO suggestions.spec_links(spec_hash,suggestion_id,linked_by) VALUES (decode($1,'hex'),$2,decode($3,'hex'))",
      [hash.slice(2), ids[1], "11".repeat(20)],
    );
    assert.equal(
      (await statuses())[ids[1]!],
      "CLAIMED",
      "a link without a market changes nothing",
    );
    f.reader.set({ markets: [marketFor(hash)] });
    assert.equal((await statuses())[ids[1]!], "MARKET_CREATED");
    // A market without any claim also counts.
    await f.t.db.query(
      "INSERT INTO suggestions.spec_links(spec_hash,suggestion_id,linked_by) VALUES (decode($1,'hex'),$2,decode($3,'hex'))",
      [hash.slice(2), ids[2], "11".repeat(20)],
    );
    assert.deepEqual(await statuses(), {
      [ids[0]!]: "OPEN",
      [ids[1]!]: "MARKET_CREATED",
      [ids[2]!]: "MARKET_CREATED",
    });
    // Filters and paging see the derived status.
    assert.deepEqual(Object.keys(await statuses("&status=OPEN")), [ids[0]]);
    assert.deepEqual(Object.keys(await statuses("&status=CLAIMED")), []);
    const created = await f.app.inject(
      "/v1/suggestions?limit=1&status=MARKET_CREATED",
    );
    assert.deepEqual(
      created.json().items.map((i: { id: string }) => i.id),
      [ids[2]],
    );
    const next = created.json().nextCursor as string;
    assert.ok(next);
    const second = await f.app.inject(
      `/v1/suggestions?limit=1&status=MARKET_CREATED&cursor=${next}`,
    );
    assert.deepEqual(
      second.json().items.map((i: { id: string }) => i.id),
      [ids[1]],
    );
    assert.equal(second.json().nextCursor, null);
    assert.equal(
      (await f.app.inject("/v1/suggestions?cursor=abc")).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject("/v1/suggestions?status=DONE")).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test("suggestion gives no write access", async () => {
  const f = await offchainFixture({ suggestionLimits: roomy });
  try {
    const { id } = (await suggest(f, { text: TEXT })).json();
    // The id is public. Presenting it as a credential, in any header, opens no route.
    const credentials = [
      { authorization: "Bearer " + id },
      { authorization: "Bearer blink_" + id + "." + "0".repeat(64) },
      { authorization: id },
      { "x-suggestion-id": id },
    ];
    for (const headers of credentials) {
      const upload = await f.app.inject({
        method: "POST",
        url: "/v1/content",
        headers: { ...headers, "content-type": "text/plain" },
        payload: Buffer.from("payload"),
      });
      assert.equal(upload.statusCode, 401, JSON.stringify(headers));
      const claimed = await f.app.inject({
        method: "POST",
        url: `/v1/suggestions/${id}/claims`,
        headers,
      });
      assert.equal(claimed.statusCode, 401, JSON.stringify(headers));
    }
    // Every route that takes a suggestion id in its path is read-only, except the claim, which
    // needs a key. No write route takes an id as its authorization.
    const withId = apiContracts.filter((c) =>
      c.path.startsWith("/v1/suggestions/:id"),
    );
    assert.deepEqual(
      withId.map((c) => `${c.method} ${c.path} ${c.access}`).sort(),
      [
        "GET /v1/suggestions/:id public",
        "POST /v1/suggestions/:id/claims suggestion:claim",
      ],
    );
    // The claim route does not exist as a public write, and no suggestion row was changed.
    const shown = await f.app.inject("/v1/suggestions/" + id);
    assert.equal(shown.json().claimCount, 0);
    assert.equal(shown.json().status, "OPEN");
    // The database role of the API cannot rewrite or delete a suggestion.
    await assert.rejects(
      f.t.db.query(
        "UPDATE suggestions.items SET body='changed text of a suggestion'",
      ),
    );
    await assert.rejects(f.t.db.query("DELETE FROM suggestions.claims"));
  } finally {
    await f.close();
  }
});
