import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { identityFixture } from "../helpers/identity-fixture.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresForecastStore } from "../../packages/adapters/src/forecast-store.js";
import {
  createForecastService,
  createWindowScheduler,
} from "../../packages/application/src/forecasts.js";
import { IdentityError } from "../../packages/application/src/identity.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
const marketFixture = (
  closeInSeconds: number,
) => `INSERT INTO markets.deployments(id,manifest,market_address) VALUES('test','{}',decode(repeat('11',20),'hex'));
   INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
   VALUES('test',1,decode(repeat('22',32),'hex'),'fixture','REPLAY',floor(extract(epoch from blink.now()))+${closeInSeconds},9999999999,9999999999,120,100,100,'OPEN',1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'));`;

// Creates and drops a random database; never touches the supplied one.
async function withDatabase(
  run: (db: {
    name: string;
    owner: pg.Pool;
    api: pg.Pool;
    worker: pg.Pool;
    agents: Awaited<ReturnType<ReturnType<typeof identityFixture>["invite"]>>[];
  }) => Promise<void>,
) {
  const name = "blink_t7_" + randomUUID().replaceAll("-", "");
  const control = new pg.Client({ connectionString: adminUrl });
  await control.connect();
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  const owner = new pg.Pool({ connectionString: url.toString(), max: 3 });
  const api = new pg.Pool({
    connectionString: url.toString(),
    max: 2,
    options: "-c role=blink_api",
    application_name: name,
  });
  const worker = new pg.Pool({
    connectionString: url.toString(),
    max: 2,
    options: "-c role=blink_worker",
  });
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    const migration = await owner.connect();
    try {
      await migrate(migration);
    } finally {
      migration.release();
    }
    const agents = [];
    for (let i = 0; i < 3; i++)
      agents.push(
        await identityFixture(owner).invite({
          operatorName: "fixture",
          agentName: "fixture",
          scopes: ["forecast:write"],
          reason: "forecast fixture",
        }),
      );
    await run({ name, owner, api, worker, agents });
  } finally {
    await Promise.all([owner.end(), api.end(), worker.end()]);
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
  }
}

test(
  "real PostgreSQL: waiting for a window lock cannot admit a submission after its deadline",
  { skip: !adminUrl, timeout: 30000 },
  () =>
    withDatabase(async ({ name, owner, api, agents }) => {
      await owner.query(marketFixture(7200));
      const source = randomUUID(),
        evidence = randomUUID(),
        windowId = randomUUID();
      await owner.query(
        "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES($1,'fixture','https://fixture.invalid/evidence')",
        [source],
      );
      await owner.query(
        "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy) VALUES($1,$2,$3,decode(repeat('55',32),'hex'),'fixture','PUBLIC')",
        [evidence, source, agents[0]!.operatorId],
      );
      const window = await owner.query(
        `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
   SELECT $1,'test',1,'DAILY',d,d-interval '30 minutes',d FROM (SELECT date_trunc('milliseconds',blink.now())+interval '5 seconds' AS d) stamp RETURNING deadline`,
        [windowId],
      );
      const deadline = new Date(window.rows[0].deadline).toISOString();
      const service = createForecastService({
        store: postgresForecastStore(api),
        crypto: identityCrypto,
      });
      const submit = (i: number) =>
        service.handle({
          method: "POST",
          path: "/v1/markets/:id/forecasts",
          params: { id: "1" },
          query: { deploymentId: "test" },
          body: {
            horizonKey: { horizonType: "DAILY", scheduledAt: deadline },
            probability: 0.6,
            evidenceIds: [evidence],
            rationale: "fixture",
            agentVersion: "v1",
          },
          authorization: "Bearer " + agents[i]!.apiKey,
          idempotencyKey: "race-" + i,
          requestId: randomUUID(),
          ip: "127.0.0.1",
        });
      assert.equal((await submit(0)).status, 201);
      const blocker = await owner.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM forecasts.windows WHERE id=$1 FOR UPDATE",
          [windowId],
        );
        const waiting = submit(1).then(
          () => "unexpected success",
          (error) => error,
        );
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const activity = await owner.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
            [name],
          );
          if (activity.rows.length) {
            blocked = true;
            break;
          }
          await owner.query("SELECT pg_sleep(0.01)");
        }
        assert.ok(blocked, "request reached the held row lock before deadline");
        assert.equal(
          (
            await owner.query("SELECT blink.now()<$1::timestamptz AS before", [
              deadline,
            ])
          ).rows[0].before,
          true,
        );
        await owner.query(
          "SELECT pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-blink.now())))::double precision+0.02)",
          [deadline],
        );
        const after = submit(2).then(
          () => "unexpected success",
          (error) => error,
        );
        await blocker.query("COMMIT");
        for (const result of await Promise.all([waiting, after])) {
          assert.ok(result instanceof IdentityError);
          assert.equal(result.code, "FORECAST_WINDOW_CLOSED");
          assert.equal(result.details.reason, "CLOSED");
        }
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM forecasts.submissions",
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT 1 FROM forecasts.submissions s JOIN forecasts.windows w ON w.id=s.window_id WHERE s.received_at>=w.deadline",
          )
        ).rows.length,
        0,
      );
    }),
);

test(
  "real PostgreSQL: scheduler and role grants",
  { skip: !adminUrl, timeout: 30000 },
  () =>
    withDatabase(async ({ owner, api, worker, agents }) => {
      await owner.query(marketFixture(3 * 86400 + 600));
      const scheduler = createWindowScheduler(postgresForecastStore(worker));
      assert.ok((await scheduler.scheduleOnce()) >= 4);
      assert.equal(await scheduler.scheduleOnce(), 0);
      assert.equal(
        (
          await owner.query(
            "SELECT 1 FROM forecasts.windows WHERE deadline<=blink.now() OR open_at<>scheduled_at-interval '30 minutes'",
          )
        ).rows.length,
        0,
      );
      await assert.rejects(
        worker.query("SELECT 1 FROM forecasts.submissions"),
        /permission denied/,
      );
    }),
);
