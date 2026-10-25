import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chainIndexHealth,
  createChainIndexer,
  rebuildChainProjection,
  startChainIndexer,
} from "../packages/application/src/chain-indexer.ts";
import { postgresProtocolIndexStore } from "../packages/adapters/src/protocol-index-store.ts";
import { foldProtocolEvents } from "../packages/domain/src/protocol-reducer.ts";
import {
  FakeChain,
  MAKER,
  TAKER,
  MARKET_ADDRESS,
  makerDeposited,
  marketCreated,
  quoteFilled,
  quoteCancelled,
  type FakeReaderOptions,
} from "./helpers/fake-chain.ts";
import { createTestDatabase } from "./helpers/database.ts";
import { seedProtocolDeployment } from "./helpers/protocol-index.ts";
export async function setup(
  options: {
    reader?: FakeReaderOptions;
    rangeSize?: number;
    leaseMs?: number;
  } = {},
) {
  const t = await createTestDatabase();
  await seedProtocolDeployment(t.pool, "d1");
  await t.setRole("blink_indexer");
  const chain = new FakeChain(9n);
  chain.mine([
    marketCreated(1),
    { name: "MarketOpened", args: { marketId: "1", openAt: "1020" } },
    makerDeposited(100000000n),
  ]);
  chain.mine([quoteFilled(1)]);
  chain.mineTo(14n);
  const store = postgresProtocolIndexStore(t.pool),
    readerOptions: FakeReaderOptions = { ...options.reader };
  const indexerFor = (workerId = "w1") =>
    createChainIndexer({
      store,
      reader: chain.reader(readerOptions),
      deploymentId: "d1",
      marketAddress: MARKET_ADDRESS,
      deploymentBlock: 10n,
      workerId,
      rangeSize: options.rangeSize ?? 500,
      leaseMs: options.leaseMs ?? 30000,
    });
  const indexer = indexerFor();
  return {
    t,
    chain,
    store,
    indexer,
    indexerFor,
    readerOptions,
    close: t.close,
    cursor: () => store.loadCursor("d1"),
  };
}
test("initial sync and overlapping duplicate logs count once", async () => {
  const s = await setup({
    reader: { duplicateLogs: true, overlappingLogs: true },
  });
  try {
    assert.equal((await s.indexer.syncOnce()).advancedTo, 14n);
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldProtocolEvents(s.chain.allEvents()),
    );
    s.chain.mine();
    await s.indexer.syncOnce();
    assert.equal(
      (await s.store.loadProjection("d1")).makers.get(MAKER)?.freeMicros,
      "96000000",
    );
    assert.equal((await s.store.loadCanonicalEvents("d1")).length, 4);
  } finally {
    await s.close();
  }
});
test("range size bounds progress and empty ranges advance", async () => {
  const s = await setup({ rangeSize: 2 });
  try {
    assert.equal((await s.indexer.syncOnce()).advancedTo, 11n);
    assert.equal((await s.indexer.syncOnce()).advancedTo, 13n);
    assert.equal((await s.indexer.syncOnce()).advancedTo, 14n);
    assert.equal((await s.indexer.health()).ready, true);
  } finally {
    await s.close();
  }
});
test("lease contention, token fencing and version fencing", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    assert.equal(await s.store.claimLease("d1", "w2", 10000), null);
    assert.equal((await s.indexerFor("w2").syncOnce()).advancedTo, null);
    const old = (await s.store.claimLease("d1", "w1", 10000))!,
      fresh = (await s.store.claimLease("d1", "w1", 10000))!,
      cursor = (await s.cursor())!;
    await assert.rejects(
      s.store.setGate(old, cursor.version, null),
      /CHAIN_LEASE_LOST/,
    );
    await s.store.setGate(fresh, cursor.version, null);
    await assert.rejects(
      s.store.setGate(fresh, cursor.version, null),
      /CHAIN_VERSION_CONFLICT/,
    );
    await s.store.releaseLease(old);
    assert.equal(await s.store.claimLease("d1", "w2", 10000), null);
    await s.store.releaseLease(fresh);
    assert.ok(await s.store.claimLease("d1", "w2", 10000));
  } finally {
    await s.close();
  }
});
test("a provider behind our cursor cannot cause a rollback", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    const before = await s.cursor();
    s.readerOptions.headOverride = 10n;
    await s.indexer.syncOnce();
    assert.deepEqual(await s.cursor(), before);
  } finally {
    await s.close();
  }
});
test("reorg tombstones events and restores all projection families", async () => {
  const s = await setup();
  try {
    s.chain.mine([
      {
        contract: "REGISTRY",
        name: "Registered",
        args: { account: MAKER, feePaid: "1" },
      },
      {
        contract: "REGISTRY",
        name: "RoleJoined",
        args: { account: MAKER, role: "1", amount: "100000000" },
      },
      {
        contract: "REGISTRY",
        name: "CreditGained",
        args: { account: MAKER, role: "1", amount: "8", credit: "8" },
      },
    ]);
    await s.indexer.syncOnce();
    const before = await s.store.loadProjection("d1");
    s.chain.mine([
      {
        contract: "REGISTRY",
        name: "Registered",
        args: { account: TAKER, feePaid: "1" },
      },
      {
        contract: "REGISTRY",
        name: "RoleJoined",
        args: { account: TAKER, role: "2", amount: "100000000" },
      },
      {
        contract: "REGISTRY",
        name: "CreditGained",
        args: { account: TAKER, role: "2", amount: "5", credit: "5" },
      },
      {
        name: "TemplateRegistered",
        args: {
          templateId: "0x" + "9".repeat(64),
          cls: "0",
          parserHash: "0x" + "8".repeat(64),
          uri: "ipfs://t",
        },
      },
      marketCreated(2),
      quoteFilled(2),
      { name: "MarketProposed", args: { marketId: "1" } },
      { name: "MarketFinalized", args: { marketId: "1", outcome: "0" } },
      {
        name: "FeesDistributed",
        args: { marketId: "1", amount: "0", keeper: TAKER, keeperTip: "0" },
      },
      {
        name: "PositionRedeemed",
        args: {
          marketId: "1",
          account: TAKER,
          yes: "20",
          no: "0",
          payout: "20000000",
        },
      },
      {
        name: "PositionRedeemed",
        args: {
          marketId: "1",
          account: MAKER,
          yes: "0",
          no: "20",
          payout: "0",
        },
      },
      quoteCancelled(3),
      { name: "MakerEpochIncremented", args: { maker: MAKER, epoch: "1" } },
      {
        contract: "ANCHOR",
        name: "Anchored",
        args: { root: "0x" + "7".repeat(64), by: TAKER, at: "1030" },
      },
      {
        contract: "GOVERNOR",
        name: "SuccessorAdopted",
        args: { registry: TAKER, effectiveAt: "2000" },
      },
    ]);
    await s.indexer.syncOnce();
    s.chain.rewind(15n);
    s.chain.mine();
    const reorg = await s.indexer.syncOnce();
    assert.equal(reorg.reorgedTo, 15n);
    assert.equal((await s.cursor())?.gateReason, "REORG_IN_PROGRESS");
    assert.deepEqual(await s.store.loadProjection("d1"), before);
    assert.equal(
      (
        await s.t.pool.query(
          "SELECT count(*)::int AS n FROM protocol.events WHERE NOT canonical",
        )
      ).rows[0].n,
      15,
    );
    await s.indexer.syncOnce();
    assert.equal((await s.cursor())?.gateReason, null);
    const counts = await s.t.pool.query(
      "SELECT (SELECT count(*)::int FROM protocol.account_roles) AS roles,(SELECT count(*)::int FROM protocol.credit) AS credit",
    );
    assert.deepEqual(counts.rows[0], { roles: 7, credit: 7 });
  } finally {
    await s.close();
  }
});
test("a previously orphaned branch revives its event rows", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    const branch = s.chain.snapshot();
    s.chain.rewind(10n);
    s.chain.mineTo(14n);
    await s.indexer.syncOnce();
    await s.indexer.syncOnce();
    s.chain.restore(branch);
    await s.indexer.syncOnce();
    await s.indexer.syncOnce();
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldProtocolEvents(s.chain.allEvents()),
    );
    assert.equal(
      (
        await s.t.pool.query(
          "SELECT count(*)::int AS n FROM protocol.events WHERE canonical",
        )
      ).rows[0].n,
      4,
    );
  } finally {
    await s.close();
  }
});
test("finalized conflicts stay gated", async () => {
  const s = await setup({ reader: { finalized: 12n } });
  try {
    await s.indexer.syncOnce();
    s.chain.rewind(10n);
    s.chain.mineTo(14n);
    assert.equal((await s.indexer.syncOnce()).gateReason, "FINALIZED_CONFLICT");
    assert.equal((await s.indexer.syncOnce()).gateReason, "FINALIZED_CONFLICT");
  } finally {
    await s.close();
  }
});
test("mid-range branch changes leave cursor and journal untouched", async () => {
  const s = await setup();
  try {
    s.readerOptions.afterLogs = () => {
      s.chain.rewind(9n);
      s.chain.mineTo(14n);
    };
    assert.equal((await s.indexer.syncOnce()).advancedTo, null);
    assert.equal((await s.cursor())?.blockNumber, 9n);
    assert.equal((await s.store.loadCanonicalEvents("d1")).length, 0);
  } finally {
    await s.close();
  }
});
test("projection drift refolds the journal and repairs every changed row", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    await s.t.pool.query(
      "UPDATE protocol.makers SET data=jsonb_set(data,'{freeMicros}', '\"7\"')",
    );
    await s.t.pool.query("DELETE FROM protocol.positions");
    s.chain.mine();
    assert.equal((await s.indexer.syncOnce()).gateReason, null);
    assert.deepEqual(
      await s.store.loadProjection("d1"),
      foldProtocolEvents(s.chain.allEvents()),
    );
  } finally {
    await s.close();
  }
});
test("contradictory events, missing logs and mismatching views fail closed", async () => {
  for (const mode of ["event", "logs", "views"]) {
    const s = await setup();
    try {
      await s.indexer.syncOnce();
      s.chain.mine(mode === "event" ? [quoteFilled(1)] : [quoteFilled(2)]);
      if (mode === "logs") s.readerOptions.omitLogs = true;
      if (mode === "views") s.readerOptions.agrees = () => false;
      assert.equal(
        (await s.indexer.syncOnce()).gateReason,
        "PROJECTION_MISMATCH",
      );
      assert.equal((await s.cursor())?.blockNumber, 14n);
    } finally {
      await s.close();
    }
  }
});
test("idle polls keep a mismatch gate; a verified advancing range clears it", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    await s.t.pool.query(
      "UPDATE chain.cursors SET gate_reason='PROJECTION_MISMATCH'",
    );
    const cursor = await s.cursor();
    await s.indexer.syncOnce();
    assert.deepEqual(await s.cursor(), cursor);
    s.chain.mine();
    assert.equal((await s.indexer.syncOnce()).gateReason, null);
  } finally {
    await s.close();
  }
});
test("rebuild verifies, fences and repairs missing rows", async () => {
  const s = await setup();
  try {
    await s.indexer.syncOnce();
    await s.t.pool.query("DELETE FROM protocol.positions");
    const check = await rebuildChainProjection(s.store, "d1", {
      verify: true,
      workerId: "v",
    });
    assert.equal(check.rewritten, false);
    assert.equal(check.differences.length, 2);
    await assert.rejects(
      rebuildChainProjection(s.store, "d1", { verify: false, workerId: "v" }),
      /CHAIN_INDEX_LEASE_HELD/,
    );
    const lease = (await s.store.claimLease("d1", "w1", 1000))!;
    await s.store.releaseLease(lease);
    assert.equal(
      (
        await rebuildChainProjection(s.store, "d1", {
          verify: false,
          workerId: "v",
        })
      ).rewritten,
      true,
    );
    assert.deepEqual(
      (
        await rebuildChainProjection(s.store, "d1", {
          verify: true,
          workerId: "v",
        })
      ).differences,
      [],
    );
  } finally {
    await s.close();
  }
});
test("mainnet and other chains are refused before writes", async () => {
  for (const chainId of [8453, 1]) {
    const s = await setup({ reader: { chainId } });
    try {
      await assert.rejects(
        s.indexer.syncOnce(),
        chainId === 8453 ? /MAINNET_REFUSED/ : /CHAIN_ID_MISMATCH/,
      );
      assert.equal(await s.cursor(), null);
    } finally {
      await s.close();
    }
  }
});
test("stopped loop and aborted sync do not advance", async () => {
  const s = await setup();
  try {
    const c = new AbortController();
    c.abort();
    await assert.rejects(s.indexer.syncOnce(c.signal));
    const loop = startChainIndexer({
      indexer: s.indexer,
      pollIntervalMs: 10,
      signal: c.signal,
    });
    await loop.stop();
    assert.equal(await s.cursor(), null);
  } finally {
    await s.close();
  }
});
test("index health refuses missing and stale cursors", () => {
  assert.equal(chainIndexHealth("d", null, new Date()).ready, false);
});

test("index health uses 30-second timestamp lag, stopped-index and gate boundaries", () => {
  const now = new Date();
  const cursor = {
    deploymentId: "d1",
    blockNumber: 10n,
    blockHash: "0x11",
    blockTimestamp: 1000n,
    headNumber: 11n,
    headTimestamp: 1030n,
    finalizedNumber: null,
    syncedAt: now,
    gateReason: null,
    version: 0n,
  };
  assert.equal(chainIndexHealth("d1", cursor, now).ready, true);
  assert.equal(
    chainIndexHealth("d1", { ...cursor, headTimestamp: 1031n }, now).ready,
    false,
  );
  assert.equal(
    chainIndexHealth(
      "d1",
      { ...cursor, syncedAt: new Date(now.getTime() - 31_000) },
      now,
    ).ready,
    false,
  );
  assert.equal(
    chainIndexHealth("d1", { ...cursor, gateReason: "REORG_IN_PROGRESS" }, now)
      .ready,
    false,
  );
});
