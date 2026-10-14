import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/database.js";
import {
  seedDeployment,
  seedChain,
  testManifest,
} from "./helpers/signer-fixture.js";
import { postgresKeeperStore } from "../packages/adapters/src/keeper-store.js";
import { createKeeperHandler } from "../packages/application/src/keeper.js";

const ctx = {
  job: { id: "fixture", payload: {} },
  signal: new AbortController().signal,
};
test("keeper retries UNKNOWN with the same intent/request and creates timeout separately at the deadline", async () => {
  const t = await createTestDatabase();
  try {
    const manifest = testManifest();
    await seedDeployment(t.db, manifest);
    await seedChain(t.db, {
      deploymentId: manifest.deploymentId,
      state: "PROPOSED",
    });
    await t.db.exec("UPDATE chain.markets SET proposed_at=100");
    await t.db.query(
      "INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at) VALUES($1,1,decode(repeat('11',32),'hex'),220,1,blink.now())",
      [manifest.deploymentId],
    );
    await t.setRole("blink_worker");
    const ids: string[] = [];
    const handler = createKeeperHandler({
      store: postgresKeeperStore(t.pool),
      deploymentId: manifest.deploymentId,
      reader: { marketState: async () => "PROPOSED" },
      signer: {
        sign: async (input) => {
          ids.push(input.signRequestId);
          return { state: "UNKNOWN", code: "SIGNER_TIMEOUT" };
        },
      },
    });
    await handler(ctx);
    await handler(ctx);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal(
      (await t.pool.query("SELECT id FROM signing.economic_intents")).rows
        .length,
      1,
    );
    await t.setRole(null);
    await t.db.exec("UPDATE chain.cursors SET block_timestamp=4000");
    await t.setRole("blink_worker");
    await handler(ctx);
    assert.equal(
      (await t.pool.query("SELECT id FROM signing.economic_intents")).rows
        .length,
      2,
    );
  } finally {
    await t.close();
  }
});

test("keeper rechecks latest FINAL before signing and audits gas estimation failure", async () => {
  const t = await createTestDatabase();
  try {
    const manifest = testManifest();
    await seedDeployment(t.db, manifest);
    await seedChain(t.db, { deploymentId: manifest.deploymentId });
    await t.db.query(
      "INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at) VALUES($1,1,decode(repeat('11',32),'hex'),4000,1,blink.now())",
      [manifest.deploymentId],
    );
    await t.setRole("blink_worker");
    let signs = 0;
    const store = postgresKeeperStore(t.pool);
    await createKeeperHandler({
      store,
      deploymentId: manifest.deploymentId,
      reader: { marketState: async () => "FINAL" },
      signer: {
        sign: async () => {
          signs++;
          return { state: "UNKNOWN", code: "TIMEOUT" };
        },
      },
    })(ctx);
    assert.equal(signs, 0);
    assert.equal(
      (await t.pool.query("SELECT state FROM signing.economic_intents")).rows[0]
        .state,
      "CANCELLED",
    );
    await createKeeperHandler({
      store,
      deploymentId: manifest.deploymentId,
      reader: { marketState: async () => "OPEN" },
      signer: {
        sign: async () => {
          signs++;
          return { state: "REJECTED", code: "GAS_ESTIMATE_FAILED" };
        },
      },
    })(ctx);
    assert.equal(signs, 0, "cancelled economic intent is never recreated");
    await t.setRole(null);
    await t.db.exec(
      "UPDATE chain.markets SET state='PROPOSED',proposed_at=100; UPDATE chain.cursors SET block_timestamp=220",
    );
    await t.setRole("blink_worker");
    await createKeeperHandler({
      store,
      deploymentId: manifest.deploymentId,
      reader: { marketState: async () => "PROPOSED" },
      signer: {
        sign: async () => ({ state: "REJECTED", code: "GAS_ESTIMATE_FAILED" }),
      },
    })(ctx);
    assert.equal(
      (
        await t.pool.query(
          "SELECT id FROM operations.audit_log WHERE action='keeper.manual_required'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await t.pool.query(
          "SELECT state FROM signing.economic_intents WHERE kind='FINALIZE_UNCHALLENGED'",
        )
      ).rows[0].state,
      "FAILED",
    );
  } finally {
    await t.close();
  }
});
