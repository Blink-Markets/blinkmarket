import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withDatabase } from "../helpers/postgres-database.js";
import { identityFixture } from "../helpers/identity-fixture.js";
import { fakeProtocolReader } from "../helpers/protocol-reader.js";
import { market } from "../helpers/forecast-fixture.js";
import { postgresForecastStore } from "../../packages/adapters/src/forecast-store.js";
import { createWindowScheduler } from "../../packages/application/src/forecasts.js";
import { forecastLeaf, merkleRoot } from "../../packages/domain/src/index.js";

const DEPLOYMENT = "pg-forecasts";
const HOUR = 3600;
const forecaster = (n: number) => "0x" + n.toString(16).padStart(40, "0");

/**
 * Time in these tests is the database's, moved by a table instead of waited for: blink.now() reads
 * the offset of public.test_clock, so "the deadline passes" is one UPDATE, never a sleep.
 */
async function installTestClock(owner: Pool) {
  await owner.query(`
    CREATE TABLE public.test_clock(offset_seconds double precision NOT NULL);
    INSERT INTO public.test_clock VALUES (0);
    GRANT SELECT ON public.test_clock TO blink_api, blink_worker;
    CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
      SELECT clock_timestamp() + make_interval(secs => (SELECT offset_seconds FROM public.test_clock))
    $$`);
  return {
    advance: (seconds: number) =>
      owner.query(
        "UPDATE public.test_clock SET offset_seconds=offset_seconds+$1",
        [seconds],
      ),
    nowSeconds: async () =>
      Number(
        (
          await owner.query(
            "SELECT floor(extract(epoch FROM blink.now()))::bigint AS now",
          )
        ).rows[0].now,
      ),
  };
}

/** One agent per wallet, as production wallet bindings have it (submissions are unique per window and agent). */
const invite = (owner: Pool) =>
  identityFixture(owner).invite({
    operatorName: "fixture",
    agentName: "fixture",
    scopes: ["forecast:write"],
    reason: "forecast fixture",
  });
type Agent = Awaited<ReturnType<typeof invite>>;
const answer = (agent: Agent, windowId: string, n: number) => ({
  id: randomUUID(),
  windowId,
  keyId: agent.keyId,
  agentId: agent.agentId,
  operatorId: agent.operatorId,
  requestId: randomUUID(),
  forecaster: forecaster(n),
  probabilityBps: 6000,
  contentHash: "0x" + "00".repeat(32),
  digest: "0x" + randomBytes(32).toString("hex"),
  signature: "0x" + "11".repeat(65),
  verifiedBlock: 1n,
});
/** A window that ends `seconds` after the database's now and is open since two hours before its deadline. */
async function windowEndingIn(owner: Pool, seconds: number) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
     SELECT $1,$2,1,'DAILY',d,d-interval '2 hours',d
     FROM (SELECT date_trunc('milliseconds',blink.now())+$3::double precision*interval '1 second' AS d) stamp`,
    [id, DEPLOYMENT, seconds],
  );
  return id;
}

test("real PostgreSQL: a request waiting on the window lock is judged by the clock after it gets the lock", async () => {
  await withDatabase(async ({ owner, login }) => {
    const clock = await installTestClock(owner);
    // One connection, so its backend pid names the waiting request exactly.
    const api = await login({ memberOf: ["blink_api"], max: 1 });
    const store = postgresForecastStore(api, DEPLOYMENT);
    const pid = (await api.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    const [first, second, third] = [
      await invite(owner),
      await invite(owner),
      await invite(owner),
    ];
    const windowId = await windowEndingIn(owner, HOUR);
    assert.equal(
      (await store.submit(answer(first, windowId, 1))).state,
      "ADMITTED",
    );

    const blocker = await owner.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM forecasts.windows WHERE id=$1 FOR UPDATE",
        [windowId],
      );
      // The request starts well before the deadline and waits for the lock...
      const waiting = store.submit(answer(second, windowId, 2));
      let blocked = false;
      for (let i = 0; i < 500 && !blocked; i++) {
        blocked =
          (
            await owner.query(
              "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND wait_event_type='Lock'",
              [pid],
            )
          ).rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(blocked, "the request is waiting on the held row lock");
      // ...and the deadline passes while it waits.
      await clock.advance(2 * HOUR);
      await blocker.query("COMMIT");
      assert.equal((await waiting).state, "CLOSED");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    assert.equal(
      (await store.submit(answer(third, windowId, 3))).state,
      "CLOSED",
    );
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM forecasts.submissions",
        )
      ).rows[0].n,
      1,
    );
  });
});

test("real PostgreSQL: one answer per forecaster per window, even when submitted together", async () => {
  await withDatabase(async ({ owner, login }) => {
    const store = postgresForecastStore(
      await login({ memberOf: ["blink_api"], max: 8 }),
      DEPLOYMENT,
    );
    const agent = await invite(owner);
    const windowId = await windowEndingIn(owner, HOUR);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.submit(answer(agent, windowId, 1))),
    );
    assert.deepEqual(results.map((r) => r.state).sort(), [
      "ADMITTED",
      "DUPLICATE",
      "DUPLICATE",
      "DUPLICATE",
      "DUPLICATE",
      "DUPLICATE",
    ]);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM forecasts.submissions",
        )
      ).rows[0].n,
      1,
    );
  });
});

test("real PostgreSQL: the scheduler opens windows for open markets", async () => {
  await withDatabase(async ({ owner, login }) => {
    const clock = await installTestClock(owner);
    const store = postgresForecastStore(
      await login({ memberOf: ["blink_worker"] }),
      DEPLOYMENT,
    );
    const closeAt = (await clock.nowSeconds()) + 3 * 86400 + 600;
    const reader = fakeProtocolReader({
      markets: [
        market(1, { closeAt }),
        market(2, { state: "PENDING", closeAt }),
      ],
    });
    const scheduler = createWindowScheduler(store, reader);
    assert.ok((await scheduler.scheduleOnce()) >= 4);
    assert.equal(await scheduler.scheduleOnce(), 0);
    assert.equal(
      (
        await owner.query(
          "SELECT 1 FROM forecasts.windows WHERE market_id=2 OR deadline<=blink.now() OR deadline>=to_timestamp($1)",
          [closeAt],
        )
      ).rows.length,
      0,
    );
  });
});

test("real PostgreSQL: the worker stores each root once, over the answers that were not withdrawn", async () => {
  await withDatabase(async ({ owner, login }) => {
    const clock = await installTestClock(owner);
    const worker = await login({ memberOf: ["blink_worker"] });
    const api = await login({ memberOf: ["blink_api"] });
    const store = postgresForecastStore(worker, DEPLOYMENT);
    const apiStore = postgresForecastStore(api, DEPLOYMENT);
    const scheduler = createWindowScheduler(store, fakeProtocolReader());
    const windowId = await windowEndingIn(owner, HOUR);
    const agents = [
      await invite(owner),
      await invite(owner),
      await invite(owner),
    ];
    const answers = agents.map((agent, i) => answer(agent, windowId, i + 1));
    for (const a of answers)
      assert.equal((await apiStore.submit(a)).state, "ADMITTED");
    // Only the key that submitted may withdraw; another agent's key finds nothing.
    assert.equal(
      (
        await apiStore.withdraw(
          answers[2]!.id,
          answers[2]!.forecaster,
          agents[0]!.keyId,
        )
      ).state,
      "NOT_FOUND",
    );
    assert.equal(
      (
        await apiStore.withdraw(
          answers[2]!.id,
          answers[2]!.forecaster,
          agents[2]!.keyId,
        )
      ).state,
      "WITHDRAWN",
    );
    // Not before the deadline.
    assert.equal(
      await store.closeWindow(windowId, () => "0x" + "00".repeat(32)),
      false,
    );
    assert.deepEqual(await store.dueWindows(10), []);
    await clock.advance(2 * HOUR);
    assert.deepEqual(await store.dueWindows(10), [windowId]);
    assert.equal(await scheduler.closeDue(), 1);
    assert.equal(await scheduler.closeDue(), 0);
    const stored = await store.windowById(windowId);
    assert.equal(
      stored!.merkleRoot,
      merkleRoot([answers[0]!.digest, answers[1]!.digest].map(forecastLeaf)),
    );
    // The root cannot move, not even for the owner, and nobody withdraws after the deadline.
    await assert.rejects(
      owner.query("UPDATE forecasts.windows SET merkle_root=NULL WHERE id=$1", [
        windowId,
      ]),
      /append-only/,
    );
    assert.equal(
      (
        await apiStore.withdraw(
          answers[0]!.id,
          answers[0]!.forecaster,
          agents[0]!.keyId,
        )
      ).state,
      "CLOSED",
    );
    // The API cannot set roots, and can only ever write withdrawals.
    await assert.rejects(
      api.query("UPDATE forecasts.windows SET root_at=blink.now()"),
      /permission denied/,
    );
    await assert.rejects(
      api.query(
        "INSERT INTO forecasts.annotations(id,submission_id,kind,reason,actor) VALUES($1,$2,'OUTCOME_ALREADY_PUBLIC','x','x')",
        [randomUUID(), answers[0]!.id],
      ),
      /violates check constraint|permission denied/,
    );
  });
});

test("real PostgreSQL: the worker reads neither digests nor probabilities of an open window", async () => {
  await withDatabase(async ({ owner, login }) => {
    const clock = await installTestClock(owner);
    const worker = await login({ memberOf: ["blink_worker"] });
    const apiStore = postgresForecastStore(
      await login({ memberOf: ["blink_api"] }),
      DEPLOYMENT,
    );
    const agent = await invite(owner);
    const windowId = await windowEndingIn(owner, HOUR);
    const a = answer(agent, windowId, 1);
    assert.equal((await apiStore.submit(a)).state, "ADMITTED");
    // A digest of the zero-content-hash answer reveals its probability: not through the table...
    for (const column of [
      "digest",
      "probability_bps",
      "signature",
      "content_hash",
    ])
      await assert.rejects(
        worker.query(`SELECT ${column} FROM forecasts.submissions`),
        /permission denied/,
        column,
      );
    await assert.rejects(
      worker.query("SELECT * FROM forecasts.submissions"),
      /permission denied/,
    );
    await assert.rejects(
      worker.query("SELECT * FROM forecasts.annotations"),
      /permission denied/,
    );
    // ...and not through a view either, while the window is open.
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
    assert.equal(
      (
        await worker.query(
          "SELECT forecaster_address FROM forecasts.submissions",
        )
      ).rows.length,
      1,
    );
    // After the deadline the view returns the digest.
    await clock.advance(2 * HOUR);
    const closed = await worker.query(
      "SELECT digest,withdrawn FROM forecasts.closed_digests WHERE window_id=$1",
      [windowId],
    );
    assert.deepEqual(closed.rows, [{ digest: a.digest, withdrawn: false }]);
  });
});

test("real PostgreSQL: the manual annotation role and the evidence records are gone", async () => {
  await withDatabase(async ({ owner }) => {
    assert.equal(
      (
        await owner.query(
          "SELECT 1 FROM pg_roles WHERE rolname='blink_forecast_admin'",
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (await owner.query("SELECT 1 FROM pg_namespace WHERE nspname='evidence'"))
        .rows.length,
      0,
    );
  });
});
