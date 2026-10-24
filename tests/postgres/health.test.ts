import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withDatabase } from "../helpers/postgres-database.js";
import { seedDeployment, testManifest } from "../helpers/protocol-fixture.js";
import { postgresHealthReader } from "../../packages/adapters/src/health-reader.js";

test("real PostgreSQL: API infrastructure observability grants and indexed queue counts", async () => {
  await withDatabase(async ({ owner, login }) => {
    const manifest = testManifest();
    await seedDeployment(owner, manifest);
    const api = await login({ memberOf: ["blink_api"] });
    const reader = postgresHealthReader(api, manifest.deploymentId);
    assert.deepEqual((await reader.metrics()).counts.jobs, []);
    assert.ok((await reader.health()).reasons.includes("INDEXER_LAG"));
    for (const state of ["QUEUED", "LEASED", "DEAD", "SUCCEEDED"]) {
      await owner.query(
        `INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,lease_owner,lease_until)
        VALUES($1,'health.test',$3,'{}',$2,CASE WHEN $2='LEASED' THEN 'test' END,
          CASE WHEN $2='LEASED' THEN clock_timestamp()+interval '1 minute' END)`,
        [randomUUID(), state, randomUUID()],
      );
    }
    assert.deepEqual((await reader.health()).details.queue, [
      { name: "DEAD", count: "1" },
      { name: "LEASED", count: "1" },
      { name: "QUEUED", count: "1" },
    ]);
    const session = await api.connect();
    try {
      await session.query("SET enable_seqscan=off");
      for (const [state, index] of [
        ["QUEUED", "jobs_due"],
        ["LEASED", "jobs_lease"],
        ["DEAD", "jobs_dead"],
      ]) {
        const plan = await session.query(
          `EXPLAIN SELECT count(*) FROM operations.jobs WHERE state='${state}'`,
        );
        assert.match(JSON.stringify(plan.rows), new RegExp(index!));
      }
    } finally {
      session.release();
    }

    const metrics = await reader.metrics();
    assert.deepEqual(metrics.counts.jobs, [
      { name: "DEAD", count: "1" },
      { name: "LEASED", count: "1" },
      { name: "QUEUED", count: "1" },
      { name: "SUCCEEDED", count: "1" },
    ]);
    assert.deepEqual(metrics.counts.errors, []);
  });
});
