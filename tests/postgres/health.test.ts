import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withDatabase } from "../helpers/postgres-database.js";
import {
  seedDeployment,
  testManifest,
  prepareRequest,
} from "../helpers/signer-fixture.js";
import { postgresHealthReader } from "../../packages/adapters/src/health-reader.js";

test("real PostgreSQL: API observability grants, percentiles and stable receipt timestamps", async () => {
  await withDatabase(async ({ owner, login }) => {
    const manifest = testManifest();
    await seedDeployment(owner, manifest);
    const api = await login({ memberOf: ["blink_api"] });
    const worker = await login({ memberOf: ["blink_worker"] });
    const reader = postgresHealthReader(api, manifest.deploymentId);
    assert.deepEqual((await reader.metrics()).txInclusionLatency, {
      samples: "0",
      p50Ms: null,
      p95Ms: null,
    });
    assert.ok((await reader.health()).reasons.includes("INDEXER_LAG"));
    for (const [index, seconds] of [1, 3].entries()) {
      const request = await prepareRequest(owner, manifest, {
        kind: "MINT",
        payload: {},
      });
      const artifact = randomUUID();
      await owner.query(
        `INSERT INTO signing.artifacts(id,sign_request_id,artifact_hash,raw_transaction,max_cost_wei)
        VALUES ($1,$2,decode(repeat($3,32),'hex'),'0x00',1)`,
        [artifact, request.signRequestId, index ? "ab" : "cd"],
      );
      const attempt = randomUUID();
      // The worker stamps submission and inclusion on blink.now(): a positive test-clock offset
      // moves both, so the observed latency stays real elapsed time.
      const session = await worker.connect();
      try {
        await session.query("SET blink.test_clock_offset_seconds = '3600'");
        await session.query(
          `INSERT INTO signing.tx_attempts(id,intent_id,artifact_id,tx_hash,nonce,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,max_cost_wei,status,submitted_at)
          VALUES($1,$2,$3,decode(repeat($4,32),'hex'),$5,21000,1,0,21000,'SUBMITTED',blink.now()-interval '10 seconds')`,
          [attempt, request.intentId, artifact, index ? "ab" : "cd", index],
        );
        await session.query(
          "UPDATE signing.tx_attempts SET status='INCLUDED' WHERE id=$1",
          [attempt],
        );
      } finally {
        session.release();
      }
      const naturalMs = (
        await owner.query(
          "SELECT EXTRACT(EPOCH FROM (included_at-submitted_at))*1000 AS ms FROM signing.tx_attempts WHERE id=$1",
          [attempt],
        )
      ).rows[0].ms;
      assert.ok(
        naturalMs >= 10_000 && naturalMs < 60_000,
        `inclusion latency ${naturalMs} ms is real elapsed time under a clock offset`,
      );
      const observed = (
        await owner.query(
          "SELECT included_at FROM signing.tx_attempts WHERE id=$1",
          [attempt],
        )
      ).rows[0].included_at;
      assert.ok(observed);
      await worker.query(
        "UPDATE signing.tx_attempts SET status='FINALIZED',updated_at=clock_timestamp()+interval '1 day' WHERE id=$1",
        [attempt],
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT included_at FROM signing.tx_attempts WHERE id=$1",
            [attempt],
          )
        ).rows[0].included_at,
        observed,
      );
      await owner.query(
        "UPDATE signing.tx_attempts SET included_at=submitted_at+make_interval(secs=>$2) WHERE id=$1",
        [attempt, seconds],
      );
    }
    const metrics = await reader.metrics();
    assert.deepEqual(metrics.txInclusionLatency, {
      samples: "2",
      p50Ms: 2000,
      p95Ms: 2900,
    });
    assert.deepEqual(metrics.counts.transactions, [
      { name: "FINALIZED", count: "2" },
    ]);
    await assert.rejects(
      api.query("SELECT raw_transaction FROM signing.artifacts"),
      /permission denied/,
    );
    await assert.rejects(
      api.query("SELECT tx_hash FROM signing.tx_attempts"),
      /permission denied/,
    );
    await worker.query("UPDATE signing.tx_attempts SET status='REORGED'");
    assert.deepEqual((await reader.metrics()).txInclusionLatency, {
      samples: "0",
      p50Ms: null,
      p95Ms: null,
    });
  });
});
