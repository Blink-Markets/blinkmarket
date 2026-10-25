import { seedProtocolDeployment } from "../helpers/protocol-index.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { postgresOperatorStatusStore } from "../../packages/adapters/src/operator-status-store.js";
import { seedChain } from "../helpers/protocol-fixture.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_POSTGRES_ADMIN_URL_REQUIRED");
test("real PostgreSQL: operator status reads under blink_api grants and bounds the dead-job list", async () => {
  const name = "blink_a3_" + randomUUID().replaceAll("-", "");
  const control = new pg.Client({ connectionString: adminUrl });
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  const owner = new pg.Pool({ connectionString: url.toString() });
  const api = new pg.Pool({
    connectionString: url.toString(),
    options: "-c role=blink_api -c default_transaction_read_only=on",
  });
  let created = false;
  await control.connect();
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(owner);
    const manifest = await seedProtocolDeployment(owner);
    await seedChain(owner, {
      deploymentId: manifest.deploymentId,
      state: "DISPUTED",
    });
    await owner.query(
      "INSERT INTO operations.jobs(id,type,dedupe_key,payload,state) VALUES ($1,'private','private','{}','DEAD')",
      [randomUUID()],
    );
    const store = postgresOperatorStatusStore(api, manifest.deploymentId);
    assert.equal((await store.jobs()).items.length, 1);
    assert.equal((await store.pause()).globalPaused, false);
    // 100 DEAD jobs plus the one above: newest 100 returned, truncated, newest first.
    await owner.query(
      `INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,created_at)
       SELECT gen_random_uuid(),'private','k'||i,'{}','DEAD',timestamptz '2026-01-01 00:00:00+00' + i * interval '1 second'
       FROM generate_series(1,100) i`,
    );
    const jobs = await store.jobs();
    assert.equal(jobs.items.length, 100);
    assert.equal(jobs.truncated, true);
    assert.ok(
      jobs.items.every(
        (j, i) => i === 0 || jobs.items[i - 1]!.createdAt >= j.createdAt,
      ),
    );
    assert.doesNotMatch(JSON.stringify(jobs), /private/);
    await assert.rejects(
      api.query("UPDATE operations.jobs SET state='QUEUED'"),
      /read-only|permission denied/,
    );
  } finally {
    await Promise.all([owner.end(), api.end()]);
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
  }
});
