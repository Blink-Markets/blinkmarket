import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { postgresJobQueue } from "../../packages/adapters/src/job-queue.js";
import { dispatchOutbox } from "../../packages/adapters/src/outbox-dispatcher.js";
import { migrate } from "../../packages/adapters/src/migrations.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "TEST_POSTGRES_ADMIN_URL_REQUIRED: dedicated local/CI PostgreSQL with CREATEDB and CREATEROLE privileges",
  );

/** Each test migrates its own random database and drops it afterwards. */
async function withDatabase(
  run: (database: {
    owner: pg.Pool;
    workerPool: (clockOffsetSeconds?: number) => pg.Pool;
  }) => Promise<void>,
) {
  const name = "blink_t2_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^blink_t2_[a-f0-9]{32}$/);
  const control = new pg.Client({ connectionString: adminUrl });
  await control.connect();
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  const owner = new pg.Pool({ connectionString: url.toString(), max: 2 });
  const workers: pg.Pool[] = [];
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    const migrationClient = await owner.connect();
    try {
      await migrate(migrationClient);
    } finally {
      migrationClient.release();
    }
    await run({
      owner,
      // One connection per pool: every caller is a separate PostgreSQL session.
      workerPool: (clockOffsetSeconds = 0) => {
        const pool = new pg.Pool({
          connectionString: url.toString(),
          options:
            "-c role=blink_worker " +
            `-c blink.test_clock_offset_seconds=${clockOffsetSeconds}`,
          max: 1,
        });
        workers.push(pool);
        return pool;
      },
    });
  } finally {
    await Promise.all([owner.end(), ...workers.map((pool) => pool.end())]);
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
  }
}

test(
  "two workers leasing concurrently never receive the same job",
  { timeout: 60_000 },
  () =>
    withDatabase(async ({ workerPool }) => {
      const pools = [workerPool(), workerPool(), workerPool()];
      const queue = postgresJobQueue(pools[0]!);
      const total = 30;
      for (let i = 0; i < total; i += 1)
        await queue.enqueue({
          type: "forecast.schedule",
          dedupeKey: "job-" + i,
          payload: { i },
        });
      const drain = async (pool: pg.Pool, workerId: string) => {
        const mine = postgresJobQueue(pool);
        const ids: string[] = [];
        for (;;) {
          const job = await mine.lease(workerId, ["forecast.schedule"], 60_000);
          if (!job) return ids;
          ids.push(job.id);
          assert.equal(await mine.complete(job), true);
        }
      };
      const [first, second] = await Promise.all([
        drain(pools[1]!, "worker-a"),
        drain(pools[2]!, "worker-b"),
      ]);
      const all = [...first, ...second];
      assert.equal(all.length, total);
      assert.equal(new Set(all).size, total);
      assert.deepEqual(await queue.stats(), { queued: 0, leased: 0, dead: 0 });
    }),
);

test(
  "concurrent dispatchers split the outbox and never double-dispatch",
  { timeout: 60_000 },
  () =>
    withDatabase(async ({ owner, workerPool }) => {
      for (let i = 0; i < 20; i += 1)
        await owner.query(
          `INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload)
         VALUES ($1,'market.creation_requested',$2,1,'{}')`,
          [randomUUID(), "intent-" + i],
        );
      const mapping = {
        "market.creation_requested": (event: { aggregateId: string }) => [
          {
            type: "operations.prune" as const,
            dedupeKey: "unused",
            payload: { intent: event.aggregateId },
          },
        ],
      };
      const counts = await Promise.all([
        dispatchOutbox(workerPool(), mapping, 5),
        dispatchOutbox(workerPool(), mapping, 5),
        dispatchOutbox(workerPool(), mapping, 5),
      ]);
      assert.ok(counts.every((n) => n <= 5));
      // Drain the rest sequentially; the total must be exactly the 20 events.
      let rest = 20 - counts.reduce((a, b) => a + b, 0);
      const pool = workerPool();
      while (rest > 0) {
        const n = await dispatchOutbox(pool, mapping, 5);
        assert.ok(n > 0);
        rest -= n;
      }
      assert.equal(rest, 0);
      const jobs = (
        await owner.query(
          "SELECT count(*)::int AS n, count(DISTINCT dedupe_key)::int AS keys FROM operations.jobs",
        )
      ).rows[0];
      assert.deepEqual(jobs, { n: 20, keys: 20 });
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM operations.outbox WHERE dispatched_at IS NULL",
          )
        ).rows[0].n,
        0,
      );
    }),
);
