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
const forecaster = (n: number) => "0x" + n.toString(16).padStart(40, "0");

async function invite(owner: Pool) {
  return identityFixture(owner).invite({
    operatorName: "fixture",
    agentName: "fixture",
    scopes: ["forecast:write"],
    reason: "forecast fixture",
  });
}
const answer = (
  agent: Awaited<ReturnType<typeof invite>>,
  windowId: string,
  n: number,
) => ({
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
/** A window that ends `seconds` from the database clock's now, and has been open for a while. */
async function windowEndingIn(owner: Pool, seconds: number) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
     SELECT $1,$2,1,'DAILY',d,d-interval '30 minutes',d
     FROM (SELECT date_trunc('milliseconds',blink.now())+$3::double precision*interval '1 second' AS d) stamp`,
    [id, DEPLOYMENT, seconds],
  );
  return id;
}

test("real PostgreSQL: waiting for a window lock cannot admit a submission after its deadline", async () => {
  await withDatabase(async ({ owner, login }) => {
    const store = postgresForecastStore(
      await login({ memberOf: ["blink_api"], max: 4 }),
      DEPLOYMENT,
    );
    const agent = await invite(owner);
    const windowId = await windowEndingIn(owner, 5);
    const deadline = (
      await owner.query("SELECT deadline FROM forecasts.windows WHERE id=$1", [
        windowId,
      ])
    ).rows[0].deadline as Date;
    assert.deepEqual(
      await store.submit(answer(agent, windowId, 1)).then((r) => r.state),
      "ADMITTED",
    );

    const blocker = await owner.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM forecasts.windows WHERE id=$1 FOR UPDATE",
        [windowId],
      );
      // A second forecaster arrives before the deadline but waits for the lock...
      const waiting = store.submit(answer(agent, windowId, 2));
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked =
          (
            await owner.query(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%forecasts.windows%'",
            )
          ).rows.length > 0;
        if (!blocked) await owner.query("SELECT pg_sleep(0.01)");
      }
      assert.ok(
        blocked,
        "the request reached the held row lock before the deadline",
      );
      assert.equal(
        (
          await owner.query("SELECT blink.now()<$1::timestamptz AS before", [
            deadline,
          ])
        ).rows[0].before,
        true,
      );
      // ...and the deadline passes while it waits.
      await owner.query(
        "SELECT pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-blink.now())))::double precision+0.05)",
        [deadline],
      );
      await blocker.query("COMMIT");
      assert.equal((await waiting).state, "CLOSED");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    assert.equal(
      (await store.submit(answer(agent, windowId, 3))).state,
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
    assert.equal(
      (
        await owner.query(
          "SELECT 1 FROM forecasts.submissions s JOIN forecasts.windows w ON w.id=s.window_id WHERE s.received_at>=w.deadline",
        )
      ).rows.length,
      0,
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
    const windowId = await windowEndingIn(owner, 600);
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

test("real PostgreSQL: the scheduler opens windows for open markets and the worker stores each root once", async () => {
  await withDatabase(async ({ owner, login }) => {
    const worker = await login({ memberOf: ["blink_worker"] });
    const api = await login({ memberOf: ["blink_api"] });
    const store = postgresForecastStore(worker, DEPLOYMENT);
    const closeAt = Math.floor(Date.now() / 1000) + 3 * 86400 + 600;
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

    // Roles: the worker sees digests and who answered, never the probabilities; the API cannot set roots.
    await assert.rejects(
      worker.query("SELECT probability_bps FROM forecasts.submissions"),
      /permission denied/,
    );
    await worker.query(
      "SELECT digest,forecaster_address FROM forecasts.submissions",
    );
    await assert.rejects(
      api.query("UPDATE forecasts.windows SET root_at=blink.now()"),
      /permission denied/,
    );

    // A window that ended: the worker stores the root of its digests (not the withdrawn one), once.
    const agent = await invite(owner);
    const windowId = await windowEndingIn(owner, 1);
    const a1 = answer(agent, windowId, 1);
    const a2 = answer(agent, windowId, 2);
    const a3 = answer(agent, windowId, 3);
    const apiStore = postgresForecastStore(api, DEPLOYMENT);
    for (const a of [a1, a2, a3])
      assert.equal((await apiStore.submit(a)).state, "ADMITTED");
    assert.equal(
      (await apiStore.withdraw(a3.id, a3.forecaster)).state,
      "WITHDRAWN",
    );
    assert.equal(
      await store.closeWindow(windowId, () => "0x" + "00".repeat(32)),
      false,
      "not past its deadline yet",
    );
    await owner.query("SELECT pg_sleep(1.2)");
    assert.deepEqual(await store.dueWindows(10), [windowId]);
    assert.equal(await scheduler.closeDue(), 1);
    assert.equal(await scheduler.closeDue(), 0);
    const stored = await store.windowById(windowId);
    assert.equal(
      stored!.merkleRoot,
      merkleRoot([a1.digest, a2.digest].map(forecastLeaf)),
    );
    // Even the owner cannot move a stored root, and the API cannot withdraw after the deadline.
    await assert.rejects(
      owner.query("UPDATE forecasts.windows SET merkle_root=NULL WHERE id=$1", [
        windowId,
      ]),
      /append-only/,
    );
    assert.equal(
      (await apiStore.withdraw(a1.id, a1.forecaster)).state,
      "CLOSED",
    );
    // The API can only ever write withdrawals.
    await assert.rejects(
      api.query(
        "INSERT INTO forecasts.annotations(id,submission_id,kind,reason,actor) VALUES($1,$2,'OUTCOME_ALREADY_PUBLIC','x','x')",
        [randomUUID(), a1.id],
      ),
      /violates check constraint|permission denied/,
    );
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
