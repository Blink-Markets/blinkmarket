import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import {
  createQuoteReconcileHandler,
  createQuoteReconciler,
  decideReservation,
} from "../packages/application/src/quote-reconcile.js";
import { createChainIndexer } from "../packages/application/src/chain-indexer.js";
import { createSnapshotReader } from "../packages/application/src/forecasts.js";
import { postgresChainIndexStore } from "../packages/adapters/src/chain-index-store.js";
import { postgresForecastStore } from "../packages/adapters/src/forecast-store.js";
import { postgresTradingStore } from "../packages/adapters/src/trading-store.js";
import { SIGNING_POLICY_VERSION } from "../packages/domain/src/signing-policy.js";
import { createTestDatabase } from "./helpers/database.js";
import {
  FakeChain,
  MARKET_ADDRESS,
  TAKER,
  hashOf,
  makerDeposited,
  marketCreated,
  quoteFilled,
  takerAllowed,
} from "./helpers/fake-chain.js";
import { poolAs } from "./helpers/research.js";
import {
  DEPLOYMENT,
  FREE_MICROS,
  HEAD_TS,
  blockHash,
  seedSnapshot,
  tradingWorld,
  type TradingWorld,
} from "./helpers/trading.js";

const reconcilerFor = (w: TradingWorld) =>
  createQuoteReconciler(postgresTradingStore(poolAs(w.t, "blink_worker")));
const state = async (w: TradingWorld) =>
  (
    await w.query<{
      state: string;
      block_number: string | null;
      block_hash: string | null;
      quote: string;
    }>(
      `SELECT r.state, r.state_block_number::text AS block_number, '0x'||encode(r.state_block_hash,'hex') AS block_hash,
        q.status AS quote
      FROM trading.collateral_reservations r JOIN trading.quotes q ON q.id=r.quote_id ORDER BY r.created_at`,
    )
  )[0]!;
const events = (w: TradingWorld) =>
  w.query<{ from_state: string | null; to_state: string; reason: string }>(
    "SELECT from_state, to_state, reason FROM trading.reservation_events ORDER BY created_at, to_state",
  );
const fill = (w: TradingWorld, digest: string, block: bigint) =>
  w.query(
    `INSERT INTO chain.quote_digests(deployment_id,digest,state,market_id,taker,side,quantity,price_bps,taker_cost_micros,maker_cost_micros,block_number,block_hash,tx_hash)
    VALUES ($1,decode($2,'hex'),'FILLED',1,decode($3,'hex'),'YES',10,6200,6200000,3800000,$4,decode($5,'hex'),decode($5,'hex'))`,
    [
      DEPLOYMENT,
      digest.slice(2),
      "b1".repeat(20),
      block.toString(),
      blockHash(block).slice(2),
    ],
  );
const quoted = async (w: TradingWorld, key = "k") => {
  const res = await w.post(key);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().quoteId as string;
};

test("a fill at or below the cursor accounts the reservation and consumes the quote, once", async () => {
  const w = await tradingWorld();
  try {
    const digest = await quoted(w);
    const reconciler = reconcilerFor(w);
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 0,
      reopened: 0,
    });
    await w.setCursor({ number: 101n, timestamp: HEAD_TS + 2n });
    await fill(w, digest, 101n);
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 1,
      released: 0,
      reopened: 0,
    });
    assert.deepEqual(await state(w), {
      state: "ACCOUNTED",
      block_number: "101",
      block_hash: blockHash(101n),
      quote: "CONSUMED",
    });
    assert.deepEqual(await events(w), [
      { from_state: null, to_state: "HELD", reason: "QUOTE_RESERVED" },
      { from_state: "HELD", to_state: "ACCOUNTED", reason: "FILL_INDEXED" },
    ]);
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 0,
      reopened: 0,
    });
    assert.equal((await events(w)).length, 2);
  } finally {
    await w.close();
  }
});

test("expiry releases on the block time of the cursor, never on a local clock", async () => {
  const w = await tradingWorld();
  try {
    await quoted(w);
    const reconciler = reconcilerFor(w);
    // The database clock is an hour ahead; the canonical block is not past the expiry.
    await w.setDbClock(3600);
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 0,
      reopened: 0,
    });
    assert.equal((await state(w)).state, "HELD");
    assert.equal((await state(w)).quote, "SIGNED");
    await w.setDbClock(0);
    // One second before the expiry is still held; the block at the expiry releases it.
    await w.setCursor({ number: 101n, timestamp: HEAD_TS + 29n });
    assert.equal((await reconciler.reconcileOnce(DEPLOYMENT)).released, 0);
    await w.setCursor({ number: 102n, timestamp: HEAD_TS + 30n });
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 1,
      reopened: 0,
    });
    assert.deepEqual(await state(w), {
      state: "RELEASED",
      block_number: "102",
      block_hash: blockHash(102n),
      quote: "EXPIRED",
    });
    assert.equal((await events(w))[1]!.reason, "EXPIRED_BY_BLOCK_TIME");
  } finally {
    await w.close();
  }
});

test("a fill outranks expiry: the quote was filled before the block that expired it", async () => {
  const w = await tradingWorld();
  try {
    const digest = await quoted(w);
    await w.setCursor({ number: 105n, timestamp: HEAD_TS + 600n });
    await fill(w, digest, 101n);
    assert.deepEqual(await reconcilerFor(w).reconcileOnce(DEPLOYMENT), {
      accounted: 1,
      released: 0,
      reopened: 0,
    });
    assert.equal((await state(w)).quote, "CONSUMED");
  } finally {
    await w.close();
  }
});

test("an indexed cancellation or a maker epoch bump releases the reservation", async () => {
  const w = await tradingWorld();
  try {
    const digest = await quoted(w, "cancelled");
    await w.query(
      `INSERT INTO chain.quote_digests(deployment_id,digest,state,block_number,block_hash,tx_hash)
      VALUES ($1,decode($2,'hex'),'CANCELLED',100,decode($3,'hex'),decode($3,'hex'))`,
      [DEPLOYMENT, digest.slice(2), blockHash(100n).slice(2)],
    );
    assert.deepEqual(await reconcilerFor(w).reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 1,
      reopened: 0,
    });
    assert.deepEqual(await state(w), {
      state: "RELEASED",
      block_number: "100",
      block_hash: blockHash(100n),
      quote: "CANCELLED",
    });
    assert.equal((await events(w))[1]!.reason, "QUOTE_CANCELLED");
  } finally {
    await w.close();
  }
  const bumped = await tradingWorld();
  try {
    await quoted(bumped);
    await bumped.query("UPDATE chain.maker_state SET epoch=4");
    assert.deepEqual(await reconcilerFor(bumped).reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 1,
      reopened: 0,
    });
    assert.equal((await state(bumped)).quote, "CANCELLED");
    assert.equal((await events(bumped))[1]!.reason, "EPOCH_INCREMENTED");
  } finally {
    await bumped.close();
  }
});

test("a reorg reopens settled reservations; the quote gate stays shut until they are reconciled", async () => {
  const w = await tradingWorld();
  try {
    const digest = await quoted(w);
    const reconciler = reconcilerFor(w);
    await w.setCursor({ number: 101n, timestamp: HEAD_TS + 2n });
    await fill(w, digest, 101n);
    assert.equal((await reconciler.reconcileOnce(DEPLOYMENT)).accounted, 1);

    // Block 101 is orphaned: the indexer tombstones it, drops the fill and rewinds the cursor.
    await w.query("UPDATE chain.blocks SET canonical=false WHERE number=101");
    await w.query("DELETE FROM chain.quote_digests");
    await w.setCursor({ number: 100n, timestamp: HEAD_TS });
    w.chain.state.head = {
      ...w.chain.state.head,
      number: 100n,
      hash: blockHash(100n),
    };
    // New quotes wait for reconciliation: an accounted fill that no longer exists must not be trusted.
    const blocked = await w.post("blocked");
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().code, "SERVICE_NOT_READY");
    assert.equal(blocked.json().details.reason, "RECONCILE_REQUIRED");

    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 0,
      reopened: 1,
    });
    assert.deepEqual(await state(w), {
      state: "RECONCILE_REQUIRED",
      block_number: null,
      block_hash: null,
      quote: "SIGNED",
    });
    assert.deepEqual(
      (await events(w))
        .map((e) => [e.from_state, e.to_state, e.reason])
        .slice(-1),
      [["ACCOUNTED", "RECONCILE_REQUIRED", "REORG_REOPENED"]],
    );
    // It holds the maker's collateral again, so the pool counts it.
    assert.equal((await w.post("blocked")).statusCode, 200);

    // The new branch includes the fill at a different block: accounted again against that block.
    await w.query(
      `INSERT INTO chain.blocks(deployment_id,number,hash,parent_hash,timestamp,canonical)
      VALUES ($1,101,decode($2,'hex'),decode($3,'hex'),1002,true)`,
      [DEPLOYMENT, "01".repeat(32), blockHash(100n).slice(2)],
    );
    await w.query(
      `UPDATE chain.cursors SET block_number=101, block_hash=decode($1,'hex'), block_timestamp=1002, head_number=101, synced_at=blink.now()`,
      ["01".repeat(32)],
    );
    await w.query(
      `INSERT INTO chain.quote_digests(deployment_id,digest,state,market_id,taker,side,quantity,price_bps,taker_cost_micros,maker_cost_micros,block_number,block_hash,tx_hash)
      VALUES ($1,decode($2,'hex'),'FILLED',1,decode($3,'hex'),'YES',10,6200,6200000,3800000,101,decode($4,'hex'),decode($4,'hex'))`,
      [DEPLOYMENT, digest.slice(2), "b1".repeat(20), "01".repeat(32)],
    );
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 1,
      released: 0,
      reopened: 0,
    });
    const [first] = await w.query<{ state: string; block_hash: string }>(
      `SELECT r.state, '0x'||encode(r.state_block_hash,'hex') AS block_hash
      FROM trading.collateral_reservations r JOIN trading.quotes q ON q.id=r.quote_id
      WHERE q.digest=decode($1,'hex')`,
      [digest.slice(2)],
    );
    assert.deepEqual(first, {
      state: "ACCOUNTED",
      block_hash: "0x" + "01".repeat(32),
    });
  } finally {
    await w.close();
  }
});

test("a release decided at an orphaned block is reopened and decided again at the new cursor", async () => {
  const w = await tradingWorld();
  try {
    await quoted(w);
    const reconciler = reconcilerFor(w);
    await w.setCursor({ number: 102n, timestamp: HEAD_TS + 30n });
    assert.equal((await reconciler.reconcileOnce(DEPLOYMENT)).released, 1);
    // The block that carried the expiry time is replaced by one that is just as late.
    await w.query("UPDATE chain.blocks SET canonical=false WHERE number=102");
    await w.query(
      `INSERT INTO chain.blocks(deployment_id,number,hash,parent_hash,timestamp,canonical)
      VALUES ($1,102,decode($2,'hex'),decode($3,'hex'),$4,true)`,
      [
        DEPLOYMENT,
        "02".repeat(32),
        blockHash(101n).slice(2),
        String(HEAD_TS + 31n),
      ],
    );
    await w.query(
      `UPDATE chain.cursors SET block_hash=decode($1,'hex'), block_timestamp=$2, synced_at=blink.now()`,
      ["02".repeat(32), String(HEAD_TS + 31n)],
    );
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 1,
      reopened: 1,
    });
    assert.deepEqual(await state(w), {
      state: "RELEASED",
      block_number: "102",
      block_hash: "0x" + "02".repeat(32),
      quote: "EXPIRED",
    });
  } finally {
    await w.close();
  }
});

test("while the indexer's cursor is gated nothing is concluded", async () => {
  const w = await tradingWorld();
  try {
    const digest = await quoted(w);
    await w.setCursor({
      number: 101n,
      timestamp: HEAD_TS + 600n,
      gate: "PROJECTION_MISMATCH",
    });
    await fill(w, digest, 101n);
    assert.deepEqual(await reconcilerFor(w).reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 0,
      reopened: 0,
    });
    assert.equal((await state(w)).state, "HELD");
  } finally {
    await w.close();
  }
});

test("when held reservations exceed the maker's free balance the pool gates new quotes until it recovers", async () => {
  const w = await tradingWorld();
  try {
    await quoted(w);
    const reconciler = reconcilerFor(w);
    await reconciler.reconcileOnce(DEPLOYMENT);
    assert.equal(
      (
        await w.query<{ gate_reason: string | null }>(
          "SELECT gate_reason FROM trading.maker_pools",
        )
      )[0]!.gate_reason,
      null,
    );
    // The maker withdrew down to 1 bUSD while 3.8 is reserved.
    await w.query("UPDATE chain.maker_state SET free_balance_micros=1000000");
    await reconciler.reconcileOnce(DEPLOYMENT);
    assert.equal(
      (
        await w.query<{ gate_reason: string | null }>(
          "SELECT gate_reason FROM trading.maker_pools",
        )
      )[0]!.gate_reason,
      "OVERCOMMITTED",
    );
    const gated = await w.post("next");
    assert.equal(gated.statusCode, 503);
    assert.equal(gated.json().details.reason, "OVERCOMMITTED");
    const before = (
      await w.query<{ version: string }>(
        "SELECT version::text FROM trading.maker_pools",
      )
    )[0]!.version;
    // Deposits restore the balance: the next reconciliation reopens the pool.
    await w.query("UPDATE chain.maker_state SET free_balance_micros=$1", [
      FREE_MICROS.toString(),
    ]);
    await reconciler.reconcileOnce(DEPLOYMENT);
    assert.equal(
      (
        await w.query<{ gate_reason: string | null }>(
          "SELECT gate_reason FROM trading.maker_pools",
        )
      )[0]!.gate_reason,
      null,
    );
    assert.notEqual(
      (
        await w.query<{ version: string }>(
          "SELECT version::text FROM trading.maker_pools",
        )
      )[0]!.version,
      before,
    );
    assert.equal((await w.post("next")).statusCode, 200);
  } finally {
    await w.close();
  }
});

test("held reservations always count; a fill accounted above the head used for the balance read still does", async () => {
  const w = await tradingWorld();
  try {
    const reserved = (head: bigint) =>
      w.tradingStore.run((tx) => tx.reservedMicros(DEPLOYMENT, head));
    const first = await quoted(w, "first");
    assert.equal(await reserved(100n), 3_800_000n);
    // The fill is indexed at block 101 and its reservation accounted.
    await w.setCursor({
      number: 101n,
      timestamp: HEAD_TS + 2n,
      headNumber: 101n,
    });
    await fill(w, first, 101n);
    assert.equal(
      (await reconcilerFor(w).reconcileOnce(DEPLOYMENT)).accounted,
      1,
    );
    // A balance read at head 100 predates that fill, so its cost is not in it yet; at head 101 it is.
    assert.equal(await reserved(100n), 3_800_000n);
    assert.equal(await reserved(101n), 0n);
    assert.equal(await reserved(102n), 0n);
    w.chain.state.head = {
      number: 101n,
      hash: blockHash(101n),
      timestamp: HEAD_TS + 2n,
    };
    assert.equal((await w.post("second")).statusCode, 200);
    assert.equal(await reserved(101n), 3_800_000n);
    assert.equal(await reserved(100n), 7_600_000n);
  } finally {
    await w.close();
  }
});

test("decideReservation is a pure function of the cursor, the digest and the maker epoch", () => {
  const base = {
    reservationId: "r",
    quoteId: "q",
    amountMicros: 1n,
    quoteEpoch: 3n,
    expiresAt: 1030n,
    digest: null,
  };
  const cursor = {
    blockNumber: 50n,
    blockHash: blockHash(50n),
    blockTimestamp: 1000n,
  };
  assert.equal(
    decideReservation({ reservation: base, cursor, makerEpoch: 3n }),
    null,
  );
  assert.equal(
    decideReservation({ reservation: base, cursor, makerEpoch: null }),
    null,
  );
  assert.equal(
    decideReservation({
      reservation: {
        ...base,
        digest: {
          state: "FILLED",
          blockNumber: 51n,
          blockHash: blockHash(51n),
        },
      },
      cursor,
      makerEpoch: 3n,
    }),
    null,
    "a fill above the cursor is not observed yet",
  );
  assert.deepEqual(
    decideReservation({
      reservation: {
        ...base,
        digest: {
          state: "FILLED",
          blockNumber: 50n,
          blockHash: blockHash(50n),
        },
      },
      cursor,
      makerEpoch: 4n,
    })?.quoteStatus,
    "CONSUMED",
  );
});

test("the job handler validates its payload and honors cancellation", async () => {
  const calls: string[] = [];
  const handler = createQuoteReconcileHandler({
    async reconcileOnce(id) {
      calls.push(id);
      return { accounted: 0, released: 0, reopened: 0 };
    },
  });
  const context = (
    payload: Record<string, unknown>,
    signal = new AbortController().signal,
  ) => ({ job: { id: "j", payload }, signal }) as never;
  await handler(context({ deploymentId: "d1" }));
  assert.deepEqual(calls, ["d1"]);
  await assert.rejects(handler(context({})), {
    code: "INVALID_QUOTE_RECONCILE_PAYLOAD",
    retryable: false,
  });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    handler(context({ deploymentId: "d1" }, aborted.signal)),
    { code: "OPERATION_ABORTED", retryable: true },
  );
  const failing = createQuoteReconcileHandler({
    async reconcileOnce() {
      throw new Error("db down");
    },
  });
  await assert.rejects(failing(context({ deploymentId: "d1" })), {
    code: "QUOTE_RECONCILE_FAILED",
    retryable: true,
  });
});

// The same flows against the real indexer on a scripted fork, instead of hand-edited projections.
test("a fill that a real reorg removes is reopened and accounted again on the new branch", async () => {
  const t = await createTestDatabase();
  try {
    await t.db.query(
      "INSERT INTO markets.deployments(id,manifest,market_address) VALUES ($1,'{\"deploymentBlock\":\"10\"}',decode($2,'hex'))",
      [DEPLOYMENT, MARKET_ADDRESS.slice(2)],
    );
    const chain = new FakeChain(11n);
    chain.mine([marketCreated(1)]);
    chain.mine([makerDeposited(100_000_000n)]);
    chain.mine([takerAllowed(TAKER)]);
    chain.mineTo(18n);
    const indexer = createChainIndexer({
      store: postgresChainIndexStore(poolAs(t, "blink_indexer")),
      reader: chain.reader(),
      deploymentId: DEPLOYMENT,
      marketAddress: MARKET_ADDRESS,
      deploymentBlock: 10n,
      workerId: "reorg-test",
    });
    const sync = async () => {
      for (let steps = 0; ; steps++) {
        assert.ok(steps < 50, "sync converges");
        const { advancedTo, reorgedTo } = await indexer.syncOnce();
        if (advancedTo === null && reorgedTo === null) return;
      }
    };
    await sync();

    await seedSnapshot(t);
    const snapshot = await createSnapshotReader(
      postgresForecastStore(poolAs(t, "blink_api")),
    ).latest(DEPLOYMENT, "1");
    const digest = hashOf(0x901) as Hex;
    await postgresTradingStore(poolAs(t, "blink_api")).run(async (tx) => {
      await tx.lockPool(DEPLOYMENT);
      await tx.createQuote({
        id: randomUUID(),
        reservationId: randomUUID(),
        operatorId: randomUUID(),
        idempotencyKey: "k",
        deploymentId: DEPLOYMENT,
        marketId: 1n,
        agentId: randomUUID(),
        keyId: randomUUID(),
        taker: TAKER as Hex,
        side: "YES",
        quantity: 10n,
        priceBps: 6000,
        takerCostMicros: 6_000_000n,
        makerCostMicros: 4_000_000n,
        maxCostMicros: 7_000_000n,
        validAfter: 1000n,
        expiresAt: 5000n,
        nonce: 1n,
        epoch: 0n,
        specHash: hashOf(0x701) as Hex,
        digest,
        forecastSnapshotId: snapshot!.snapshotId,
        snapshotBlockNumber: 18n,
        snapshotBlockHash: chain.at(18n)!.hash as Hex,
        message: { fixture: "message" },
        policyVersion: SIGNING_POLICY_VERSION,
      });
    });
    const reconciler = createQuoteReconciler(
      postgresTradingStore(poolAs(t, "blink_worker")),
    );
    const reservation = async () => {
      await t.db.exec("RESET ROLE");
      return (
        await t.db.query<{ state: string; hash: string | null }>(
          "SELECT state, '0x'||encode(state_block_hash,'hex') AS hash FROM trading.collateral_reservations",
        )
      ).rows[0]!;
    };
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 0,
      reopened: 0,
    });

    chain.mine([quoteFilled(1, { side: 0, quantity: 10n, priceBps: 6000 })]);
    chain.mine();
    await sync();
    const oldFill = chain.at(19n)!.hash;
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 1,
      released: 0,
      reopened: 0,
    });
    assert.deepEqual(await reservation(), {
      state: "ACCOUNTED",
      hash: oldFill,
    });

    // The fill's block is replaced by a branch without it.
    chain.rewind(18n);
    chain.mine();
    chain.mine();
    chain.mine();
    await sync();
    assert.notEqual(chain.at(19n)!.hash, oldFill);
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 0,
      released: 0,
      reopened: 1,
    });
    assert.deepEqual(await reservation(), {
      state: "RECONCILE_REQUIRED",
      hash: null,
    });

    // The fill is included again, in a block of the new branch.
    chain.mine([quoteFilled(1, { side: 0, quantity: 10n, priceBps: 6000 })]);
    chain.mine();
    await sync();
    assert.deepEqual(await reconciler.reconcileOnce(DEPLOYMENT), {
      accounted: 1,
      released: 0,
      reopened: 0,
    });
    assert.deepEqual(await reservation(), {
      state: "ACCOUNTED",
      hash: chain.at(22n)!.hash,
    });
  } finally {
    await t.close();
  }
});
