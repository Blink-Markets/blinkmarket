import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDatabase } from "./helpers/database.ts";
import {
  seedProtocolDeployment,
  hash,
  address,
} from "./helpers/protocol-index.ts";
import { assertProductionClock } from "../packages/adapters/src/business-clock.ts";

test("0029 replaces legacy projections and retains canonical blocks and fenced cursors", async () => {
  const t = await createTestDatabase();
  try {
    assert.ok(
      (
        await t.db.query<{ name: string }>(
          "SELECT name FROM blink_migrations.applied",
        )
      ).rows.some((r) => r.name === "0029_protocol_index.sql"),
    );
    for (const name of [
      "events",
      "markets",
      "positions",
      "quote_digests",
      "maker_state",
      "takers",
    ])
      assert.equal(
        (
          await t.db.query<{ name: string | null }>(
            "SELECT to_regclass($1) AS name",
            ["chain." + name],
          )
        ).rows[0]?.name,
        null,
      );
    for (const name of ["blocks", "cursors"])
      assert.ok(
        (
          await t.db.query<{ name: string | null }>(
            "SELECT to_regclass($1) AS name",
            ["chain." + name],
          )
        ).rows[0]?.name,
      );
    await assertProductionClock(t.pool, false);
    await t.db.exec("SET blink.test_clock_offset_seconds='3600'");
    await assert.rejects(
      assertProductionClock(t.pool, false),
      /TEST_CLOCK_FORBIDDEN/,
    );
    await assertProductionClock(t.pool, true);
  } finally {
    await t.close();
  }
});
test("protocol events are immutable except canonical, projections are indexer-only writes", async () => {
  const t = await createTestDatabase();
  try {
    await seedProtocolDeployment(t.pool);
    await t.db.query(
      "INSERT INTO chain.blocks(deployment_id,number,hash,parent_hash,timestamp,canonical) VALUES('d1',1,decode($1,'hex'),decode($2,'hex'),1000,true)",
      [hash(1).slice(2), hash(0).slice(2)],
    );
    await t.setRole("blink_indexer");
    await t.db.query(
      "INSERT INTO protocol.events(deployment_id,block_hash,block_number,tx_hash,tx_index,log_index,emitter,contract,name,args,canonical) VALUES('d1',decode($1,'hex'),1,decode($2,'hex'),0,0,decode($3,'hex'),'REGISTRY','Registered','{}',true)",
      [hash(1).slice(2), hash(2).slice(2), address(1).slice(2)],
    );
    await t.db.exec("UPDATE protocol.events SET canonical=false");
    await assert.rejects(
      t.db.exec("UPDATE protocol.events SET args='{}'"),
      /permission denied/,
    );
    await assert.rejects(
      t.db.exec("DELETE FROM protocol.events"),
      /permission denied/,
    );
    for (const table of [
      "accounts",
      "templates",
      "markets",
      "positions",
      "makers",
      "quote_digests",
      "fills",
      "anchors",
      "successors",
      "proposals",
      "disputes",
      "rounds",
      "votes",
      "jurors",
      "reward_pool",
      "fees",
    ]) {
      await t.db.query(
        `INSERT INTO protocol.${table}(deployment_id,key,data,as_of_block_hash) VALUES('d1','1','{}',decode($1,'hex'))`,
        [hash(1).slice(2)],
      );
      for (const role of ["blink_api", "blink_worker"]) {
        await t.setRole(role);
        await t.db.exec(`SELECT * FROM protocol.${table}`);
        await assert.rejects(
          t.db.exec(`DELETE FROM protocol.${table}`),
          /permission denied/,
        );
      }
      await t.setRole("blink_indexer");
      await t.db.exec(`DELETE FROM protocol.${table}`);
    }
  } finally {
    await t.close();
  }
});
