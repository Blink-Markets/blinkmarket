import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256 } from "viem";
import { apiContracts } from "../packages/schemas/src/index.js";
import {
  PUBLIC_ORIGIN,
  offchainFixture,
  marketFor,
} from "./helpers/offchain-fixture.js";

const uploadContract = apiContracts.find(
  (c) => c.method === "POST" && c.path === "/v1/content",
)!;
const spec = (suggestionId?: string) => ({
  schema: "blink.market-spec/0.2",
  title: "Will it rain",
  question: "Will it rain in Taipei on 2026-12-01?",
  class: "B",
  resolution: { yes: "Rain was recorded.", no: "No rain was recorded." },
  sources: ["https://example.org/weather"],
  ...(suggestionId ? { suggestionId } : {}),
});
const count = async (f: Awaited<ReturnType<typeof offchainFixture>>) =>
  Number(
    (
      await f.t.db.query<{ n: string }>(
        "SELECT count(*) AS n FROM content.objects",
      )
    ).rows[0]!.n,
  );

test("upload is hash addressed and idempotent", async () => {
  const f = await offchainFixture();
  try {
    // Odd whitespace is kept: the hash covers exactly these bytes.
    const bytes = Buffer.from('{ "b" : 1,\r\n "a":2 }\n');
    const first = await f.upload(f.agents.creator, bytes);
    assert.equal(first.statusCode, 201, first.body);
    const hash = keccak256(bytes);
    assert.deepEqual(first.json(), {
      hash,
      size: bytes.length,
      mediaType: "application/json",
      uri: PUBLIC_ORIGIN + "/v1/content/" + hash,
    });
    uploadContract.response.parse(first.json());
    const again = await f.upload(f.agents.creator, bytes);
    assert.equal(again.statusCode, 201);
    assert.deepEqual(again.json(), first.json());
    assert.equal(await count(f), 1);
    // The same bytes uploaded by someone else are the same object.
    assert.deepEqual(
      (await f.upload(f.agents.forecaster, bytes)).json(),
      first.json(),
    );
    assert.equal(await count(f), 1);
  } finally {
    await f.close();
  }
});

test("unregistered address refused", async () => {
  const f = await offchainFixture();
  try {
    const bytes = "some evidence";
    const refused = async (
      res: ReturnType<typeof f.upload>,
      status: number,
      code: string,
    ) => {
      const r = await res;
      assert.equal(r.statusCode, status, r.body);
      assert.equal(r.json().code, code);
    };
    await refused(
      f.upload(f.agents.stranger, bytes, "text/plain"),
      403,
      "NOT_REGISTERED",
    );
    await refused(
      f.upload(f.agents.scopeless, bytes, "text/plain"),
      403,
      "SCOPE_DENIED",
    );
    await refused(f.upload(null, bytes, "text/plain"), 401, "UNAUTHORIZED");
    await refused(
      f.upload(
        { apiKey: "blink_" + randomUUID() + "." + "0".repeat(64) },
        bytes,
        "text/plain",
      ),
      401,
      "UNAUTHORIZED",
    );
    // Nothing was stored by any refused request.
    assert.equal(await count(f), 0);
    const missing = await f.app.inject(
      "/v1/content/" + keccak256(Buffer.from(bytes)),
    );
    assert.equal(missing.statusCode, 404);
  } finally {
    await f.close();
  }
});

test("oversize refused", async () => {
  const f = await offchainFixture();
  try {
    const limit = 1024 * 1024;
    const over = await f.upload(
      f.agents.creator,
      Buffer.alloc(limit + 1, 0x61),
      "text/plain",
    );
    assert.equal(over.statusCode, 413);
    const exact = await f.upload(
      f.agents.creator,
      Buffer.alloc(limit, 0x61),
      "text/plain",
    );
    assert.equal(exact.statusCode, 201, exact.body);
    assert.equal(exact.json().size, limit);
    const empty = await f.upload(
      f.agents.creator,
      Buffer.alloc(0),
      "text/plain",
    );
    assert.equal(empty.statusCode, 400);
    assert.equal(await count(f), 1);
  } finally {
    await f.close();
  }
});

test("only the five media types are accepted", async () => {
  const f = await offchainFixture();
  try {
    for (const type of [
      "image/png",
      "application/octet-stream",
      "application/xml",
      "text/javascript",
    ]) {
      const res = await f.upload(f.agents.creator, "payload", type);
      assert.equal(res.statusCode, 415, type);
    }
    for (const type of [
      "application/json",
      "text/plain",
      "text/csv",
      "text/html",
      "application/pdf",
      "Text/Plain; charset=utf-8",
    ]) {
      const res = await f.upload(f.agents.creator, "payload " + type, type);
      assert.equal(res.statusCode, 201, type + " " + res.body);
    }
    const noType = await f.app.inject({
      method: "POST",
      url: "/v1/content",
      headers: f.bearer(f.agents.creator),
      payload: Buffer.from("x"),
    });
    assert.equal(noType.statusCode, 415);
    assert.equal(await count(f), 6);
  } finally {
    await f.close();
  }
});

test("html served as sandboxed attachment", async () => {
  const f = await offchainFixture();
  try {
    const html =
      '<script>fetch("/v1/config")</script><img src=x onerror=alert(1)>';
    const up = await f.upload(f.agents.creator, html, "text/html");
    assert.equal(up.statusCode, 201, up.body);
    const got = await f.app.inject(`/v1/content/${up.json().hash}`);
    assert.equal(got.statusCode, 200);
    assert.match(String(got.headers["content-type"]), /^text\/html/);
    assert.equal(got.headers["content-disposition"], "attachment");
    assert.equal(got.headers["content-security-policy"], "sandbox");
    assert.equal(got.headers["x-content-type-options"], "nosniff");
    assert.equal(
      got.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
    assert.equal(got.body, html);
    // Other types are not forced into a download, but are sandboxed and never sniffed.
    const json = await f.upload(f.agents.creator, '{"a":1}');
    const served = await f.app.inject(`/v1/content/${json.json().hash}`);
    assert.match(String(served.headers["content-type"]), /^application\/json/);
    assert.equal(served.headers["content-disposition"], undefined);
    assert.equal(served.headers["content-security-policy"], "sandbox");
    assert.equal(served.headers["x-content-type-options"], "nosniff");
  } finally {
    await f.close();
  }
});

test("bytes returned exactly", async () => {
  const f = await offchainFixture();
  try {
    // Every byte value, including ones that are not valid UTF-8, and a trailing newline.
    const bytes = Buffer.from([...Array(256).keys(), 10]);
    const up = await f.upload(f.agents.creator, bytes, "application/pdf");
    assert.equal(up.statusCode, 201, up.body);
    const got = await f.app.inject(`/v1/content/${up.json().hash}`);
    assert.ok(got.rawPayload.equals(bytes));
    assert.match(String(got.headers["content-type"]), /^application\/pdf/);
    // Bytes that no longer match their hash are never served.
    const file = join(f.directory, up.json().hash + ".bin");
    await rm(file);
    await writeFile(file, Buffer.from("tampered"));
    const damaged = await f.app.inject(`/v1/content/${up.json().hash}`);
    assert.equal(damaged.statusCode, 503);
    assert.equal(damaged.json().code, "CONTENT_UNAVAILABLE");
    // A hash that is not a lowercase 32-byte hex string is refused before any lookup.
    assert.equal((await f.app.inject("/v1/content/0x12")).statusCode, 400);
    assert.equal(
      (await f.app.inject("/v1/content/" + "0x" + "00".repeat(32))).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("spec with suggestionId links", async () => {
  const f = await offchainFixture();
  try {
    const id = randomUUID();
    await f.suggestions.add({
      id,
      text: "Will it rain in Taipei on 2026-12-01?",
      sourceUrls: [],
    });
    const bytes = Buffer.from(JSON.stringify(spec(id)));
    const up = await f.upload(f.agents.creator, bytes);
    assert.equal(up.statusCode, 201, up.body);
    const links = async () =>
      (
        await f.t.db.query<{
          spec_hash: string;
          suggestion_id: string;
          linked_by: string;
        }>(
          `SELECT '0x'||encode(spec_hash,'hex') AS spec_hash,suggestion_id,'0x'||encode(linked_by,'hex') AS linked_by
           FROM suggestions.spec_links`,
        )
      ).rows;
    assert.deepEqual(await links(), [
      {
        spec_hash: up.json().hash,
        suggestion_id: id,
        linked_by: "0x00000000000000000000000000000000000000c1",
      },
    ]);
    // Uploading again, or from another identity, adds no second link.
    await f.upload(f.agents.creator, bytes);
    await f.upload(f.agents.forecaster, bytes);
    assert.equal((await links()).length, 1);
    // A suggestion that does not exist is ignored; so are bytes that are not a spec.
    const unknown = await f.upload(
      f.agents.creator,
      JSON.stringify(spec(randomUUID())),
    );
    assert.equal(unknown.statusCode, 201);
    const notSpec = await f.upload(
      f.agents.creator,
      JSON.stringify({ suggestionId: id, other: 1 }),
    );
    assert.equal(notSpec.statusCode, 201);
    assert.equal((await links()).length, 1);
    // The link is what turns the suggestion into MARKET_CREATED once the spec has a market.
    f.reader.set({ markets: [marketFor(up.json().hash)] });
    const shown = await f.app.inject("/v1/suggestions/" + id);
    assert.equal(shown.json().status, "MARKET_CREATED");
    assert.deepEqual(shown.json().specHashes, [up.json().hash]);
  } finally {
    await f.close();
  }
});

test("upload refuses when index is stale", async () => {
  const f = await offchainFixture();
  try {
    f.reader.set({
      health: { headBlock: 100, indexedBlock: 1, lagSeconds: 600, stale: true },
    });
    const res = await f.upload(f.agents.creator, "evidence", "text/plain");
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().code, "INDEX_STALE");
    assert.equal(res.json().retryable, true);
    // A reader that fails counts as a stale index.
    f.reader.set({ health: undefined as never });
    assert.equal(
      (await f.upload(f.agents.creator, "evidence", "text/plain")).json().code,
      "INDEX_STALE",
    );
    assert.equal(await count(f), 0);
    // Reads stay open while the index is stale.
    f.reader.set({
      health: { headBlock: 1, indexedBlock: 1, lagSeconds: 0, stale: false },
    });
    const ok = await f.upload(f.agents.creator, "evidence", "text/plain");
    assert.equal(ok.statusCode, 201);
    f.reader.set({
      health: { headBlock: 100, indexedBlock: 1, lagSeconds: 600, stale: true },
    });
    assert.equal(
      (await f.app.inject("/v1/content/" + ok.json().hash)).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
