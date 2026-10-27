import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { migrate } from "../packages/adapters/src/migrations.js";
import { identityFixture } from "./helpers/identity-fixture.js";

const now = `SELECT abs(extract(epoch FROM blink.now() - clock_timestamp())) AS drift`;

async function seedOpenForecast(pool: Pool) {
  const agent = await identityFixture(pool).invite({
    operatorName: "clock-test",
    agentName: "clock-test",
    scopes: ["forecast:write"],
    reason: "clock regression",
  });
  const windowId = randomUUID();
  const submissionId = randomUUID();
  await pool.query(
    `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
     SELECT $1,'clock-test',1,'DAILY',d,d-interval '30 minutes',d
     FROM (SELECT clock_timestamp()+interval '1 hour' AS d) x`,
    [windowId],
  );
  await pool.query(
    `INSERT INTO forecasts.submissions
       (id,window_id,agent_id,operator_id,key_id,forecaster_address,digest,signature,content_hash,verified_block,probability_bps)
     VALUES($1,$2,$3,$4,$5,decode(repeat('11',20),'hex'),decode(repeat('22',32),'hex'),
       '0x' || repeat('33',65),decode(repeat('44',32),'hex'),1,9000)`,
    [submissionId, windowId, agent.agentId, agent.operatorId, agent.keyId],
  );
}

test("PGlite production migrations keep open forecast rows sealed for blink_worker", async () => {
  const db = new PGlite();
  const pool = {
    async connect() {
      return {
        query: (sql: string, params?: unknown[]) => db.query(sql, params),
        release() {},
      };
    },
    query: (sql: string, params?: unknown[]) => db.query(sql, params),
  } as unknown as Pool;
  try {
    await migrate({
      async query(sql, params) {
        if (params) return db.query(sql, params);
        return { rows: ((await db.exec(sql)).at(-1)?.rows as never[]) ?? [] };
      },
    });
    await seedOpenForecast(pool);
    await db.exec("SET ROLE blink_worker");
    await db.exec("SET blink.test_clock_offset_seconds='7200'");
    assert.ok(
      Number((await db.query<{ drift: number }>(now)).rows[0]!.drift) < 5,
    );
    assert.equal(
      (await db.query("SELECT * FROM forecasts.closed_digests")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM analytics.closed_forecasts")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
