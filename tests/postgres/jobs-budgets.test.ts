import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { postgresBudgetLedger } from "../../packages/adapters/src/budget-ledger.js";
import { postgresJobQueue } from "../../packages/adapters/src/job-queue.js";
import { dispatchOutbox } from "../../packages/adapters/src/outbox-dispatcher.js";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { JobError } from "../../packages/domain/src/jobs.js";

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

const reserveInput = (
  questionKey: string,
  maxUsdMicros: bigint,
  cap: bigint,
) => ({
  runId: randomUUID(),
  questionKey,
  questionCapUsdMicros: cap,
  provider: "fixture",
  model: "fixture-model",
  maxUsdMicros,
});

async function race(
  pools: pg.Pool[],
  inputs: ReturnType<typeof reserveInput>[],
) {
  const settled = await Promise.allSettled(
    inputs.map((input, i) =>
      postgresBudgetLedger(pools[i % pools.length]!).reserve(input),
    ),
  );
  const rejected = settled.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  for (const failure of rejected)
    assert.ok(
      failure.reason instanceof JobError &&
        failure.reason.code === "BUDGET_EXHAUSTED",
      String(failure.reason),
    );
  return {
    admitted: settled.length - rejected.length,
    rejected: rejected.length,
  };
}

test(
  "S03: eight sessions race for a day cap that admits five",
  { timeout: 60_000 },
  () =>
    withDatabase(async ({ owner, workerPool }) => {
      await owner.query(
        `INSERT INTO budgets.daily(day,cap_usd_micros)
       VALUES ((blink.now() AT TIME ZONE 'UTC')::date, 5000000)`,
      );
      const pools = Array.from({ length: 8 }, () => workerPool());
      const result = await race(
        pools,
        pools.map((_, i) => reserveInput("race-" + i, 1_000_000n, 1_000_000n)),
      );
      assert.deepEqual(result, { admitted: 5, rejected: 3 });
      const stored = (
        await owner.query(
          "SELECT count(*)::int AS n, sum(max_usd_micros)::text AS total FROM budgets.reservations",
        )
      ).rows[0];
      assert.deepEqual(stored, { n: 5, total: "5000000" });
    }),
);

test(
  "S03: eight sessions race for one question cap that admits four",
  { timeout: 60_000 },
  () =>
    withDatabase(async ({ owner, workerPool }) => {
      const pools = Array.from({ length: 8 }, () => workerPool());
      const result = await race(
        pools,
        pools.map(() => reserveInput("shared", 500_000n, 2_000_000n)),
      );
      assert.deepEqual(result, { admitted: 4, rejected: 4 });
      assert.equal(
        (await owner.query("SELECT count(*)::int AS n FROM budgets.questions"))
          .rows[0].n,
        1,
      );
    }),
);

test(
  "S03: sessions on two business days share one question cap that admits four",
  { timeout: 60_000 },
  () =>
    withDatabase(async ({ workerPool }) => {
      // Half of the sessions run one day ahead, so no daily row serializes them:
      // only the question row lock keeps the shared question under its cap.
      const pools = Array.from({ length: 8 }, (_, i) =>
        workerPool(i % 2 === 0 ? 0 : 86_400),
      );
      const result = await race(
        pools,
        pools.map(() =>
          reserveInput("shared-across-days", 500_000n, 2_000_000n),
        ),
      );
      assert.deepEqual(result, { admitted: 4, rejected: 4 });
    }),
);

test(
  "the first reservations of a new day create one daily row and still honor the default cap",
  { timeout: 60_000 },
  () =>
    withDatabase(async ({ owner, workerPool }) => {
      const pools = Array.from({ length: 12 }, () => workerPool());
      const result = await race(
        pools,
        pools.map((_, i) => reserveInput("day-" + i, 2_000_000n, 2_000_000n)),
      );
      assert.deepEqual(result, { admitted: 10, rejected: 2 });
      assert.equal(
        (await owner.query("SELECT count(*)::int AS n FROM budgets.daily"))
          .rows[0].n,
        1,
      );
    }),
);

test(
  "an overrun closes the gate for sessions that arrive afterwards",
  { timeout: 60_000 },
  () =>
    withDatabase(async ({ workerPool }) => {
      const [a, b] = [workerPool(), workerPool()];
      const ledger = postgresBudgetLedger(a);
      const { reservationId } = await ledger.reserve(
        reserveInput("over", 500_000n, 2_000_000n),
      );
      await ledger.reconcile(reservationId, 600_000n, "req-over");
      await assert.rejects(
        postgresBudgetLedger(b).reserve(reserveInput("other", 1n, 1_000n)),
        (e) => e instanceof JobError && e.code === "BUDGET_GATE_CLOSED",
      );
    }),
);

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
          type: "evidence.fetch",
          dedupeKey: "job-" + i,
          payload: { i },
        });
      const drain = async (pool: pg.Pool, workerId: string) => {
        const mine = postgresJobQueue(pool);
        const ids: string[] = [];
        for (;;) {
          const job = await mine.lease(workerId, ["evidence.fetch"], 60_000);
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
            type: "market.deploy" as const,
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
