import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  forecastLeaf,
  merkleRoot,
  verifyProof,
} from "../packages/domain/src/index.ts";
import {
  createForecastScheduleHandler,
  ForecastScheduleError,
} from "../packages/application/src/forecasts.ts";
import { createEvaluationHandler } from "../packages/application/src/evaluation.ts";
import { postgresEvaluationStore } from "../packages/adapters/src/evaluation-store.ts";
import { identityFixture } from "./helpers/identity-fixture.ts";
import { seedReadMarket } from "./helpers/protocol-index.ts";
import {
  CLOSE_AT,
  DEPLOYMENT,
  FORECASTERS,
  ORIGIN,
  forecastFixture,
  market,
  proposal,
  roleHolder,
  type ForecastFixture,
} from "./helpers/forecast-fixture.ts";

const { a, b, c } = FORECASTERS;
const windowsOf = (f: ForecastFixture, marketId: number) =>
  f.asOwner(
    async () =>
      (
        await f.t.db.query<{ horizon_type: string; deadline: Date }>(
          "SELECT horizon_type,deadline FROM forecasts.windows WHERE market_id=$1 ORDER BY deadline",
          [marketId],
        )
      ).rows,
  );
const submissionId = async (
  f: ForecastFixture,
  agent: { apiKey: string },
  windowId: string,
  owner: { address: string },
) =>
  (await f.get(`/v1/markets/1/forecasts?windowId=${windowId}`, agent))
    .json()
    .items.find(
      (i: { forecaster: string }) =>
        i.forecaster === owner.address.toLowerCase(),
    ).submissionId as string;

test("scheduler skips PENDING and CANCELLED", async () => {
  const f = await forecastFixture();
  try {
    f.reader.set({
      markets: [
        market(1),
        market(2, { state: "PENDING" }),
        market(3, { state: "CANCELLED" }),
        // Open in the index, but its close is already behind the next window.
        market(4, { closeAt: ORIGIN + 60 }),
        market(5, { state: "FINAL", finalOutcome: "YES" }),
      ],
    });
    const scheduler = f.scheduler();
    assert.equal(await f.asWorker(() => scheduler.scheduleOnce()), 1);
    const open = await windowsOf(f, 1);
    assert.deepEqual(
      open.map((w) => w.horizon_type),
      ["PRE_CLOSE"],
    );
    // The window ends before the market closes, while it is still tradable.
    assert.ok(open[0]!.deadline.getTime() < CLOSE_AT * 1000);
    for (const id of [2, 3, 4, 5])
      assert.deepEqual(await windowsOf(f, id), [], `market ${id}`);
    // Running again adds nothing.
    assert.equal(await f.asWorker(() => scheduler.scheduleOnce()), 0);
  } finally {
    await f.close();
  }
});

test("scheduler follows the configured schedule and pages through every open market", async () => {
  const f = await forecastFixture();
  try {
    const many = Array.from({ length: 120 }, (_, i) => market(i + 1));
    f.reader.set({ markets: many });
    const count = await f.asWorker(() =>
      f.scheduler({ preCloseLeadSeconds: 120, openSeconds: 60 }).scheduleOnce(),
    );
    assert.equal(count, 120);
    const [w] = await windowsOf(f, 120);
    assert.equal(w!.deadline.getTime(), (CLOSE_AT - 120) * 1000);
  } finally {
    await f.close();
  }
});

test("contamination set when proposal precedes deadline", async () => {
  const f = await forecastFixture();
  try {
    const early = await f.addWindow(600);
    const late = await f.addWindow(1200);
    await f.clock(1300);
    const contaminated = async () =>
      (await f.get("/v1/markets/1/consensus"))
        .json()
        .items.map((i: { windowId: string; contaminated: boolean }) => [
          i.windowId,
          i.contaminated,
        ]);
    // No proposal yet: both clean.
    assert.deepEqual(await contaminated(), [
      [early.id, false],
      [late.id, false],
    ]);
    // Proposed between the two deadlines: only the later window saw a public outcome.
    f.reader.set({ proposals: [proposal(1, ORIGIN + 900)] });
    assert.deepEqual(await contaminated(), [
      [early.id, false],
      [late.id, true],
    ]);
    // A proposal exactly at a deadline counts as already public.
    f.reader.set({ proposals: [proposal(1, ORIGIN + 600)] });
    assert.deepEqual(await contaminated(), [
      [early.id, true],
      [late.id, true],
    ]);
  } finally {
    await f.close();
  }
});

test("LIVE and REPLAY scored separately", async () => {
  const f = await forecastFixture();
  try {
    const live = await f.addWindow(600, { marketId: 1 });
    const replay = await f.addWindow(600, { marketId: 2 });
    for (const w of [live, replay]) {
      await f.insertAnswer(
        w.id,
        { agent: f.agents.a, address: a.address },
        8000,
      );
      await f.insertAnswer(
        w.id,
        { agent: f.agents.b, address: b.address },
        6000,
      );
    }
    await f.clock(601);
    f.reader.set({
      markets: [
        market(1, { state: "FINAL", finalOutcome: "YES", replay: false }),
        market(2, { state: "FINAL", finalOutcome: "NO", replay: true }),
      ],
    });
    await f.asOwner(async () => {
      await seedReadMarket(f.t.db, DEPLOYMENT, 1, {
        state: "FINAL",
        finalOutcome: "YES",
        replay: false,
        closeAt: 1,
      });
      await seedReadMarket(f.t.db, DEPLOYMENT, 2, {
        state: "FINAL",
        finalOutcome: "NO",
        replay: true,
        closeAt: 1,
      });
    });
    const store = postgresEvaluationStore(f.t.pool, DEPLOYMENT);
    await f.asWorker(() =>
      createEvaluationHandler({
        store,
        reader: f.reader,
        deploymentId: DEPLOYMENT,
      })({
        job: {
          id: randomUUID(),
          type: "evaluation.score",
          payload: {},
          attempt: 1,
          maxAttempts: 3,
          leaseToken: "1",
          workerId: "t",
        },
        signal: new AbortController().signal,
      }),
    );
    // LIVE (outcome YES): a 0.04, b 0.16 -> mean 0.1 for the one event; consensus 0.7 -> 0.09.
    // REPLAY (outcome NO): a 0.64, b 0.36 -> mean 0.5; consensus 0.7 -> 0.49.
    const live1 = await store.metrics("LIVE");
    const replay1 = await store.metrics("REPLAY");
    assert.deepEqual(
      [live1.eventCount, live1.brier, live1.consensusBrier],
      ["1", 0.1, 0.09],
    );
    assert.deepEqual(
      [replay1.eventCount, replay1.brier, replay1.consensusBrier],
      ["1", 0.5, 0.49],
    );
    // Only LIVE answers build credit.
    const stats = await f.store.creditStats([a.address], null);
    assert.equal(stats[0]!.n, 1);
    assert.ok(Math.abs(Number(stats[0]!.brierSum) - 0.04) < 1e-9);
  } finally {
    await f.close();
  }
});

test("anchor read through ProtocolReader", async () => {
  const f = await forecastFixture();
  try {
    const w = await f.addWindow(600);
    assert.equal((await f.submit(f.agents.a, a, w)).statusCode, 201);
    assert.equal(
      (await f.submit(f.agents.b, b, w, { probabilityBps: 3000 })).statusCode,
      201,
    );
    assert.equal(
      (await f.submit(f.agents.c, c, w, { probabilityBps: 9000 })).statusCode,
      201,
    );
    await f.clock(601);
    assert.equal(await f.asWorker(() => f.scheduler().closeDue()), 1);
    // Closing again does nothing: the root of a window is stored once.
    assert.equal(await f.asWorker(() => f.scheduler().closeDue()), 0);
    const view = (await f.get(`/v1/forecast-windows/${w.id}`)).json();
    const digests = await f.asOwner(async () =>
      (
        await f.t.db.query<{ d: string }>(
          "SELECT '0x'||encode(digest,'hex') AS d FROM forecasts.submissions",
        )
      ).rows.map((r) => r.d),
    );
    const root = merkleRoot(digests.map(forecastLeaf));
    assert.equal(view.root, root);
    assert.equal(view.leaves.length, 3);
    assert.equal(view.anchor, null, "nobody anchored it yet");
    // Anyone anchors the root on-chain; the platform only reads the record through the index.
    const record = {
      root: root!,
      by: a.address.toLowerCase(),
      anchoredAt: ORIGIN + 700,
    };
    f.reader.set({ anchors: [record] });
    assert.deepEqual(
      (await f.get(`/v1/forecast-windows/${w.id}`)).json().anchor,
      record,
    );
    // Every leaf has a proof that verifies against the stored root.
    for (const leaf of view.leaves) {
      const res = await f.get(
        `/v1/forecast-windows/${w.id}/proof?leaf=${leaf}`,
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(verifyProof(res.json().proof, root!, leaf));
    }
    const unknown = await f.get(
      `/v1/forecast-windows/${w.id}/proof?leaf=0x${"11".repeat(32)}`,
    );
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().code, "LEAF_NOT_FOUND");
    // A forecaster may anchor its own single leaf: that leaf is a root of its own.
    assert.equal(merkleRoot([view.leaves[0]]), view.leaves[0]);
  } finally {
    await f.close();
  }
});

test("a window with no answers closes without a root", async () => {
  const f = await forecastFixture();
  try {
    const w = await f.addWindow(600);
    await f.clock(601);
    await f.asWorker(() => f.scheduler().closeDue());
    const view = (await f.get(`/v1/forecast-windows/${w.id}`)).json();
    assert.deepEqual(
      [view.root, view.leaves, view.status],
      [null, [], "CLOSED"],
    );
    assert.equal(typeof view.rootAt, "number");
    const proof = await f.get(
      `/v1/forecast-windows/${w.id}/proof?leaf=0x${"11".repeat(32)}`,
    );
    assert.equal(proof.json().code, "LEAF_NOT_FOUND");
  } finally {
    await f.close();
  }
});

test("withdrawal keeps the answer but drops it from the root and the consensus", async () => {
  const f = await forecastFixture();
  try {
    const w = await f.addWindow(600);
    await f.submit(f.agents.a, a, w, { probabilityBps: 2000 });
    await f.submit(f.agents.b, b, w, { probabilityBps: 4000 });
    const id = await submissionId(f, f.agents.a, w.id, a);
    const withdraw = (agent: { apiKey: string } | null, target = id) =>
      f.app.inject({
        method: "POST",
        url: `/v1/forecasts/${target}/withdrawal`,
        headers: agent ? { authorization: "Bearer " + agent.apiKey } : {},
      });
    // Not someone else's, and not without a key.
    assert.equal((await withdraw(f.agents.b)).statusCode, 404);
    assert.equal((await withdraw(null)).statusCode, 401);
    const first = await withdraw(f.agents.a);
    assert.equal(first.statusCode, 200, first.body);
    const again = await withdraw(f.agents.a);
    assert.deepEqual(again.json(), first.json());
    // Stale index: nothing changes.
    f.reader.set({
      health: { headBlock: 9, indexedBlock: 1, lagSeconds: 900, stale: true },
    });
    assert.equal(
      (await withdraw(f.agents.b, await submissionId(f, f.agents.b, w.id, b)))
        .statusCode,
      503,
    );
    f.reader.set({
      health: { headBlock: 0, indexedBlock: 0, lagSeconds: 0, stale: false },
    });

    await f.clock(601);
    await f.asWorker(() => f.scheduler().closeDue());
    const view = (await f.get(`/v1/forecast-windows/${w.id}`)).json();
    assert.equal(view.leaves.length, 1);
    const items = (
      await f.get(`/v1/markets/1/forecasts?windowId=${w.id}`)
    ).json().items;
    assert.equal(items.length, 2, "withdrawn answers stay listed");
    assert.equal(
      items.filter(
        (i: { withdrawnAt: number | null }) => i.withdrawnAt !== null,
      ).length,
      1,
    );
    const [row] = (await f.get("/v1/markets/1/consensus")).json().items;
    assert.deepEqual([row.probabilityBps, row.submissions], [4000, 1]);
    // After the deadline an answer can no longer be withdrawn.
    const late = await withdraw(
      f.agents.b,
      await submissionId(f, f.agents.b, w.id, b),
    );
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().code, "FORECAST_WINDOW_CLOSED");
  } finally {
    await f.close();
  }
});

test("only the submitting key of a current FORECASTER may withdraw", async () => {
  const f = await forecastFixture();
  try {
    const w = await f.addWindow(600);
    assert.equal((await f.submit(f.agents.a, a, w)).statusCode, 201);
    const id = await submissionId(f, f.agents.a, w.id, a);
    const withdraw = (agent: { apiKey: string }) =>
      f.app.inject({
        method: "POST",
        url: `/v1/forecasts/${id}/withdrawal`,
        headers: { authorization: "Bearer " + agent.apiKey },
      });
    const annotations = async () => (await f.stored()).annotations;
    // A second active key of the same wallet is not the key that submitted.
    const second = await f.asOwner(() =>
      identityFixture(f.t.pool).issue(f.agents.a.agentId, {
        scopes: ["forecast:write"],
        reason: "second key",
      }),
    );
    const other = await withdraw(second);
    assert.equal(other.statusCode, 404, other.body);
    // The wallet lost its FORECASTER role.
    f.reader.set({ accounts: [roleHolder(a.address, [])] });
    const lost = await withdraw(f.agents.a);
    assert.equal(lost.statusCode, 403, lost.body);
    assert.equal(lost.json().code, "ROLE_REQUIRED");
    f.reader.set({ accounts: [roleHolder(a.address)] });
    // The index lags.
    f.reader.set({ health: { headBlock: 9, indexedBlock: 1, lagSeconds: 900, stale: true } });
    const stale = await withdraw(f.agents.a);
    assert.equal(stale.statusCode, 503, stale.body);
    assert.equal(stale.json().code, "INDEX_STALE");
    f.reader.set({ health: { headBlock: 0, indexedBlock: 0, lagSeconds: 0, stale: false } });
    assert.equal(await annotations(), 0, "nothing was stored by any refusal");
    // The submitting key, with the role and a fresh index, withdraws.
    assert.equal((await withdraw(f.agents.a)).statusCode, 200);
    assert.equal(await annotations(), 1);
  } finally {
    await f.close();
  }
});

test("the worker reads neither digests nor probabilities of an open window", async () => {
  const f = await forecastFixture();
  try {
    const w = await f.addWindow(600);
    assert.equal((await f.submit(f.agents.a, a, w)).statusCode, 201);
    const worker = (sql: string) => f.asWorker(() => f.t.db.query(sql));
    // Not through the table: a digest of the zero-content-hash answer would reveal its probability.
    for (const column of ["digest", "probability_bps", "signature", "content_hash"])
      await assert.rejects(worker(`SELECT ${column} FROM forecasts.submissions`), /permission denied/, column);
    await assert.rejects(worker("SELECT * FROM forecasts.submissions"), /permission denied/);
    // Not through the views either, while the window is open.
    assert.equal((await worker("SELECT * FROM forecasts.closed_digests")).rows.length, 0);
    assert.equal((await worker("SELECT * FROM analytics.closed_forecasts")).rows.length, 0);
    // Who answered is visible (credit statistics need it), nothing else.
    assert.equal((await worker("SELECT forecaster_address FROM forecasts.submissions")).rows.length, 1);
    // After the deadline the view lists the digest.
    await f.clock(601);
    const closed = await worker("SELECT window_id,digest,withdrawn FROM forecasts.closed_digests");
    assert.equal(closed.rows.length, 1);
    assert.match((closed.rows[0] as { digest: string }).digest, /^0x[0-9a-f]{64}$/);
  } finally {
    await f.close();
  }
});

test("consensus weights come from scores recorded before the deadline", async () => {
  const f = await forecastFixture();
  try {
    const w = await f.addWindow(600);
    await f.insertAnswer(w.id, { agent: f.agents.a, address: a.address }, 2000);
    await f.insertAnswer(w.id, { agent: f.agents.b, address: b.address }, 8000);
    await f.asOwner(() => seedReadMarket(f.t.db, DEPLOYMENT, 9, { state: "FINAL", finalOutcome: "YES", replay: false }));
    // Five earlier LIVE scores of mean Brier 0.1 give a weight 0.15; b has none.
    await f.asOwner(async () => {
      for (let i = 0; i < 5; i++) {
        const id = randomUUID();
        await f.t.db.query(
          `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
           VALUES($1,$2,9,'DAILY',to_timestamp(1700000000+$3::int*3600),to_timestamp(1700000000+$3::int*3600-1800),to_timestamp(1700000000+$3::int*3600))`,
          [id, DEPLOYMENT, i],
        );
        await f.t.db.query(
          `INSERT INTO analytics.score_entries(id,deployment_id,market_id,window_id,mode,scorer,forecaster,probability_millionths,probability_millionths_times2,outcome,brier,missing,contaminated,evaluation_version)
           VALUES($1,$2,9,$3,'LIVE','AGENT',decode($4,'hex'),500000,1000000,'YES',0.1,false,false,'v2')`,
          [randomUUID(), DEPLOYMENT, id, a.address.slice(2).toLowerCase()],
        );
      }
    });
    await f.clock(601);
    const read = async () =>
      (await f.get("/v1/markets/1/consensus")).json().items[0];
    // Only a carries weight: the consensus is a's answer.
    assert.equal((await read()).probabilityBps, 2000);
    // A score of b recorded after the deadline changes nothing.
    await f.clock(700);
    await f.asOwner(async () => {
      for (let i = 0; i < 5; i++) {
        const id = randomUUID();
        await f.t.db.query(
          `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
           VALUES($1,$2,9,'DAILY',to_timestamp(1800000000+$3::int*3600),to_timestamp(1800000000+$3::int*3600-1800),to_timestamp(1800000000+$3::int*3600))`,
          [id, DEPLOYMENT, i],
        );
        await f.t.db.query(
          `INSERT INTO analytics.score_entries(id,deployment_id,market_id,window_id,mode,scorer,forecaster,probability_millionths,probability_millionths_times2,outcome,brier,missing,contaminated,evaluation_version)
           VALUES($1,$2,9,$3,'LIVE','AGENT',decode($4,'hex'),500000,1000000,'YES',0.0,false,false,'v2')`,
          [randomUUID(), DEPLOYMENT, id, b.address.slice(2).toLowerCase()],
        );
      }
    });
    assert.equal((await read()).probabilityBps, 2000);
    // The forecaster routes show today's credit, highest weight first.
    const list = (await f.get("/v1/forecasters")).json();
    assert.deepEqual(
      list.items.map(
        (i: {
          address: string;
          weightNumerator: string;
          weightDenominator: string;
        }) => [i.address, i.weightNumerator, i.weightDenominator],
      ),
      [
        [b.address.toLowerCase(), "1", "4"],
        [a.address.toLowerCase(), "3", "20"],
      ],
    );
    // Pages are cut by the last address, in the same order.
    const firstPage = (await f.get("/v1/forecasters?limit=1")).json();
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.nextCursor, `1/4:5:${b.address.toLowerCase()}`);
    const secondPage = (
      await f.get(`/v1/forecasters?limit=1&cursor=${firstPage.nextCursor}`)
    ).json();
    assert.deepEqual(
      [secondPage.items[0].address, secondPage.nextCursor],
      [a.address.toLowerCase(), null],
    );
    for (const bad of [
      "0x00",
      a.address.toLowerCase(),
      `1/0:5:${a.address.toLowerCase()}`,
      `01/4:5:${a.address.toLowerCase()}`,
      `1/4:5:${a.address.toUpperCase().replace("0X", "0x")}`,
      `000000000000000000:0000005:${a.address.toLowerCase()}`,
    ])
      assert.equal(
        (await f.get(`/v1/forecasters?cursor=${encodeURIComponent(bad)}`)).statusCode,
        400,
        bad,
      );
    const one = await f.get(`/v1/forecasters/${a.address.toLowerCase()}`);
    assert.deepEqual(one.json(), {
      address: a.address.toLowerCase(),
      n: 5,
      meanBrier: 0.1,
      weightNumerator: "3",
      weightDenominator: "20",
    });
    assert.equal(
      (await f.get(`/v1/forecasters/${c.address.toLowerCase()}`)).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

let scoreClock = 0;
/** `count` more scored LIVE answers of `who`, each with this Brier; they become the latest. */
async function addScores(f: ForecastFixture, who: { address: string }, count: number, brier: string) {
  await f.asOwner(async () => {
    if (!(await f.t.db.query("SELECT 1 FROM protocol.markets WHERE deployment_id=$1 AND key='9'", [DEPLOYMENT])).rows.length)
      await seedReadMarket(f.t.db, DEPLOYMENT, 9, { state: "FINAL", finalOutcome: "YES", replay: false });
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      const at = 1_900_000_000 + 3600 * scoreClock++;
      await f.t.db.query(
        `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
         VALUES($1,$2,9,'DAILY',to_timestamp($3::bigint),to_timestamp($3::bigint-1800),to_timestamp($3::bigint))`,
        [id, DEPLOYMENT, at],
      );
      await f.t.db.query(
        `INSERT INTO analytics.score_entries(id,deployment_id,market_id,window_id,mode,scorer,forecaster,probability_millionths,probability_millionths_times2,outcome,brier,missing,contaminated,evaluation_version)
         VALUES($1,$2,9,$3,'LIVE','AGENT',decode($4,'hex'),500000,1000000,'YES',$5,false,false,'v2')`,
        [randomUUID(), DEPLOYMENT, id, who.address.slice(2).toLowerCase(), brier],
      );
    }
  });
}
/** Every forecaster needs one answer somewhere to be listed. */
async function answered(f: ForecastFixture) {
  const w = await f.addWindow(600, { marketId: 9 });
  await f.insertAnswer(w.id, { agent: f.agents.a, address: a.address }, 5000);
  await f.insertAnswer(w.id, { agent: f.agents.b, address: b.address }, 5000);
  await f.insertAnswer(w.id, { agent: f.agents.c, address: c.address }, 5000);
}
const page = async (f: ForecastFixture, limit: number, cursor?: string) =>
  (
    await f.get(
      `/v1/forecasters?limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    )
  ).json() as { items: { address: string }[]; nextCursor: string | null };
const lower = (x: { address: string }) => x.address.toLowerCase();

test("a forecaster list page resumes after the exact boundary, not after a row that moved", async () => {
  // A (3/20) then B (1/20) then C (1/100): page 1 holds A and B, then B improves past A.
  const f = await forecastFixture();
  try {
    await answered(f);
    await addScores(f, a, 5, "0.1");
    await addScores(f, b, 5, "0.2");
    await addScores(f, c, 5, "0.24");
    const first = await page(f, 2);
    assert.deepEqual(first.items.map((i) => i.address), [lower(a), lower(b)]);
    await addScores(f, b, 45, "0");
    const second = await page(f, 2, first.nextCursor!);
    assert.deepEqual(second.items.map((i) => i.address), [lower(c)], "A is not repeated");
    assert.equal(second.nextCursor, null);
  } finally {
    await f.close();
  }
});

test("a forecaster list page does not skip rows when the boundary row drops to zero weight", async () => {
  const f = await forecastFixture();
  try {
    await answered(f);
    await addScores(f, b, 5, "0");
    await addScores(f, a, 5, "0.1");
    await addScores(f, c, 5, "0.2");
    const first = await page(f, 1);
    assert.deepEqual(first.items.map((i) => i.address), [lower(b)]);
    await addScores(f, b, 50, "1");
    const second = await page(f, 5, first.nextCursor!);
    // A and C are still served; B, now weightless, sorts last.
    assert.deepEqual(second.items.map((i) => i.address), [lower(a), lower(c), lower(b)]);
  } finally {
    await f.close();
  }
});

test("equal weights are split by scored answers, then address, across page boundaries", async () => {
  const f = await forecastFixture();
  try {
    await answered(f);
    // All three weigh 3/20; b has the most scored answers.
    await addScores(f, a, 5, "0.1");
    await addScores(f, b, 10, "0.1");
    await addScores(f, c, 5, "0.1");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const next = await page(f, 1, cursor);
      seen.push(...next.items.map((i) => i.address));
      cursor = next.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, [lower(b), ...[lower(a), lower(c)].sort()]);
  } finally {
    await f.close();
  }
});

test("a role lost while the signature is checked refuses the answer", async () => {
  const f = await forecastFixture();
  try {
    const w = await f.addWindow(600);
    f.hooks.whileVerifying = () => {
      f.reader.set({ accounts: [roleHolder(a.address, [])] });
    };
    const res = await f.submit(f.agents.a, a, w);
    f.hooks.whileVerifying = undefined;
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().code, "ROLE_REQUIRED");
    assert.equal((await f.stored()).submissions, 0);
  } finally {
    await f.close();
  }
});

test("the schedule job opens and closes windows and reports failures as retryable", async () => {
  const calls: string[] = [];
  const handler = createForecastScheduleHandler({
    scheduleOnce: async () => (calls.push("schedule"), 0),
    closeDue: async () => (calls.push("close"), 0),
  });
  const ctx = {
    job: { id: "1", payload: {} },
    signal: new AbortController().signal,
  };
  await handler(ctx);
  assert.deepEqual(calls, ["schedule", "close"]);
  const failing = createForecastScheduleHandler({
    scheduleOnce: async () => {
      throw new Error("db down");
    },
    closeDue: async () => 0,
  });
  await assert.rejects(
    failing(ctx),
    (e: unknown) => e instanceof ForecastScheduleError && e.retryable,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    handler({ ...ctx, signal: aborted.signal }),
    ForecastScheduleError,
  );
});
