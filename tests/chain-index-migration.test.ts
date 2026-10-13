import { test } from "node:test";
import assert from "node:assert/strict";
import { blinkEventNames } from "../packages/adapters/src/blink-abi.js";
import { assertProductionClock } from "../packages/adapters/src/business-clock.js";
import { createTestDatabase } from "./helpers/database.js";

const hash = (n: number) =>
  `decode('${n.toString(16).padStart(2, "0").repeat(32)}','hex')`;
const address = (n: number) =>
  `decode('${n.toString(16).padStart(2, "0").repeat(20)}','hex')`;
const block = (number: number, hashByte: number, canonical = true) =>
  `INSERT INTO chain.blocks(deployment_id,number,hash,parent_hash,timestamp,canonical)
  VALUES ('d1',${number},${hash(hashByte)},${hash(hashByte - 1)},${1000 + number},${canonical})`;
const event = (name: string, logIndex: number) =>
  `INSERT INTO chain.events(deployment_id,block_hash,block_number,tx_hash,tx_index,log_index,name,args,canonical)
  VALUES ('d1',${hash(1)},1,${hash(200)},0,${logIndex},'${name}','{"k":"v"}',true)`;
const market = (id: number) =>
  `INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,
    hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
  VALUES ('d1',${id},${hash(100 + id)},'file://spec','REPLAY',10,20,30,120,10000,500,'OPEN',1,${hash(200)},${hash(1)})`;

async function seeded() {
  const t = await createTestDatabase();
  await t.db.exec(
    `INSERT INTO markets.deployments(id,manifest,market_address) VALUES ('d1','{}',${address(170)});
    ${block(1, 1)}`,
  );
  return t;
}

test("0007 is applied and blink.now() follows the clock plus the local test offset", async () => {
  const t = await createTestDatabase();
  try {
    const applied = await t.db.query<{ name: string }>(
      "SELECT name FROM blink_migrations.applied",
    );
    assert.ok(applied.rows.some((r) => r.name === "0007_chain_index.sql"));
    const skew = async () =>
      Number(
        (
          await t.db.query<{ s: string }>(
            "SELECT extract(epoch FROM blink.now() - clock_timestamp())::text AS s",
          )
        ).rows[0]!.s,
      );
    assert.ok(Math.abs(await skew()) < 5);
    await t.db.exec("SET blink.test_clock_offset_seconds = '3600'");
    const shifted = await skew();
    assert.ok(shifted > 3595 && shifted < 3605, String(shifted));
    for (const role of [
      "blink_api",
      "blink_worker",
      "blink_indexer",
      "blink_signer",
    ]) {
      await t.setRole(role);
      assert.ok(Math.abs((await skew()) - 3600) < 5, role);
    }
  } finally {
    await t.close();
  }
});

test("assertProductionClock refuses a clock offset unless a local test mode allows it", async () => {
  const t = await createTestDatabase();
  try {
    await assertProductionClock(t.pool, false);
    await t.db.exec("SET blink.test_clock_offset_seconds = '3600'");
    await assert.rejects(
      assertProductionClock(t.pool, false),
      /TEST_CLOCK_FORBIDDEN/,
    );
    await assertProductionClock(t.pool, true);
    await t.db.exec("RESET blink.test_clock_offset_seconds");
    await assertProductionClock(t.pool, false);
  } finally {
    await t.close();
  }
});

test("the indexer owns the projections, the API only reads, and events are immutable except for canonical", async () => {
  const t = await seeded();
  try {
    await t.setRole("blink_indexer");
    await t.db.exec(
      `${event("MarketCreated", 0)};
      ${market(1)};
      INSERT INTO chain.positions(deployment_id,market_id,account,as_of_block_hash)
        VALUES ('d1',1,${address(1)},${hash(1)});
      INSERT INTO chain.maker_state(deployment_id,as_of_block_hash) VALUES ('d1',${hash(1)});
      INSERT INTO chain.takers(deployment_id,account,allowed,as_of_block_hash)
        VALUES ('d1',${address(2)},true,${hash(1)});
      INSERT INTO chain.quote_digests(deployment_id,digest,state,block_number,block_hash,tx_hash)
        VALUES ('d1',${hash(50)},'CANCELLED',1,${hash(1)},${hash(200)});
      INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at)
        VALUES ('d1',1,${hash(1)},1001,1,blink.now())`,
    );
    await t.db.exec(
      "UPDATE chain.markets SET paused = true WHERE market_id = 1",
    );
    await t.db.exec(
      "UPDATE chain.cursors SET lease_owner='me', lease_until=blink.now() + interval '1 minute', lease_token=lease_token+1",
    );
    await t.db.exec("UPDATE chain.events SET canonical = false");
    await t.db.exec("UPDATE chain.blocks SET canonical = false");
    await assert.rejects(
      t.db.exec(`UPDATE chain.events SET args = '{"k":"changed"}'`),
      /permission denied/,
    );
    await assert.rejects(
      t.db.exec(`UPDATE chain.blocks SET hash = ${hash(9)}`),
      /permission denied/,
    );
    await assert.rejects(
      t.db.exec("DELETE FROM chain.events"),
      /permission denied/,
    );
    await t.db.exec("DELETE FROM chain.markets WHERE market_id = 1");

    for (const role of ["blink_api", "blink_worker"]) {
      await t.setRole(role);
      for (const table of [
        "cursors",
        "blocks",
        "events",
        "markets",
        "positions",
        "maker_state",
        "quote_digests",
        "takers",
      ])
        await t.db.exec(`SELECT * FROM chain.${table}`);
    }
    await t.setRole("blink_api");
    await assert.rejects(t.db.exec(market(3)), /permission denied/);
    await t.setRole("blink_worker");
    await assert.rejects(t.db.exec(market(3)), /permission denied/);
    await t.setRole("blink_signer");
    for (const table of [
      "cursors",
      "markets",
      "maker_state",
      "quote_digests",
      "takers",
    ])
      await t.db.exec(`SELECT * FROM chain.${table}`);
    for (const table of ["blocks", "events", "positions"])
      await assert.rejects(
        t.db.exec(`SELECT * FROM chain.${table}`),
        /permission denied/,
      );
  } finally {
    await t.close();
  }
});

test("constraints: one canonical block per height, uint256 domains, event names and digest shape", async () => {
  const t = await seeded();
  try {
    await t.db.exec(block(1, 5, false));
    await assert.rejects(t.db.exec(block(1, 6)), /blocks_canonical_height/);
    await assert.rejects(
      t.db.exec(
        `INSERT INTO chain.maker_state(deployment_id,free_balance_micros,as_of_block_hash)
        VALUES ('d1',-1,${hash(1)})`,
      ),
      /uint256/,
    );
    for (const [index, name] of blinkEventNames.entries())
      await t.db.exec(event(name, index));
    await assert.rejects(
      t.db.exec(event("EIP712DomainChanged", 99)),
      /violates check constraint/,
    );
    await assert.rejects(
      t.db.exec(
        `INSERT INTO chain.quote_digests(deployment_id,digest,state,block_number,block_hash,tx_hash)
        VALUES ('d1',${hash(51)},'FILLED',1,${hash(1)},${hash(200)})`,
      ),
      /violates check constraint/,
    );
    await assert.rejects(
      t.db.exec(
        `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at)
        VALUES ('d1',5,${hash(1)},1001,4,blink.now())`,
      ),
      /violates check constraint/,
    );
    await assert.rejects(
      t.db.exec(
        `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at,lease_owner)
        VALUES ('d1',1,${hash(1)},1001,1,blink.now(),'me')`,
      ),
      /violates check constraint/,
    );
  } finally {
    await t.close();
  }
});
