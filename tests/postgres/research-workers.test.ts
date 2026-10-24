import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { postgresDiscoveryStore } from "../../packages/adapters/src/discovery-store.js";
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
    workerPool: () => pg.Pool;
  }) => Promise<void>,
) {
  const name = "blink_t10_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^blink_t10_[a-f0-9]{32}$/);
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
      workerPool: () => {
        const pool = new pg.Pool({
          connectionString: url.toString(),
          options: "-c role=blink_worker",
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

const DAY = "2026-01-15";
const ANSWER = {
  entityId: "ACME",
  fiscalPeriod: "FY2025Q1",
  thresholdBps: 4200,
  thesis: "Stored with the slot.",
};
async function startRuns(owner: pg.Pool, worker: pg.Pool, count: number) {
  const store = postgresDiscoveryStore(worker);
  const runs: string[] = [];
  for (let i = 0; i < count; i++) {
    const sourceId = randomUUID();
    await owner.query(
      "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES ($1,'ACME',$2)",
      [sourceId, `https://ir.example.test/${sourceId}`],
    );
    runs.push((await store.startRun({ sourceId, day: DAY, slot: 0 })).id);
  }
  return runs;
}
const counter = async (owner: pg.Pool) =>
  (
    await owner.query(
      "SELECT candidates FROM discovery.daily_counters WHERE day=$1::date",
      [DAY],
    )
  ).rows[0]?.candidates ?? 0;
const held = async (owner: pg.Pool) =>
  Number(
    (
      await owner.query(
        "SELECT count(*) FROM discovery.scan_runs WHERE slot_taken",
      )
    ).rows[0].count,
  );

test("concurrent workers admit exactly ten candidates a day", async () => {
  await withDatabase(async ({ owner, workerPool }) => {
    const pools = [workerPool(), workerPool(), workerPool(), workerPool()];
    const runs = await startRuns(owner, pools[0]!, 15);
    const outcomes = await Promise.all(
      runs.map((id, i) =>
        postgresDiscoveryStore(pools[i % 4]!).takeSlot(id, ANSWER),
      ),
    );
    assert.equal(outcomes.filter((o) => o === "TAKEN").length, 10);
    assert.equal(outcomes.filter((o) => o === "CAP").length, 5);
    assert.equal(await counter(owner), 10);
    assert.equal(await held(owner), 10);
    // Each admitted run stored its answer with the slot, in the same transaction.
    const stored = await owner.query(
      "SELECT answer FROM discovery.scan_runs WHERE slot_taken",
    );
    assert.equal(stored.rows.length, 10);
    assert.ok(stored.rows.every((row) => row.answer.thesis === ANSWER.thesis));
    const capped = await owner.query(
      "SELECT count(*) FROM discovery.scan_runs WHERE answer IS NULL",
    );
    assert.equal(Number(capped.rows[0].count), 5);
  });
});

test("a redelivered run never holds two slots, and a returned slot is reusable under contention", async () => {
  await withDatabase(async ({ owner, workerPool }) => {
    const pools = [workerPool(), workerPool(), workerPool(), workerPool()];
    const runs = await startRuns(owner, pools[0]!, 12);
    // The same run racing itself: one TAKEN, the others see it already holds a slot.
    const twice = await Promise.all(
      pools.map((pool) =>
        postgresDiscoveryStore(pool).takeSlot(runs[0]!, ANSWER),
      ),
    );
    assert.deepEqual(twice.slice().sort(), [
      "ALREADY",
      "ALREADY",
      "ALREADY",
      "TAKEN",
    ]);
    assert.equal(await counter(owner), 1);
    // Fill the day, then return three slots while the others compete for them.
    const taken = runs.slice(0, 10);
    await Promise.all(
      taken
        .slice(1)
        .map((id, i) =>
          postgresDiscoveryStore(pools[i % 4]!).takeSlot(id, ANSWER),
        ),
    );
    assert.equal(await counter(owner), 10);
    const returning = taken
      .slice(0, 3)
      .map((id, i) =>
        postgresDiscoveryStore(pools[i]!).finish(id, { state: "NO_CANDIDATE" }),
      );
    const competing = runs
      .slice(10)
      .map((id, i) =>
        postgresDiscoveryStore(pools[i % 4]!).takeSlot(id, ANSWER),
      );
    const [, , , ...contenders] = await Promise.all([
      ...returning,
      ...competing,
    ]);
    assert.ok(contenders.every((o) => o === "TAKEN" || o === "CAP"));
    // Whatever interleaving happened, the counter equals the slots actually held and stays <= 10.
    assert.equal(await counter(owner), await held(owner));
    assert.ok((await counter(owner)) <= 10);
    // A finished run does not give its slot back twice.
    await postgresDiscoveryStore(pools[0]!).finish(taken[0]!, {
      state: "FAILED",
    });
    assert.equal(await counter(owner), await held(owner));
    // An unknown outcome ends the run but keeps its slot counted.
    const before = await counter(owner);
    await postgresDiscoveryStore(pools[1]!).finish(taken[5]!, {
      state: "MANUAL_REVIEW",
      keepSlot: true,
    });
    assert.equal(await counter(owner), before);
    assert.equal(await counter(owner), await held(owner));
  });
});

test("the worker role reads only what the research jobs need", async () => {
  await withDatabase(async ({ owner, workerPool }) => {
    const worker = workerPool();
    for (const sql of [
      "SELECT * FROM forecasts.submissions",
      "SELECT * FROM forecasts.snapshots",
      "SELECT reason FROM markets.approvals",
      "SELECT submission_id FROM forecasts.model_runs",
      "UPDATE discovery.scan_runs SET source_id=source_id",
    ])
      await assert.rejects(worker.query(sql), /permission denied/, sql);
    await worker.query(
      "SELECT candidate_id,deployment_id,spec_hash,budget_micros,created_at FROM markets.approvals",
    );
    await worker.query(
      "SELECT agent_id,window_id,state FROM forecasts.model_runs",
    );
    // Pending forecast answers: the worker stores and clears its own, nobody else sees them.
    await worker.query("SELECT run_id,answer FROM forecasts.pending_answers");
    await assert.rejects(
      worker.query("UPDATE forecasts.pending_answers SET answer='{}'"),
      /permission denied/,
    );
    for (const role of ["blink_api", "blink_indexer"])
      assert.equal(
        (
          await owner.query(
            "SELECT has_table_privilege($1,'forecasts.pending_answers','SELECT') AS allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
        role,
      );
  });
});
