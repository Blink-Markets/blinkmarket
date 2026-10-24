import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { withDatabase } from "../helpers/postgres-database.js";
import { fileObjectStore } from "../../packages/adapters/src/file-object-store.js";
import { postgresContentStore } from "../../packages/adapters/src/content-store.js";
import { postgresSuggestionStore } from "../../packages/adapters/src/suggestion-store.js";

const uploader = "0x" + "c1".repeat(20);
const text = "Will the observatory close for a typhoon in 2026?";

test("real PostgreSQL: concurrent identical uploads store one record, linked once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-t8-content-"));
  try {
    await withDatabase(async ({ owner, login }) => {
      const api = await login({ memberOf: ["blink_api"] });
      const content = postgresContentStore(api, fileObjectStore(directory));
      const suggestions = postgresSuggestionStore(api);
      const suggestionId = randomUUID();
      await suggestions.add({ id: suggestionId, text, sourceUrls: [] });
      const bytes = new TextEncoder().encode('{"a":1}\n');
      const hash = keccak256(bytes);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          content.put({
            hash,
            bytes,
            mediaType: "application/json",
            uploader,
            suggestionId,
          }),
        ),
      );
      for (const r of results)
        assert.deepEqual(r, {
          hash,
          size: bytes.length,
          mediaType: "application/json",
        });
      const counts = await owner.query(
        `SELECT (SELECT count(*) FROM content.objects)::int AS objects,
                (SELECT count(*) FROM suggestions.spec_links)::int AS links`,
      );
      assert.deepEqual(counts.rows[0], { objects: 1, links: 1 });
      const found = await content.get(hash);
      assert.deepEqual(Buffer.from(found!.bytes), Buffer.from(bytes));
      // A suggestion that does not exist is not linked, and does not fail the upload.
      const other = new TextEncoder().encode("other");
      await content.put({
        hash: keccak256(other),
        bytes: other,
        mediaType: "text/plain",
        uploader,
        suggestionId: randomUUID(),
      });
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM suggestions.spec_links",
          )
        ).rows[0].n,
        1,
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real PostgreSQL: one claim per creator under concurrency, and the API role cannot rewrite", async () => {
  await withDatabase(async ({ owner, login }) => {
    const api = await login({ memberOf: ["blink_api"] });
    const store = postgresSuggestionStore(api);
    const id = randomUUID();
    await store.add({ id, text, sourceUrls: ["https://example.org/a"] });
    const creators = ["a1", "a2"].map((b) => "0x" + b.repeat(20));
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.claim(id, creators[i % 2]!)),
    );
    assert.equal(outcomes.filter((o) => o === true).length, 2);
    assert.equal(outcomes.filter((o) => o === false).length, 6);
    assert.equal(await store.claim(randomUUID(), creators[0]!), null);
    assert.equal((await store.get(id))!.claimCount, 2);
    // Newest first, and `after` continues from the last row seen.
    const second = randomUUID();
    await store.add({ id: second, text, sourceUrls: [] });
    const first = await store.list({ after: null, limit: 1 });
    assert.deepEqual(
      first.map((r) => r.id),
      [second],
    );
    const rest = await store.list({ after: first[0]!.seq, limit: 5 });
    assert.deepEqual(
      rest.map((r) => r.id),
      [id],
    );
    // Nothing is ever updated, deleted or truncated, and the table checks hold even for a direct insert.
    for (const sql of [
      "UPDATE suggestions.items SET body='rewritten suggestion text here'",
      "DELETE FROM suggestions.claims",
      "TRUNCATE suggestions.spec_links",
      "UPDATE content.objects SET media_type='text/plain'",
      "DELETE FROM content.objects",
    ])
      await assert.rejects(api.query(sql), /./, sql);
    await assert.rejects(
      api.query(
        "INSERT INTO suggestions.items(id,body) VALUES ($1,'too short')",
        [randomUUID()],
      ),
    );
    await assert.rejects(
      api.query(
        "INSERT INTO content.objects(hash,size,media_type,uploader) VALUES (decode($1,'hex'),1,'image/png',decode($2,'hex'))",
        ["11".repeat(32), "c1".repeat(20)],
      ),
    );
    await assert.rejects(
      api.query(
        "INSERT INTO content.objects(hash,size,media_type,uploader) VALUES (decode($1,'hex'),1048577,'text/plain',decode($2,'hex'))",
        ["12".repeat(32), "c1".repeat(20)],
      ),
    );
    // The evidence administration role is gone.
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM pg_roles WHERE rolname='blink_evidence_admin'",
        )
      ).rows[0].n,
      0,
    );
  });
});
