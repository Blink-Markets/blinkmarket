import { seedProtocolDeployment } from "../helpers/protocol-index.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { postgresProtocolIndexStore } from "../../packages/adapters/src/protocol-index-store.js";
import {
  createChainIndexer,
  rebuildChainProjection,
} from "../../packages/application/src/chain-indexer.js";
import { foldProtocolEvents } from "../../packages/domain/src/protocol-reducer.ts";
import {
  FakeChain,
  MARKET_ADDRESS,
  TAKER,
  makerDeposited,
  marketCreated,
  quoteFilled,
} from "../helpers/fake-chain.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "TEST_POSTGRES_ADMIN_URL_REQUIRED: dedicated local/CI PostgreSQL with CREATEDB and CREATEROLE privileges",
  );

test(
  "real PostgreSQL: two indexers race for one deployment's lease and only the holder commits",
  { timeout: 60_000 },
  async () => {
    // Never migrate or truncate the supplied DB. Create and drop only our random test DB.
    const name = "blink_chain_" + randomUUID().replaceAll("-", "");
    assert.match(name, /^blink_chain_[a-f0-9]{32}$/);
    const control = new pg.Client({ connectionString: adminUrl });
    await control.connect();
    let created = false;
    const databaseUrl = new URL(adminUrl!);
    databaseUrl.pathname = "/" + name;
    // Any connection error while the test runs, or after it, is a failure of the test.
    const poolErrors: unknown[] = [];
    const teardownFailures: unknown[] = [];
    const pool = (role: string | null, max = 4) => {
      const made = new pg.Pool({
        connectionString: databaseUrl.toString(),
        ...(role ? { options: `-c role=${role}` } : {}),
        max,
      });
      made.on("error", (error) => poolErrors.push(error));
      return made;
    };
    const owner = pool(null, 2);
    const poolA = pool("blink_indexer");
    const poolB = pool("blink_indexer");
    try {
      await control.query(`CREATE DATABASE "${name}"`);
      created = true;
      const migrationClient = await owner.connect();
      try {
        await migrate(migrationClient);
      } finally {
        migrationClient.release();
      }
      await seedProtocolDeployment(owner, "d1");
      const chain = new FakeChain(11n);
      chain.mine([
        marketCreated(1),
        { name: "MarketOpened", args: { marketId: "1", openAt: "1024" } },
      ]);
      chain.mine([makerDeposited(100_000_000n)]);
      chain.mine();
      chain.mineTo(20n);
      const storeA = postgresProtocolIndexStore(poolA);
      const storeB = postgresProtocolIndexStore(poolB);
      const indexer = (store: typeof storeA, workerId: string) =>
        createChainIndexer({
          store,
          reader: chain.reader(),
          deploymentId: "d1",
          marketAddress: MARKET_ADDRESS,
          deploymentBlock: 10n,
          workerId,
          rangeSize: 6,
          leaseMs: 60_000,
        });
      const a = indexer(storeA, "indexer-a");
      const b = indexer(storeB, "indexer-b");
      const expireLease = () =>
        owner.query(
          "UPDATE chain.cursors SET lease_until = blink.now() - interval '1 second'",
        );

      // Rounds of two indexers syncing at once; the lease expires between rounds so either can win.
      let digest = 0;
      for (let round = 0; round < 6; round++) {
        if (round > 0) {
          chain.mine([quoteFilled(++digest, { quantity: 1n, priceBps: 5000 })]);
          chain.mineTo(chain.head + 3n);
          await expireLease();
        }
        let advanced = 0;
        for (;;) {
          const results = await Promise.all([a.syncOnce(), b.syncOnce()]);
          const progressed = results.filter((r) => r.advancedTo !== null);
          assert.ok(
            progressed.length <= 1,
            "only one indexer advances under one lease",
          );
          if (!progressed.length) break;
          advanced += 1;
        }
        assert.ok(advanced >= 1);
        const held = await owner.query<{ block_number: string }>(
          "SELECT block_number::text AS block_number FROM chain.cursors",
        );
        assert.equal(BigInt(held.rows[0]!.block_number), chain.head);
      }

      // Exactly the chain's events, once each, in one consistent projection.
      const snapshot = await storeA.loadSnapshot("d1");
      assert.equal(snapshot.events.length, chain.allEvents().length);
      assert.deepEqual(
        snapshot.projection,
        foldProtocolEvents(chain.allEvents()),
      );
      const versions = await owner.query<{ event_version: string }>(
        "SELECT event_version::text AS event_version FROM operations.outbox WHERE event_type='chain.synced' ORDER BY event_version::numeric",
      );
      assert.equal(
        new Set(versions.rows.map((r) => r.event_version)).size,
        versions.rows.length,
      );

      // A holder that lost its lease cannot commit, whatever version it remembers.
      await expireLease();
      const stale = await storeA.claimLease("d1", "indexer-a", 60_000);
      assert.ok(stale);
      await expireLease();
      const current = await storeB.claimLease("d1", "indexer-b", 60_000);
      assert.ok(current && current.token > stale.token);
      assert.equal(
        await storeA.claimLease("d1", "indexer-a", 60_000),
        null,
        "the new holder's lease is live",
      );
      const cursor = (await storeA.loadCursor("d1"))!;
      const before = (await owner.query("SELECT * FROM chain.cursors")).rows;
      await assert.rejects(
        storeA.refreshCursor(stale, cursor.version, {
          headNumber: cursor.headNumber,
          finalizedNumber: null,
          gateReason: null,
        }),
        /CHAIN_LEASE_LOST/,
      );
      await assert.rejects(
        storeA.setGate(stale, cursor.version, "PROJECTION_MISMATCH"),
        /CHAIN_LEASE_LOST/,
      );
      await assert.rejects(
        storeA.replaceProjection(stale, cursor.version, snapshot.projection),
        /CHAIN_LEASE_LOST/,
      );
      await assert.rejects(
        storeA.commitReorg(stale, {
          expectedVersion: cursor.version,
          ancestor: {
            number: 9n,
            hash: chain.at(9n)!.hash,
            parentHash: chain.at(9n)!.parentHash,
            timestamp: 1n,
          },
          projection: foldProtocolEvents([]),
          headNumber: cursor.headNumber,
          finalizedNumber: null,
        }),
        /CHAIN_LEASE_LOST/,
      );
      assert.deepEqual(
        (await owner.query("SELECT * FROM chain.cursors")).rows,
        before,
        "nothing changed",
      );
      // The holder itself is fenced by the version too.
      await assert.rejects(
        storeB.setGate(current, cursor.version - 1n, "PROJECTION_MISMATCH"),
        /CHAIN_VERSION_CONFLICT/,
      );

      // The rebuild tool needs the lease for itself, then leaves the projections as the events fold.
      await assert.rejects(
        rebuildChainProjection(storeA, "d1", {
          verify: false,
          workerId: "rebuild",
        }),
        /CHAIN_INDEX_LEASE_HELD/,
      );
      await storeB.releaseLease(current);
      await owner.query("DELETE FROM protocol.positions");
      const found = await rebuildChainProjection(storeA, "d1", {
        verify: true,
        workerId: "rebuild",
      });
      assert.ok(found.differences.length > 0);
      const fixed = await rebuildChainProjection(storeA, "d1", {
        verify: false,
        workerId: "rebuild",
      });
      assert.equal(fixed.rewritten, true);
      assert.deepEqual(
        (
          await rebuildChainProjection(storeA, "d1", {
            verify: true,
            workerId: "rebuild",
          })
        ).differences,
        [],
      );
      assert.deepEqual(
        await storeA.loadProjection("d1"),
        foldProtocolEvents(chain.allEvents()),
      );
    } finally {
      const ended = await Promise.allSettled([
        owner.end(),
        poolA.end(),
        poolB.end(),
      ]);
      for (const result of ended)
        if (result.status === "rejected") teardownFailures.push(result.reason);
      if (created) {
        try {
          await dropDatabase(control, name);
        } catch (error) {
          teardownFailures.push(error);
        }
      }
      await control
        .end()
        .catch((error: unknown) => teardownFailures.push(error));
    }
    assert.deepEqual(poolErrors, [], "no pool connection error");
    assert.deepEqual(teardownFailures, [], "clean teardown");
  },
);

// Plain DROP DATABASE (never FORCE, so nothing is terminated): the backends of pools that just
// ended need a moment to exit, and that is the only error waited out.
async function dropDatabase(control: pg.Client, name: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await control.query(`DROP DATABASE "${name}"`);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "55006" || attempt >= 40) throw error;
      await delay(50);
    }
  }
}
