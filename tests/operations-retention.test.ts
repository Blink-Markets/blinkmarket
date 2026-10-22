import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pruneOperations } from "../packages/adapters/src/operations-retention.js";
import { migratedPglite } from "./helpers/serial-pglite-pool.js";

type Db = Awaited<ReturnType<typeof migratedPglite>>;

const day = (days: number) => `blink.now()-interval '${days} days'`;

async function job(
  s: Db,
  state: string,
  age: number,
  outboxId: string | null = null,
) {
  const id = randomUUID();
  const finished = state === "SUCCEEDED" || state === "DEAD";
  await s.db.query(
    `INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,outbox_id,created_at,finished_at,lease_owner,lease_until)
     VALUES($1,'evaluation.score',$4,'{}',$2,$3,${day(age)},${finished ? day(age) : "NULL"},
            ${state === "LEASED" ? "'w',blink.now()+interval '1 minute'" : "NULL,NULL"})`,
    [id, state, outboxId, id],
  );
  return id;
}

async function outbox(
  s: Db,
  aggregate: string,
  version: number,
  dispatchedDaysAgo: number | null,
  createdDaysAgo = dispatchedDaysAgo ?? 0,
) {
  const id = randomUUID();
  await s.db.query(
    `INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload,created_at,dispatched_at)
     VALUES($1,'chain.synced',$2,$3,'{}',${day(createdDaysAgo)},${dispatchedDaysAgo === null ? "NULL" : day(dispatchedDaysAgo)})`,
    [id, aggregate, version],
  );
  return id;
}

const remaining = async (s: Db, table: string) =>
  new Set(
    (
      await s.db.query<{ id: string }>(`SELECT id FROM operations.${table}`)
    ).rows.map((r) => r.id),
  );

test("prune deletes succeeded jobs after 7 days and dead jobs after 30, never active ones", async () => {
  const s = await migratedPglite();
  const gone = [await job(s, "SUCCEEDED", 8), await job(s, "DEAD", 31)];
  const kept = [
    await job(s, "SUCCEEDED", 6),
    await job(s, "DEAD", 29),
    await job(s, "QUEUED", 60),
    await job(s, "LEASED", 60),
  ];
  const result = await pruneOperations(s.pool);
  assert.equal(result.jobs, 2);
  const left = await remaining(s, "jobs");
  for (const id of gone) assert.equal(left.has(id), false);
  for (const id of kept) assert.equal(left.has(id), true);
});

test("prune keeps undispatched outbox rows, rows a job references, and the newest event per aggregate and type", async () => {
  const s = await migratedPglite();
  const old = await outbox(s, "agg-a", 1, 31);
  const newest = await outbox(s, "agg-a", 2, 31);
  const referenced = await outbox(s, "agg-b", 1, 31);
  await outbox(s, "agg-b", 2, 31);
  await job(s, "QUEUED", 0, referenced);
  const undispatched = await outbox(s, "agg-c", 1, null, 60);
  await outbox(s, "agg-c", 2, null, 60);
  const recent = await outbox(s, "agg-d", 1, 29);
  await outbox(s, "agg-d", 2, 29);
  const result = await pruneOperations(s.pool);
  assert.equal(result.outbox, 1);
  const left = await remaining(s, "outbox");
  assert.equal(left.has(old), false);
  for (const id of [newest, referenced, undispatched, recent])
    assert.equal(left.has(id), true);
});

test("prune works in bounded batches", async () => {
  const s = await migratedPglite();
  for (let i = 0; i < 5; i++) await job(s, "SUCCEEDED", 8);
  const result = await pruneOperations(s.pool, { batch: 2, maxBatches: 2 });
  assert.equal(result.jobs, 4);
  assert.equal((await remaining(s, "jobs")).size, 1);
});

test("the worker's recovery lookups can use the active-job indexes", async () => {
  const s = await migratedPglite();
  await s.db.exec("SET enable_seqscan = off");
  const id = randomUUID();
  const plan = async (type: string, field: string) =>
    (
      await s.db.query<Record<string, string>>(
        `EXPLAIN SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operations.jobs j WHERE j.type='${type}' AND j.payload->>'${field}'='${id}' AND j.state IN ('QUEUED','LEASED'))`,
      )
    ).rows
      .map((r) => r["QUERY PLAN"])
      .join("\n");
  assert.match(await plan("tx.dispatch", "intentId"), /jobs_active_intent/);
  assert.match(await plan("faucet.mint", "claimId"), /jobs_active_claim/);
});
