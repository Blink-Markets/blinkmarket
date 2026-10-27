import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { identityFixture } from "../helpers/identity-fixture.js";
import { withDatabase } from "../helpers/postgres-database.js";

async function seedOpenForecast(pool: Pool) {
  const agent = await identityFixture(pool).invite({
    operatorName: "clock-test",
    agentName: "clock-test",
    scopes: ["forecast:write"],
    reason: "clock regression",
  });
  await pool.query(
    `WITH w AS (
       INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
       SELECT $1,'clock-test',1,'DAILY',d,d-interval '30 minutes',d
       FROM (SELECT clock_timestamp()+interval '1 hour' AS d) x RETURNING id
     )
     INSERT INTO forecasts.submissions
       (id,window_id,agent_id,operator_id,key_id,forecaster_address,digest,signature,content_hash,verified_block,probability_bps)
     SELECT $2,w.id,$3,$4,$5,decode(repeat('11',20),'hex'),decode(repeat('22',32),'hex'),
       '0x' || repeat('33',65),decode(repeat('44',32),'hex'),1,9000 FROM w`,
    [randomUUID(), randomUUID(), agent.agentId, agent.operatorId, agent.keyId],
  );
}

test("real PostgreSQL production migrations keep open forecast rows sealed for blink_worker", async () => {
  await withDatabase(
    async ({ owner, login }) => {
      await seedOpenForecast(owner);
      const worker = await login({ memberOf: ["blink_worker"], max: 1 });
      await worker.query("SET blink.test_clock_offset_seconds='7200'");
      assert.ok(
        Number(
          (
            await worker.query(
              "SELECT abs(extract(epoch FROM blink.now()-clock_timestamp())) AS drift",
            )
          ).rows[0].drift,
        ) < 5,
      );
      assert.equal(
        (await worker.query("SELECT * FROM forecasts.closed_digests")).rows
          .length,
        0,
      );
      assert.equal(
        (await worker.query("SELECT * FROM analytics.closed_forecasts")).rows
          .length,
        0,
      );
    },
    { testClockOverlay: false },
  );
});
