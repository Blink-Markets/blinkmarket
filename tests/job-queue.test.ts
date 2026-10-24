import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  assertJobsMigrationInstalled,
  assertWorkerRuntimeRole,
  enqueueJobInTransaction,
  postgresJobQueue,
} from "../packages/adapters/src/job-queue.js";
import { dispatchOutbox } from "../packages/adapters/src/outbox-dispatcher.js";
import { retryDelayMs } from "../packages/domain/src/jobs.js";
import { migratedPglite } from "./helpers/serial-pglite-pool.js";

async function withQueue(
  run: (
    s: Awaited<ReturnType<typeof migratedPglite>>,
    queue: ReturnType<typeof postgresJobQueue>,
  ) => Promise<void>,
) {
  const s = await migratedPglite();
  try {
    await run(s, postgresJobQueue(s.pool));
  } finally {
    await s.db.close();
  }
}

const fetchJob = (dedupeKey: string, extra = {}) => ({
  type: "forecast.schedule" as const,
  dedupeKey,
  payload: { sourceId: dedupeKey },
  ...extra,
});

test("retryDelayMs doubles from the base and is capped", () => {
  assert.equal(retryDelayMs(1), 5000);
  assert.equal(retryDelayMs(2), 10000);
  assert.equal(retryDelayMs(3), 20000);
  assert.equal(retryDelayMs(30), 300000);
  assert.equal(retryDelayMs(2, 100, 150), 150);
  assert.equal(retryDelayMs(3, 100, 1000), 400);
});

test("the worker accepts only a plain blink_worker login and an installed migration", () =>
  withQueue(async (s) => {
    // SET ROLE under the owner is impersonation, not a service login.
    await assert.rejects(
      assertWorkerRuntimeRole(s.pool),
      /UNSAFE_WORKER_DATABASE_ROLE/,
    );
    await assertJobsMigrationInstalled(s.pool);
    for (const role of ["blink_api", "blink_indexer"]) {
      await s.db.exec(`SET ROLE ${role}`);
      await assert.rejects(
        assertWorkerRuntimeRole(s.pool),
        /UNSAFE_WORKER_DATABASE_ROLE/,
        role,
      );
    }
    await s.db.exec("RESET ROLE");
    await assert.rejects(
      assertWorkerRuntimeRole(s.pool),
      /UNSAFE_WORKER_DATABASE_ROLE/,
      "the owner login is refused",
    );
    const bare = new PGlite();
    try {
      await assert.rejects(
        assertJobsMigrationInstalled({
          query: (sql: string) => bare.query(sql),
        } as never),
        /JOBS_BUDGETS_MIGRATION_REQUIRED/,
      );
    } finally {
      await bare.close();
    }
  }));

test("enqueue dedupes by key and returns the existing job", () =>
  withQueue(async (_s, queue) => {
    const first = await queue.enqueue(fetchJob("same"));
    assert.equal(first.created, true);
    const second = await queue.enqueue({
      ...fetchJob("same"),
      payload: { ignored: true },
    });
    assert.deepEqual(second, { jobId: first.jobId, created: false });
    assert.deepEqual(await queue.stats(), { queued: 1, leased: 0, dead: 0 });
  }));

test("lease takes due jobs in run order, skips future and other types", () =>
  withQueue(async (_s, queue) => {
    const now = Date.now();
    const later = await queue.enqueue(
      fetchJob("later", { runAt: new Date(now - 1000) }),
    );
    const earlier = await queue.enqueue(
      fetchJob("earlier", { runAt: new Date(now - 5000) }),
    );
    await queue.enqueue(fetchJob("future", { runAt: new Date(now + 60_000) }));
    await queue.enqueue({
      type: "evaluation.score",
      dedupeKey: "other-type",
      payload: {},
      runAt: new Date(now - 9000),
    });
    const types = ["forecast.schedule"] as const;
    const first = await queue.lease("w1", types, 60_000);
    const second = await queue.lease("w1", types, 60_000);
    assert.equal(first?.id, earlier.jobId);
    assert.equal(second?.id, later.jobId);
    assert.equal(await queue.lease("w1", types, 60_000), null);
    assert.deepEqual(first, {
      id: earlier.jobId,
      type: "forecast.schedule",
      payload: { sourceId: "earlier" },
      attempt: 1,
      maxAttempts: 3,
      leaseToken: first!.leaseToken,
      workerId: "w1",
    });
    assert.equal((await queue.stats()).leased, 2);
  }));

test("a stale token cannot complete, and an expired lease is re-leased with a new token", () =>
  withQueue(async (s, queue) => {
    const { jobId } = await queue.enqueue(fetchJob("expiring"));
    const a = (await queue.lease("worker-a", ["forecast.schedule"], 60_000))!;
    assert.equal(
      await queue.lease("worker-b", ["forecast.schedule"], 60_000),
      null,
    );
    await s.advanceClock(61);
    const b = (await queue.lease("worker-b", ["forecast.schedule"], 60_000))!;
    assert.equal(b.id, jobId);
    assert.equal(b.attempt, 2);
    assert.equal(b.workerId, "worker-b");
    assert.equal(BigInt(b.leaseToken), BigInt(a.leaseToken) + 1n);
    assert.equal(await queue.complete(a), false);
    assert.equal(await queue.heartbeat(a, 60_000), false);
    assert.equal(
      await queue.fail(a, { code: "LATE", retryable: true }),
      "STALE",
    );
    assert.equal(await queue.heartbeat(b, 60_000), true);
    assert.equal(await queue.complete(b), true);
    assert.equal(await queue.complete(b), false);
    const row = (
      await s.pool.query(
        "SELECT state, lease_owner, lease_until, finished_at FROM operations.jobs WHERE id=$1",
        [jobId],
      )
    ).rows[0];
    assert.equal(row.state, "SUCCEEDED");
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_until, null);
    assert.notEqual(row.finished_at, null);
  }));

test("a lapsed lease cannot be acknowledged even before anyone re-leases it", () =>
  withQueue(async (s, queue) => {
    await queue.enqueue(fetchJob("lapsed"));
    const job = (await queue.lease("w", ["forecast.schedule"], 60_000))!;
    await s.advanceClock(61);
    assert.equal(await queue.heartbeat(job, 60_000), false);
    assert.equal(await queue.complete(job), false);
    assert.equal(
      await queue.fail(job, { code: "X", retryable: true }),
      "STALE",
    );
  }));

test("heartbeat extends the lease so nobody else can take the job", () =>
  withQueue(async (s, queue) => {
    await queue.enqueue(fetchJob("beating"));
    const job = (await queue.lease("w1", ["forecast.schedule"], 60_000))!;
    await s.advanceClock(50);
    assert.equal(await queue.heartbeat(job, 60_000), true);
    await s.advanceClock(100);
    assert.equal(await queue.lease("w2", ["forecast.schedule"], 60_000), null);
    assert.equal(await queue.complete(job), true);
  }));

test("fail requeues a retryable job with backoff, then dead-letters it with an audit row", () =>
  withQueue(async (s, queue) => {
    const { jobId } = await queue.enqueue(
      fetchJob("flaky", { maxAttempts: 2 }),
    );
    const first = (await queue.lease("w", ["forecast.schedule"], 60_000))!;
    assert.equal(
      await queue.fail(first, { code: "UPSTREAM_TIMEOUT", retryable: true }),
      "RETRY",
    );
    const requeued = (
      await s.pool.query(
        `SELECT state, last_error_code, lease_owner,
                extract(epoch FROM next_run_at - blink.now())::float8 AS delay
         FROM operations.jobs WHERE id=$1`,
        [jobId],
      )
    ).rows[0];
    assert.equal(requeued.state, "QUEUED");
    assert.equal(requeued.last_error_code, "UPSTREAM_TIMEOUT");
    assert.equal(requeued.lease_owner, null);
    assert.ok(
      requeued.delay > 4 && requeued.delay <= 5,
      String(requeued.delay),
    );
    assert.equal(await queue.lease("w", ["forecast.schedule"], 60_000), null);
    await s.advanceClock(6);
    const second = (await queue.lease("w", ["forecast.schedule"], 60_000))!;
    assert.equal(second.attempt, 2);
    assert.equal(
      await queue.fail(second, { code: "UPSTREAM_TIMEOUT", retryable: true }),
      "DEAD",
    );
    const dead = (
      await s.pool.query(
        "SELECT state, finished_at FROM operations.jobs WHERE id=$1",
        [jobId],
      )
    ).rows[0];
    assert.equal(dead.state, "DEAD");
    assert.notEqual(dead.finished_at, null);
    const audit = (
      await s.pool.query(
        "SELECT actor, action, reason FROM operations.audit_log WHERE resource=$1",
        [jobId],
      )
    ).rows;
    assert.deepEqual(audit, [
      { actor: "worker", action: "job.dead", reason: "UPSTREAM_TIMEOUT" },
    ]);
    assert.deepEqual(await queue.stats(), { queued: 0, leased: 0, dead: 1 });
  }));

test("a non-retryable failure is dead-lettered on the first attempt", () =>
  withQueue(async (s, queue) => {
    const { jobId } = await queue.enqueue(fetchJob("hopeless"));
    const job = (await queue.lease("w", ["forecast.schedule"], 60_000))!;
    assert.equal(
      await queue.fail(job, { code: "SOURCE_REJECTED", retryable: false }),
      "DEAD",
    );
    const audit = await s.pool.query(
      "SELECT reason FROM operations.audit_log WHERE resource=$1",
      [jobId],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].reason, "SOURCE_REJECTED");
  }));

test("a job whose lease keeps expiring is dead-lettered once attempts are spent", () =>
  withQueue(async (s, queue) => {
    const { jobId } = await queue.enqueue(
      fetchJob("crash-loop", { maxAttempts: 1 }),
    );
    await queue.lease("crashing", ["forecast.schedule"], 60_000);
    await s.advanceClock(61);
    assert.equal(await queue.lease("w2", ["forecast.schedule"], 60_000), null);
    const row = (
      await s.pool.query(
        "SELECT state, last_error_code FROM operations.jobs WHERE id=$1",
        [jobId],
      )
    ).rows[0];
    assert.deepEqual(row, { state: "DEAD", last_error_code: "LEASE_EXPIRED" });
    const audit = await s.pool.query(
      "SELECT reason FROM operations.audit_log WHERE resource=$1 AND action='job.dead'",
      [jobId],
    );
    assert.equal(audit.rows.length, 1);
  }));

test("enqueueJobInTransaction commits and rolls back with the caller's transaction", () =>
  withQueue(async (s) => {
    const count = async () =>
      Number(
        (await s.pool.query("SELECT count(*)::int AS n FROM operations.jobs"))
          .rows[0].n,
      );
    const rolledBack = await s.pool.connect();
    await rolledBack.query("BEGIN");
    const created = await enqueueJobInTransaction(rolledBack, fetchJob("tx-a"));
    assert.equal(created.created, true);
    await rolledBack.query("ROLLBACK");
    rolledBack.release();
    assert.equal(await count(), 0);

    const committed = await s.pool.connect();
    await committed.query("BEGIN");
    const first = await enqueueJobInTransaction(committed, fetchJob("tx-b"));
    const again = await enqueueJobInTransaction(committed, fetchJob("tx-b"));
    await committed.query("COMMIT");
    committed.release();
    assert.deepEqual(again, { jobId: first.jobId, created: false });
    assert.equal(await count(), 1);
  }));

test("the outbox dispatcher creates mapped jobs once and marks unmapped events dispatched", () =>
  withQueue(async (s) => {
    const mapped = randomUUID();
    const unmapped = randomUUID();
    await s.asOwner(() =>
      s.db.query(
        `INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload)
         VALUES ($1,'market.creation_requested','intent-1',1,'{"marketHint":"m"}'),
                ($2,'something.else','agg-2',1,'{}')`,
        [mapped, unmapped],
      ),
    );
    const seen: string[] = [];
    const mapping = {
      "market.creation_requested": (event: {
        id: string;
        type: string;
        aggregateId: string;
        payload: Record<string, unknown>;
      }) => {
        seen.push(event.id);
        assert.equal(event.aggregateId, "intent-1");
        assert.deepEqual(event.payload, { marketHint: "m" });
        return [
          {
            type: "operations.prune" as const,
            dedupeKey: "ignored-in-favour-of-outbox-key",
            payload: { intent: event.aggregateId },
          },
        ];
      },
    };
    assert.equal(await dispatchOutbox(s.pool, mapping), 2);
    assert.equal(await dispatchOutbox(s.pool, mapping), 0);
    const jobs = (
      await s.pool.query(
        "SELECT type, dedupe_key, outbox_id, payload FROM operations.jobs",
      )
    ).rows;
    assert.deepEqual(jobs, [
      {
        type: "operations.prune",
        dedupe_key: `outbox:${mapped}:operations.prune`,
        outbox_id: mapped,
        payload: { intent: "intent-1" },
      },
    ]);
    const pending = await s.pool.query(
      "SELECT id FROM operations.outbox WHERE dispatched_at IS NULL",
    );
    assert.equal(pending.rows.length, 0);
    // Even if the dispatched mark were lost, the dedupe key keeps the job unique.
    await s.asOwner(() =>
      s.db.query("UPDATE operations.outbox SET dispatched_at=NULL"),
    );
    assert.equal(await dispatchOutbox(s.pool, mapping), 2);
    assert.equal(
      (await s.pool.query("SELECT id FROM operations.jobs")).rows.length,
      1,
    );
    assert.equal(seen.length, 2);
  }));

test("a failing mapping rolls the whole dispatch batch back", () =>
  withQueue(async (s) => {
    await s.asOwner(() =>
      s.db.query(
        `INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload)
         VALUES ($1,'ok.event','a',1,'{}'),($2,'bad.event','b',1,'{}')`,
        [randomUUID(), randomUUID()],
      ),
    );
    await assert.rejects(
      dispatchOutbox(s.pool, {
        "ok.event": () => [fetchJob("from-ok")],
        "bad.event": () => {
          throw new Error("MAPPING_BUG");
        },
      }),
      /MAPPING_BUG/,
    );
    assert.equal(
      (await s.pool.query("SELECT id FROM operations.jobs")).rows.length,
      0,
    );
    assert.equal(
      (
        await s.pool.query(
          "SELECT id FROM operations.outbox WHERE dispatched_at IS NULL",
        )
      ).rows.length,
      2,
    );
  }));

test("jobs accept up to 20 max attempts and reject more", () =>
  withQueue(async (s) => {
    const db = await s.pool.connect();
    try {
      const ok = await enqueueJobInTransaction(
        db,
        fetchJob("max-20", { maxAttempts: 20 }),
      );
      assert.equal(ok.created, true);
      await assert.rejects(
        enqueueJobInTransaction(db, fetchJob("max-21", { maxAttempts: 21 })),
        (error: { code?: string }) => error.code === "23514",
      );
    } finally {
      db.release();
    }
  }));
