import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withDatabase } from "../helpers/postgres-database.js";
import { postgresRfqStore } from "../../packages/adapters/src/rfq-store.js";
import { hash, seedProtocolDeployment } from "../helpers/protocol-index.js";

const DEPLOYMENT = "pg-rfq";
const NOW = 1_000;
const taker = "0x" + "a1".repeat(20);
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const rfqInput = (id = randomUUID(), patch: Record<string, unknown> = {}) => ({
  id,
  marketId: "1",
  specHash: hash(7),
  side: "YES" as const,
  quantity: "10",
  taker,
  createdAt: NOW,
  expiresAt: NOW + 30,
  ...patch,
});
const quoteInput = (rfqId: string, maker: string, n: number) => ({
  rfqId,
  maker,
  digest: hash(n),
  priceBps: 4000,
  expiresAt: NOW + 60,
  quote: '{"marketId":"1"}',
  signature: "0x" + "11".repeat(65),
});

test("real PostgreSQL: concurrent RFQs never exceed five open per taker", async () => {
  await withDatabase(async ({ owner, login }) => {
    await seedProtocolDeployment(owner, DEPLOYMENT);
    const store = postgresRfqStore(await login({ memberOf: ["blink_api"], max: 20 }), DEPLOYMENT);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.create(rfqInput(), 5)),
    );
    assert.equal(results.filter(Boolean).length, 5);
    assert.equal(
      (await owner.query("SELECT count(*)::int AS n FROM rfq.requests")).rows[0].n,
      5,
    );
    // Another taker is not affected, and an expired RFQ no longer counts.
    assert.equal(await store.create(rfqInput(randomUUID(), { taker: "0x" + "b2".repeat(20) }), 5), true);
    assert.equal(await store.create(rfqInput(randomUUID(), { createdAt: NOW + 31, expiresAt: NOW + 61 }), 5), true);
  });
});

test("real PostgreSQL: concurrent quotes keep one per maker and at most the cap per RFQ", async () => {
  await withDatabase(async ({ owner, login }) => {
    await seedProtocolDeployment(owner, DEPLOYMENT);
    const store = postgresRfqStore(await login({ memberOf: ["blink_api"], max: 30 }), DEPLOYMENT, () => NOW);
    const rfqId = randomUUID();
    assert.equal(await store.create(rfqInput(rfqId), 5), true);
    const sameMaker = await Promise.all(
      Array.from({ length: 4 }, (_, i) => store.addQuote(quoteInput(rfqId, address(1), 100 + i), 20)),
    );
    assert.deepEqual(sameMaker.slice().sort(), ["DUPLICATE", "DUPLICATE", "DUPLICATE", "OK"]);
    const many = await Promise.all(
      Array.from({ length: 24 }, (_, i) => store.addQuote(quoteInput(rfqId, address(10 + i), 200 + i), 20)),
    );
    assert.equal(many.filter((r) => r === "OK").length, 19);
    assert.equal(many.filter((r) => r === "FULL").length, 5);
    assert.equal((await store.quotes(rfqId)).length, 20);
    assert.equal(
      (await owner.query("SELECT count(*)::int AS n FROM rfq.quotes WHERE rfq_id=$1", [rfqId])).rows[0].n,
      20,
    );
  });
});

test("real PostgreSQL: the API role can add rows but not rewrite or delete them", async () => {
  await withDatabase(async ({ owner, login }) => {
    await seedProtocolDeployment(owner, DEPLOYMENT);
    const api = await login({ memberOf: ["blink_api"] });
    const store = postgresRfqStore(api, DEPLOYMENT, () => NOW);
    const rfqId = randomUUID();
    await store.create(rfqInput(rfqId), 5);
    assert.equal(await store.addQuote(quoteInput(rfqId, address(1), 1), 20), "OK");
    await assert.rejects(api.query("UPDATE rfq.quotes SET price_bps=1"), /permission denied/);
    await assert.rejects(api.query("DELETE FROM rfq.requests"), /permission denied/);
    await assert.rejects(owner.query("UPDATE rfq.quotes SET price_bps=1"), /append-only/);
  });
});

test("real PostgreSQL: an insert that waits on the per-RFQ lock reads the clock after it gets the lock", async () => {
  await withDatabase(async ({ owner, login }) => {
    await seedProtocolDeployment(owner, DEPLOYMENT);
    let now = NOW;
    const store = postgresRfqStore(await login({ memberOf: ["blink_api"] }), DEPLOYMENT, () => now);
    const rfqId = randomUUID();
    assert.equal(await store.create(rfqInput(rfqId), 5), true);
    // Another transaction holds the RFQ's quote lock, as a concurrent insert would.
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["rfq:quotes:" + rfqId]);
      const waiting = store.addQuote(quoteInput(rfqId, address(1), 1), 20);
      let settled = false;
      void waiting.then(() => (settled = true), () => (settled = true));
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(settled, false, "the insert must be waiting for the lock");
      // Time passes while it waits: the RFQ (open until NOW + 30) closes.
      now = NOW + 31;
      await holder.query("COMMIT");
      assert.equal(await waiting, "CLOSED");
    } finally {
      holder.release();
    }
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM rfq.quotes")).rows[0].n, 0);
  });
});
