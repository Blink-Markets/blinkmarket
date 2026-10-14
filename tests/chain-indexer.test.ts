import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  createChainIndexer,
  chainIndexHealth,
  rebuildChainProjection,
  startChainIndexer,
} from "../packages/application/src/chain-indexer.js";
import { postgresChainIndexStore } from "../packages/adapters/src/chain-index-store.js";
import {
  emptyProjection,
  foldEvents,
} from "../packages/domain/src/chain-reducer.ts";
import type { ChainViews, IndexCursor } from "../packages/ports/src/index.js";
import { createTestDatabase } from "./helpers/database.js";
import {
  FakeChain,
  MAKER,
  MARKET_ADDRESS,
  TAKER,
  TAKER2,
  hashOf,
  makerDeposited,
  marketCreated,
  quoteCancelled,
  quoteFilled,
  takerAllowed,
  type FakeReaderOptions,
} from "./helpers/fake-chain.js";

const DEPLOYMENT_BLOCK = 10n;
const DEPOSIT = 100_000_000n;

// Blocks 12..14 set the market up; a fill lands at 19 and the head is 20.
function world() {
  const chain = new FakeChain(11n);
  chain.mine([marketCreated(1)]);
  chain.mine([makerDeposited(DEPOSIT)]);
  chain.mine([takerAllowed(TAKER)]);
  chain.mineTo(18n);
  chain.mine([quoteFilled(1, { side: 0, quantity: 10n, priceBps: 6000 })]);
  chain.mine();
  return chain;
}

async function setup(
  options: {
    chain?: FakeChain;
    reader?: FakeReaderOptions;
    rangeSize?: number;
    workerId?: string;
    leaseMs?: number;
  } = {},
) {
  const t = await createTestDatabase();
  await t.db.exec(
    `INSERT INTO markets.deployments(id,manifest,market_address)
     VALUES ('d1','{"deploymentBlock":"${DEPLOYMENT_BLOCK}"}',decode('${MARKET_ADDRESS.slice(2)}','hex'))`,
  );
  await t.setRole("blink_indexer");
  const chain = options.chain ?? world();
  const store = postgresChainIndexStore(t.pool);
  const readerOptions: FakeReaderOptions = { ...options.reader };
  const indexerFor = (workerId: string, leaseMs = options.leaseMs) =>
    createChainIndexer({
      store,
      reader: chain.reader(readerOptions),
      deploymentId: "d1",
      marketAddress: MARKET_ADDRESS,
      deploymentBlock: DEPLOYMENT_BLOCK,
      workerId,
      ...(options.rangeSize ? { rangeSize: options.rangeSize } : {}),
      ...(leaseMs ? { leaseMs } : {}),
    });
  const query = async <R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => (await t.db.query<R>(sql, params)).rows;
  return {
    t,
    chain,
    store,
    readerOptions,
    indexer: indexerFor(options.workerId ?? "w1"),
    indexerFor,
    query,
    cursor: async () => (await store.loadCursor("d1"))!,
    outbox: (type: string) =>
      query<{
        aggregate_id: string;
        event_version: string;
        payload: Record<string, string>;
      }>(
        "SELECT aggregate_id, event_version::text AS event_version, payload FROM operations.outbox WHERE event_type=$1 ORDER BY event_version::numeric",
        [type],
      ),
    events: () =>
      query<{ block_number: string; name: string; canonical: boolean }>(
        "SELECT e.block_number::text AS block_number, e.name, e.canonical FROM chain.events e ORDER BY e.block_number, e.tx_index, e.log_index, e.canonical",
      ),
    blocks: () =>
      query<{ number: string; canonical: boolean }>(
        "SELECT b.number::text AS number, b.canonical FROM chain.blocks b ORDER BY b.number, b.canonical",
      ),
    close: () => t.close(),
  };
}

const maker = (rows: Record<string, unknown>[]) =>
  rows[0] as { free: string; epoch: string; paused: boolean };

test("the first sync starts at the deployment block and folds everything to the head", async () => {
  const s = await setup();
  try {
    const result = await s.indexer.syncOnce();
    assert.deepEqual(result, {
      advancedTo: 20n,
      reorgedTo: null,
      gateReason: null,
    });
    const cursor = await s.cursor();
    assert.equal(cursor.blockNumber, 20n);
    assert.equal(cursor.blockHash, s.chain.at(20n)!.hash);
    assert.equal(cursor.headNumber, 20n);
    assert.equal(cursor.gateReason, null);
    assert.equal(cursor.version, 1n);
    // The baseline block, every block with events and the range end are stored.
    assert.deepEqual(
      (await s.blocks()).map((b) => b.number),
      ["9", "12", "13", "14", "19", "20"],
    );
    assert.deepEqual(
      (await s.events()).map((e) => `${e.block_number}:${e.name}`),
      [
        "12:MarketCreated",
        "13:MakerDeposited",
        "14:TakerAllowedChanged",
        "19:QuoteFilled",
      ],
    );
    const projection = await s.store.loadProjection("d1");
    assert.deepEqual(projection, foldEvents(s.chain.allEvents()));
    assert.equal(projection.maker.freeMicros, DEPOSIT - 4_000_000n);
    assert.equal(projection.positions.get("1:" + TAKER)!.yesShares, 10n);
    assert.equal(projection.positions.get("1:" + MAKER)!.noShares, 10n);
    assert.equal(projection.markets.get("1")!.escrowMicros, 10_000_000n);
    const asOf = await s.query<{ ok: boolean }>(
      "SELECT bool_and(as_of_block_hash=decode($1,'hex')) AS ok FROM chain.markets",
      [s.chain.at(20n)!.hash.slice(2)],
    );
    assert.equal(
      asOf[0]!.ok,
      true,
      "rows written by a sync carry the block they were written at",
    );
    // Outbox: one chain.synced at the new version and one market.indexed.
    assert.deepEqual(
      (await s.outbox("chain.synced")).map((o) => [
        o.aggregate_id,
        o.event_version,
        o.payload,
      ]),
      [
        [
          "d1",
          "1",
          {
            deploymentId: "d1",
            blockNumber: "20",
            blockHash: s.chain.at(20n)!.hash,
          },
        ],
      ],
    );
    const indexed = await s.outbox("market.indexed");
    assert.deepEqual(
      indexed.map((o) => [o.aggregate_id, o.event_version]),
      [["d1:1", "1"]],
    );
    assert.equal(indexed[0]!.payload.specHash, hashOf(0x701));
    assert.equal(indexed[0]!.payload.blockNumber, "12");
    const health = await s.indexer.health();
    assert.equal(health.ready, true);
    assert.equal(health.lagBlocks, "0");
  } finally {
    await s.close();
  }
});

test("a long catch-up is read in ranges and ends at the head", async () => {
  const s = await setup({ rangeSize: 5 });
  try {
    const reached = [];
    for (;;) {
      const { advancedTo } = await s.indexer.syncOnce();
      if (advancedTo === null) break;
      reached.push(advancedTo);
    }
    assert.deepEqual(reached, [14n, 19n, 20n]);
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldEvents(s.chain.allEvents()),
    );
    // Each range commit is one version and one chain.synced.
    assert.deepEqual(
      (await s.outbox("chain.synced")).map((o) => o.event_version),
      ["1", "2", "3"],
    );
    assert.equal(
      (await s.cursor()).version,
      4n,
      "the idle poll after the head still refreshes the cursor",
    );
  } finally {
    await s.close();
  }
});

test("running again at the head changes no projection and refreshes synced_at without an outbox event", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    const first = await s.cursor();
    const before = await s.store.loadProjection("d1");
    await delay(15);
    s.chain.mine();
    const again = await s.indexer.syncOnce();
    assert.deepEqual(again, {
      advancedTo: 21n,
      reorgedTo: null,
      gateReason: null,
    });
    await delay(15);
    const idle = await s.indexer.syncOnce();
    assert.deepEqual(idle, {
      advancedTo: null,
      reorgedTo: null,
      gateReason: null,
    });
    const last = await s.cursor();
    assert.equal(last.blockNumber, 21n);
    assert.equal(last.headNumber, 21n);
    assert.ok(last.syncedAt > first.syncedAt, "synced_at moves forward");
    assert.equal(last.version, first.version + 2n);
    assert.deepEqual(await s.store.loadProjection("d1"), before);
    assert.equal((await s.events()).length, 4);
    assert.equal(
      (await s.outbox("chain.synced")).length,
      2,
      "an idle poll publishes no chain.synced",
    );
  } finally {
    await s.close();
  }
});

test("duplicate and overlapping log delivery never counts a fill twice (S08)", async () => {
  const s = await setup({
    reader: { duplicateLogs: true, overlappingLogs: true },
  });
  try {
    await s.indexer.syncOnce();
    s.chain.mine([
      quoteFilled(2, { side: 1, quantity: 5n, priceBps: 4000, taker: TAKER2 }),
    ]);
    s.chain.mine();
    await s.indexer.syncOnce();
    const projection = await s.store.loadProjection("d1");
    assert.deepEqual(projection, foldEvents(s.chain.allEvents()));
    assert.equal(projection.positions.get("1:" + TAKER)!.yesShares, 10n);
    assert.equal(projection.positions.get("1:" + TAKER2)!.noShares, 5n);
    assert.equal(projection.markets.get("1")!.totalPairs, 15n);
    assert.equal((await s.events()).length, 5);
    assert.equal((await s.store.loadCanonicalEvents("d1")).length, 5);
  } finally {
    await s.close();
  }
});

test("a reorg at depth 2 keeps tombstones, rebuilds the projections, publishes chain.reorged and clears after resync", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    const old = s.chain.at(19n)!;
    // The branch replaces blocks 19 and 20: the old fill is gone and a different fill lands.
    s.chain.rewind(18n);
    s.chain.mine([quoteFilled(9, { side: 1, quantity: 4n, priceBps: 3000 })]);
    s.chain.mine();
    s.chain.mine();

    const rolledBack = await s.indexer.syncOnce();
    // Stored canonical blocks are 9, 12, 13, 14, 19, 20: the highest one still on chain is 14.
    assert.deepEqual(rolledBack, {
      advancedTo: null,
      reorgedTo: 14n,
      gateReason: "REORG_IN_PROGRESS",
    });
    let cursor = await s.cursor();
    assert.equal(cursor.blockNumber, 14n);
    assert.equal(cursor.gateReason, "REORG_IN_PROGRESS");
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldEvents(s.chain.allEvents(14n)),
    );
    assert.deepEqual(
      (await s.events()).map(
        (e) => `${e.block_number}:${e.name}:${e.canonical}`,
      ),
      [
        "12:MarketCreated:true",
        "13:MakerDeposited:true",
        "14:TakerAllowedChanged:true",
        "19:QuoteFilled:false",
      ],
      "the orphaned event stays as a tombstone",
    );
    assert.deepEqual(
      (await s.blocks()).map((b) => `${b.number}:${b.canonical}`),
      ["9:true", "12:true", "13:true", "14:true", "19:false", "20:false"],
    );
    const reorged = await s.outbox("chain.reorged");
    assert.equal(reorged.length, 1);
    assert.deepEqual(reorged[0]!.payload, {
      deploymentId: "d1",
      ancestorNumber: "14",
      ancestorHash: s.chain.at(14n)!.hash,
      orphanedFrom: "15",
    });
    assert.equal((await s.indexer.health()).ready, false);

    const resynced = await s.indexer.syncOnce();
    assert.deepEqual(resynced, {
      advancedTo: 21n,
      reorgedTo: null,
      gateReason: null,
    });
    cursor = await s.cursor();
    assert.equal(cursor.blockNumber, 21n);
    assert.equal(cursor.blockHash, s.chain.at(21n)!.hash);
    assert.equal(cursor.gateReason, null);
    const projection = await s.store.loadProjection("d1");
    assert.deepEqual(projection, foldEvents(s.chain.allEvents()));
    assert.equal(projection.positions.get("1:" + TAKER)!.noShares, 4n);
    assert.equal(
      projection.positions.get("1:" + TAKER)!.yesShares,
      0n,
      "positions follow the new branch only",
    );
    assert.equal(
      projection.digests.has(old.events[0]!.args.digest as string),
      false,
    );
    assert.equal(projection.digests.size, 1);
    assert.deepEqual(
      (await s.events()).map((e) => `${e.block_number}:${e.canonical}`),
      ["12:true", "13:true", "14:true", "19:false", "19:true"],
    );
    assert.equal((await s.indexer.health()).ready, true);
  } finally {
    await s.close();
  }
});

test("a branch that returns to the canonical chain revives its tombstoned blocks and events", async () => {
  const s = await setup();
  try {
    const branchA = s.chain.snapshot();
    await s.indexer.syncOnce();
    s.chain.rewind(18n);
    s.chain.mine([quoteFilled(9, { side: 1, quantity: 4n, priceBps: 3000 })]);
    s.chain.mine();
    await s.indexer.syncOnce(); // roll back to 14
    await s.indexer.syncOnce(); // index branch B
    assert.deepEqual(
      (await s.events())
        .map((e) => `${e.block_number}:${e.canonical}`)
        .slice(3),
      ["19:false", "19:true"],
    );
    s.chain.restore(branchA);
    assert.equal((await s.indexer.syncOnce()).reorgedTo, 14n);
    assert.equal((await s.indexer.syncOnce()).advancedTo, 20n);
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldEvents(s.chain.allEvents()),
    );
    assert.deepEqual(
      (
        await s.query<{ number: string; hash: string; canonical: boolean }>(
          "SELECT b.number::text AS number, encode(b.hash,'hex') AS hash, b.canonical FROM chain.blocks b WHERE b.number >= 19 ORDER BY b.number, b.canonical",
        )
      ).map(
        (b) =>
          `${b.number}:${b.canonical}:${b.hash === s.chain.at(BigInt(b.number))!.hash.slice(2)}`,
      ),
      ["19:false:false", "19:true:true", "20:false:false", "20:true:true"],
      "branch A is canonical again; branch B stays as tombstones",
    );
    assert.equal((await s.events()).filter((e) => e.canonical).length, 4);
  } finally {
    await s.close();
  }
});

test("a header that changes while the range is read aborts without writing", async () => {
  // Logs came from a branch that is no longer the header at their height.
  const forked = await setup();
  try {
    await forked.indexer.syncOnce();
    forked.chain.mine([quoteFilled(2, { quantity: 1n })]);
    forked.chain.mine();
    const before = await forked.cursor();
    forked.readerOptions.afterLogs = () => {
      forked.chain.rewind(20n);
      forked.chain.mine();
      forked.chain.mine();
    };
    const result = await forked.indexer.syncOnce();
    assert.equal(result.advancedTo, null);
    assert.deepEqual(await forked.cursor(), before);
    assert.equal((await forked.events()).length, 4);
  } finally {
    await forked.close();
  }

  // The range end changes after the headers were fetched: the re-read catches it.
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    s.chain.mine([quoteFilled(2, { quantity: 1n })]);
    s.chain.mine();
    const before = await s.cursor();
    const reader = s.readerOptions;
    let calls = 0;
    reader.afterBlockCall = () => {
      calls += 1;
      // Calls: cursor check, headers for the event block and the range end, then the two re-reads.
      if (calls === 3) {
        s.chain.rewind(21n);
        s.chain.mine();
      }
    };
    const result = await s.indexer.syncOnce();
    assert.deepEqual(result, {
      advancedTo: null,
      reorgedTo: null,
      gateReason: null,
    });
    assert.deepEqual(await s.cursor(), before, "nothing was committed");
    assert.equal((await s.events()).length, 4);
    delete reader.afterBlockCall;
    assert.equal((await s.indexer.syncOnce()).advancedTo, 22n);
  } finally {
    await s.close();
  }
});

test("a stale lease token cannot commit, and a live lease keeps other workers out", async () => {
  const s = await setup();
  try {
    const rival = s.indexerFor("w2");
    await s.indexer.syncOnce();
    const held = await s.cursor();
    // w1 holds an unexpired lease: w2 changes nothing even though the chain moved on.
    s.chain.mine([quoteFilled(2, { quantity: 1n })]);
    s.chain.mine();
    assert.deepEqual(await rival.syncOnce(), {
      advancedTo: null,
      reorgedTo: null,
      gateReason: null,
    });
    assert.deepEqual(await s.cursor(), held);

    // w1 stalls inside a sync after its lease expired and w2 took over: its commit must fail.
    s.readerOptions.afterLogs = async () => {
      delete s.readerOptions.afterLogs;
      await s.query(
        "UPDATE chain.cursors SET lease_until = blink.now() - interval '1 second'",
      );
      assert.equal(
        (await rival.syncOnce()).advancedTo,
        22n,
        "w2 claims the expired lease and indexes the range",
      );
    };
    await assert.rejects(s.indexer.syncOnce(), /CHAIN_LEASE_LOST/);
    const after = await s.cursor();
    assert.equal(after.blockNumber, 22n);
    assert.equal(
      await s
        .query("SELECT 1 FROM chain.cursors WHERE lease_owner='w2'")
        .then((r) => r.length),
      1,
    );
    assert.equal(
      (await s.events()).filter((e) => e.name === "QuoteFilled").length,
      2,
      "applied once, by w2",
    );
  } finally {
    await s.close();
  }
});

test("a newer claim by the same worker fences the older claim's commits", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    const { version, headNumber } = await s.cursor();
    const older = (await s.store.claimLease("d1", "w1", 30_000))!;
    const newer = (await s.store.claimLease("d1", "w1", 30_000))!;
    assert.ok(newer.token > older.token);
    const refresh = { headNumber, finalizedNumber: null, gateReason: null };
    await assert.rejects(
      s.store.refreshCursor(older, version, refresh),
      /CHAIN_LEASE_LOST/,
    );
    await assert.rejects(
      s.store.setGate(older, version, "PROJECTION_MISMATCH"),
      /CHAIN_LEASE_LOST/,
    );
    assert.equal(
      await s.store.refreshCursor(newer, version, refresh),
      version + 1n,
    );
    await assert.rejects(
      s.store.refreshCursor(newer, version, refresh),
      /CHAIN_VERSION_CONFLICT/,
      "the version fence stops a second commit from the same snapshot",
    );
  } finally {
    await s.close();
  }
});

test("a provider behind the cursor is lagging, not reorganized", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    const before = await s.cursor();
    s.readerOptions.headOverride = 15n;
    const result = await s.indexer.syncOnce();
    assert.deepEqual(result, {
      advancedTo: null,
      reorgedTo: null,
      gateReason: null,
    });
    assert.deepEqual(
      await s.cursor(),
      before,
      "no version, head or synced_at change",
    );
    assert.equal((await s.outbox("chain.reorged")).length, 0);
  } finally {
    await s.close();
  }
});

test("a reorg below the finalized block stops at FINALIZED_CONFLICT and never advances again", async () => {
  const s = await setup({ reader: { finalized: 16n } });
  try {
    await s.indexer.syncOnce();
    assert.equal((await s.cursor()).finalizedNumber, 16n);
    s.chain.rewind(18n);
    s.chain.mine([quoteFilled(9, { side: 1, quantity: 4n, priceBps: 3000 })]);
    s.chain.mine();
    const result = await s.indexer.syncOnce();
    assert.deepEqual(result, {
      advancedTo: null,
      reorgedTo: null,
      gateReason: "FINALIZED_CONFLICT",
    });
    let cursor = await s.cursor();
    assert.equal(cursor.gateReason, "FINALIZED_CONFLICT");
    assert.equal(
      cursor.blockNumber,
      20n,
      "the stale cursor is kept for the operator",
    );
    assert.equal(
      (await s.events()).every((e) => e.canonical),
      true,
      "nothing was tombstoned",
    );
    assert.equal((await s.outbox("chain.reorged")).length, 0);
    // Even a healthy-looking chain does not move it.
    s.chain.mine();
    s.chain.mine();
    const stuck = await s.indexer.syncOnce();
    assert.deepEqual(stuck, {
      advancedTo: null,
      reorgedTo: null,
      gateReason: "FINALIZED_CONFLICT",
    });
    cursor = await s.cursor();
    assert.equal(cursor.blockNumber, 20n);
    assert.equal((await s.indexer.health()).ready, false);
  } finally {
    await s.close();
  }
});

test("a views mismatch gates the indexer at PROJECTION_MISMATCH and stops it advancing", async () => {
  const s = await setup();
  try {
    const wrong = (v: ChainViews): ChainViews => ({
      ...v,
      markets: new Map(
        [...v.markets].map(([id, m]) => [
          id,
          { ...m, escrowMicros: m.escrowMicros + 1n },
        ]),
      ),
    });
    s.readerOptions.views = wrong;
    const result = await s.indexer.syncOnce();
    assert.deepEqual(result, {
      advancedTo: null,
      reorgedTo: null,
      gateReason: "PROJECTION_MISMATCH",
    });
    let cursor = await s.cursor();
    assert.equal(cursor.gateReason, "PROJECTION_MISMATCH");
    assert.equal(cursor.blockNumber, 9n, "the cursor stays at the baseline");
    assert.equal(
      (await s.events()).length,
      0,
      "no event of the bad range was stored",
    );
    assert.deepEqual(await s.store.loadProjection("d1"), emptyProjection());
    const versionAfterGate = cursor.version;
    assert.equal(
      (await s.indexer.syncOnce()).gateReason,
      "PROJECTION_MISMATCH",
    );
    assert.equal(
      (await s.cursor()).version,
      versionAfterGate,
      "a repeated mismatch does not rewrite the gate",
    );
    assert.equal((await s.indexer.health()).ready, false);

    delete s.readerOptions.views;
    const recovered = await s.indexer.syncOnce();
    assert.deepEqual(recovered, {
      advancedTo: 20n,
      reorgedTo: null,
      gateReason: null,
    });
    cursor = await s.cursor();
    assert.equal(cursor.gateReason, null);
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldEvents(s.chain.allEvents()),
    );
  } finally {
    await s.close();
  }
});

test("a drifted stored projection is rebuilt from the canonical events when the contract reads disagree", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    await s.query(
      "UPDATE chain.maker_state SET free_balance_micros = 999999999999",
    );
    await s.query(
      "DELETE FROM chain.positions WHERE account = decode($1,'hex')",
      [MAKER.slice(2)],
    );
    s.chain.mine([
      quoteFilled(2, { side: 1, quantity: 5n, priceBps: 4000, taker: TAKER2 }),
    ]);
    s.chain.mine();
    const result = await s.indexer.syncOnce();
    assert.deepEqual(result, {
      advancedTo: 22n,
      reorgedTo: null,
      gateReason: null,
    });
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldEvents(s.chain.allEvents()),
    );
    assert.equal((await s.cursor()).gateReason, null);
  } finally {
    await s.close();
  }
});

test("events that contradict the projection gate the indexer instead of crashing it", async () => {
  const chain = new FakeChain(11n);
  chain.mine([marketCreated(1)]);
  chain.mine([quoteFilled(1)]); // a fill without a maker deposit cannot be paid
  chain.mine();
  const s = await setup({ chain });
  try {
    const result = await s.indexer.syncOnce();
    assert.deepEqual(result, {
      advancedTo: null,
      reorgedTo: null,
      gateReason: "PROJECTION_MISMATCH",
    });
    assert.equal((await s.cursor()).blockNumber, 9n);
    assert.equal((await s.events()).length, 0);
  } finally {
    await s.close();
  }
});

test("the first sync waits for a chain that has not reached the deployment block", async () => {
  const s = await setup({ chain: new FakeChain(5n) });
  try {
    assert.deepEqual(await s.indexer.syncOnce(), {
      advancedTo: null,
      reorgedTo: null,
      gateReason: null,
    });
    assert.equal(await s.store.loadCursor("d1"), null);
    s.chain.mineTo(10n);
    assert.equal((await s.indexer.syncOnce()).advancedTo, 10n);
  } finally {
    await s.close();
  }
});

test("quote cancellations and new markets flow through; each new market publishes market.indexed", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    s.chain.mine([quoteCancelled(5), marketCreated(2)]);
    s.chain.mine();
    await s.indexer.syncOnce();
    const projection = await s.store.loadProjection("d1");
    assert.equal(projection.digests.get(hashOf(0x905))!.state, "CANCELLED");
    assert.equal(projection.markets.size, 2);
    assert.deepEqual(
      (await s.outbox("market.indexed")).map((o) => o.aggregate_id),
      ["d1:1", "d1:2"],
    );
  } finally {
    await s.close();
  }
});

test("only Base Sepolia is accepted", async () => {
  const mainnet = await setup({ reader: { chainId: 8453 } });
  try {
    await assert.rejects(mainnet.indexer.syncOnce(), /MAINNET_REFUSED/);
    assert.equal(await mainnet.store.loadCursor("d1"), null);
  } finally {
    await mainnet.close();
  }
  const other = await setup({ reader: { chainId: 1 } });
  try {
    await assert.rejects(other.indexer.syncOnce(), /CHAIN_ID_MISMATCH/);
  } finally {
    await other.close();
  }
});

const cursorAt = (overrides: Partial<IndexCursor> = {}): IndexCursor => ({
  deploymentId: "d1",
  blockNumber: 100n,
  blockHash: hashOf(100),
  blockTimestamp: 1n,
  headNumber: 100n,
  finalizedNumber: null,
  syncedAt: new Date("2026-10-14T00:00:00.000Z"),
  gateReason: null,
  version: 1n,
  ...overrides,
});

test("health is ready only within 3 blocks, 10 seconds and with no gate", () => {
  const at = (ms: number) =>
    new Date(Date.parse("2026-10-14T00:00:00.000Z") + ms);
  const ready = (cursor: IndexCursor, ms: number) =>
    chainIndexHealth("d1", cursor, at(ms)).ready;
  assert.equal(ready(cursorAt(), 0), true);
  assert.equal(
    ready(cursorAt({ headNumber: 103n }), 10_000),
    true,
    "lag 3 and age 10,000 ms are still ready",
  );
  assert.equal(ready(cursorAt({ headNumber: 104n }), 0), false, "lag 4");
  assert.equal(ready(cursorAt(), 10_001), false, "age 10,001 ms");
  assert.equal(ready(cursorAt({ gateReason: "REORG_IN_PROGRESS" }), 0), false);
  assert.deepEqual(
    chainIndexHealth("d1", cursorAt({ headNumber: 102n }), at(2500)),
    {
      deploymentId: "d1",
      blockNumber: "100",
      headNumber: "102",
      lagBlocks: "2",
      syncedAt: "2026-10-14T00:00:00.000Z",
      ageMs: 2500,
      gateReason: null,
      ready: true,
    },
  );
  assert.equal(chainIndexHealth("d1", null, at(0)).ready, false);
});

test("a cursor that was only initialized is not ready until a sync commits", async () => {
  const s = await setup();
  try {
    await s.store.initializeCursor({
      deploymentId: "d1",
      baseline: s.chain.at(9n)!,
      headNumber: 9n,
      finalizedNumber: null,
    });
    assert.equal((await s.indexer.health()).ready, false);
    await s.indexer.syncOnce();
    assert.equal((await s.indexer.health()).ready, true);
  } finally {
    await s.close();
  }
});

test("the poll loop catches up without waiting, reports errors and stops cleanly", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const results = [
    { advancedTo: 5n, reorgedTo: null, gateReason: null },
    { advancedTo: 8n, reorgedTo: null, gateReason: null },
    null, // a failure
  ];
  let next = 0;
  const indexer = {
    async syncOnce(signal?: AbortSignal) {
      calls.push(signal?.aborted ? "aborted" : "run");
      const result = results[next++];
      if (!result) throw new Error("RPC_UNAVAILABLE");
      return result;
    },
    async health() {
      return chainIndexHealth(
        "d1",
        cursorAt(),
        new Date("2026-10-14T00:00:00.000Z"),
      );
    },
  };
  const loop = startChainIndexer({
    indexer,
    pollIntervalMs: 1_000_000,
    onError: (code) => errors.push(code),
  });
  // The first two calls progress, so they run back to back; after the failure the loop waits.
  const deadline = Date.now() + 2000;
  while (calls.length < 3 && Date.now() < deadline) await delay(5);
  assert.equal(calls.length, 3, "progress skips the poll delay");
  assert.deepEqual(errors, ["RPC_UNAVAILABLE"]);
  assert.equal((await loop.health()).ready, true);
  await loop.stop();
  assert.equal(calls.length, 3, "stopping interrupts the poll delay");
});

test("chain:rebuild compares and repairs the projections from the canonical events and releases its lease", async () => {
  const s = await setup();
  try {
    const rebuild = (verify: boolean) =>
      rebuildChainProjection(s.store, "d1", {
        verify,
        workerId: "rebuild-tool",
      });
    await assert.rejects(rebuild(true), /CHAIN_CURSOR_NOT_FOUND/);
    await s.indexer.syncOnce();
    assert.deepEqual(await rebuild(true), {
      deploymentId: "d1",
      eventCount: 4,
      differences: [],
      rewritten: false,
    });
    await assert.rejects(
      rebuild(false),
      /CHAIN_INDEX_LEASE_HELD/,
      "a running indexer keeps its lease",
    );

    // Drift: a wrong balance, a lost position and an extra digest.
    await s.query("UPDATE chain.maker_state SET free_balance_micros = 7");
    await s.query(
      "DELETE FROM chain.positions WHERE account = decode($1,'hex')",
      [MAKER.slice(2)],
    );
    await s.query(
      `INSERT INTO chain.quote_digests(deployment_id,digest,state,block_number,block_hash,tx_hash)
       VALUES ('d1',decode($1,'hex'),'CANCELLED',19,decode($2,'hex'),decode($2,'hex'))`,
      [hashOf(0x999).slice(2), hashOf(1).slice(2)],
    );
    await s.query(
      "UPDATE chain.cursors SET lease_until = blink.now() - interval '1 second'",
    );
    const found = await rebuild(true);
    assert.deepEqual(
      found.differences.sort(),
      ["digest:" + hashOf(0x999), "maker", "position:1:" + MAKER].sort(),
    );
    assert.equal(found.rewritten, false, "verify never writes");
    assert.equal((await s.store.loadProjection("d1")).maker.freeMicros, 7n);

    const fixed = await rebuild(false);
    assert.equal(fixed.rewritten, true);
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldEvents(s.chain.allEvents()),
    );
    assert.deepEqual((await rebuild(true)).differences, []);
    assert.equal(
      (await s.query("SELECT 1 FROM chain.cursors WHERE lease_owner IS NULL"))
        .length,
      1,
    );
    // The indexer carries on from the repaired state.
    s.chain.mine([quoteFilled(2, { quantity: 1n })]);
    assert.equal((await s.indexer.syncOnce()).advancedTo, 21n);
  } finally {
    await s.close();
  }
});
