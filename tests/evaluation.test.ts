import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createEvaluationHandler,
  scoreWindow,
} from "../packages/application/src/evaluation.ts";
import { postgresEvaluationStore } from "../packages/adapters/src/evaluation-store.ts";
import { seedReadMarket } from "./helpers/protocol-index.ts";
import {
  DEPLOYMENT,
  FORECASTERS,
  forecastFixture,
  market,
  proposal,
  type ForecastFixture,
} from "./helpers/forecast-fixture.ts";

const { a, b, c } = FORECASTERS;
const who = (f: ForecastFixture) => ({
  a: { agent: f.agents.a, address: a.address },
  b: { agent: f.agents.b, address: b.address },
  c: { agent: f.agents.c, address: c.address },
});

/** A FINAL market in the index (the reader the handler uses, and the projection the metrics join). */
async function finalMarket(
  f: ForecastFixture,
  id: number,
  patch: { replay?: boolean; outcome?: "YES" | "NO" | "INVALID" } = {},
) {
  const outcome = patch.outcome ?? "YES";
  const replay = patch.replay ?? false;
  f.reader.set({
    markets: [
      ...(await f.reader.markets({ limit: 100 })).items.filter(
        (m) => m.marketId !== String(id),
      ),
      market(id, { state: "FINAL", finalOutcome: outcome, replay }),
    ],
  });
  await f.asOwner(() =>
    seedReadMarket(f.t.db, DEPLOYMENT, id, {
      state: "FINAL",
      finalOutcome: outcome,
      replay,
      closeAt: 1,
    }),
  );
}
const scorer = (f: ForecastFixture) =>
  createEvaluationHandler({
    store: postgresEvaluationStore(f.t.pool, DEPLOYMENT),
    reader: f.reader,
    deploymentId: DEPLOYMENT,
  });
const runScoring = (f: ForecastFixture) =>
  f.asWorker(() =>
    scorer(f)({
      job: {
        id: randomUUID(),
        type: "evaluation.score",
        payload: {},
        attempt: 1,
        maxAttempts: 3,
        leaseToken: "1",
        workerId: "test",
      },
      signal: new AbortController().signal,
    }),
  );
const entries = (f: ForecastFixture) =>
  f.asOwner(async () =>
    (
      await f.t.db.query<{
        scorer: string;
        forecaster: string | null;
        brier: string | null;
        missing: boolean;
        contaminated: boolean;
        mode: string;
        window_id: string;
      }>(
        `SELECT scorer,'0x'||encode(forecaster,'hex') AS forecaster,brier::text,missing,contaminated,mode,window_id
         FROM analytics.score_entries ORDER BY scorer,forecaster`,
      )
    ).rows.map((r) => ({
      ...r,
      forecaster: r.forecaster?.replace(/^0xnull$/, "") || null,
    })),
  );

test("scoreWindow scores each answer and the consensus exactly", () => {
  const ref = {
    windowId: "w",
    deploymentId: "d",
    marketId: "1",
    mode: "LIVE" as const,
    contaminated: false,
    deadline: 0,
  };
  const out = scoreWindow({
    ...ref,
    outcome: "YES",
    forecasts: [
      { forecaster: "0xa", probabilityBps: 6000, withdrawn: false },
      { forecaster: "0xb", probabilityBps: 8000, withdrawn: false },
      { forecaster: "0xc", probabilityBps: 1000, withdrawn: true },
    ],
    weights: {},
  });
  const by = Object.fromEntries(
    out.map((e) => [e.forecaster ?? "consensus", e]),
  );
  assert.equal(Number(by["0xa"]!.brier), 0.16);
  assert.equal(Number(by["0xb"]!.brier), 0.04);
  // The withdrawn answer is missing: no score, and it is not in the consensus (70%).
  assert.deepEqual([by["0xc"]!.missing, by["0xc"]!.brier], [true, null]);
  assert.equal(Number(by.consensus!.brier), 0.09);
  assert.equal(by.consensus!.scorer, "CONSENSUS");
  // INVALID has no Brier at all.
  const invalid = scoreWindow({
    ...ref,
    outcome: "INVALID",
    forecasts: [{ forecaster: "0xa", probabilityBps: 6000, withdrawn: false }],
    weights: {},
  });
  assert.deepEqual(
    invalid.map((e) => e.brier),
    [null, null],
  );
  // No standing answer, no consensus entry.
  assert.deepEqual(
    scoreWindow({ ...ref, outcome: "NO", forecasts: [], weights: {} }),
    [],
  );
});

test("final windows are scored once, per wallet and for the consensus", async () => {
  const f = await forecastFixture();
  try {
    const w = await f.addWindow(600);
    const p = who(f);
    await f.insertAnswer(w.id, p.a, 6000);
    await f.insertAnswer(w.id, p.b, 8000);
    await f.clock(601);
    // Not final yet: nothing is scored, whatever the answers are.
    await runScoring(f);
    assert.equal((await entries(f)).length, 0);
    await finalMarket(f, 1);
    await runScoring(f);
    await runScoring(f);
    const rows = await entries(f);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.scorer, r.mode, r.contaminated, Number(r.brier)]),
      [
        ["AGENT", "LIVE", false, 0.16],
        ["AGENT", "LIVE", false, 0.04],
        ["CONSENSUS", "LIVE", false, 0.09],
      ],
    );
  } finally {
    await f.close();
  }
});

test("a withdrawn answer is missing, and INVALID scores nothing", async () => {
  const f = await forecastFixture();
  try {
    const p = who(f);
    const w1 = await f.addWindow(600);
    const gone = await f.insertAnswer(w1.id, p.a, 6000);
    await f.insertAnswer(w1.id, p.b, 8000);
    await f.asOwner(() =>
      f.t.db.query(
        "INSERT INTO forecasts.annotations(id,submission_id,kind,reason,actor) VALUES($1,$2,'WITHDRAWN','test','test')",
        [randomUUID(), gone],
      ),
    );
    const w2 = await f.addWindow(600, { marketId: 2 });
    await f.insertAnswer(w2.id, p.a, 6000);
    await f.clock(601);
    await finalMarket(f, 1);
    await finalMarket(f, 2, { outcome: "INVALID" });
    await runScoring(f);
    const rows = await entries(f);
    const of = (id: string) => rows.filter((r) => r.window_id === id);
    assert.deepEqual(
      of(w1.id).map((r) => [
        r.scorer,
        r.missing,
        r.brier === null ? null : Number(r.brier),
      ]),
      [
        ["AGENT", true, null],
        ["AGENT", false, 0.04],
        ["CONSENSUS", false, 0.04],
      ],
    );
    assert.deepEqual(
      of(w2.id).map((r) => [r.scorer, r.brier]),
      [
        ["AGENT", null],
        ["CONSENSUS", null],
      ],
    );
    const credit = await f.store.creditStats([a.address], null);
    assert.equal(
      credit[0]!.n,
      0,
      "a withdrawn answer and an INVALID market earn no credit",
    );
  } finally {
    await f.close();
  }
});

test("contaminated windows are scored but excluded from metrics and credit", async () => {
  const f = await forecastFixture();
  try {
    const p = who(f);
    const w = await f.addWindow(600);
    await f.insertAnswer(w.id, p.a, 6000);
    await f.clock(601);
    await finalMarket(f, 1);
    // The proposal was public before the deadline.
    f.reader.set({ proposals: [proposal(1, ORIGIN_PLUS(100))] });
    await runScoring(f);
    const rows = await entries(f);
    assert.deepEqual(
      rows.map((r) => r.contaminated),
      [true, true],
    );
    await f.asOwner(async () =>
      assert.deepEqual(
        await postgresEvaluationStore(f.t.pool, DEPLOYMENT).metrics("LIVE"),
        {
          eventCount: "0",
          missingCount: "0",
          invalidCount: "0",
          brier: null,
          consensusBrier: null,
        },
      ),
    );
    assert.equal((await f.store.creditStats([a.address], null))[0]!.n, 0);
  } finally {
    await f.close();
  }
});

test("credit stats use the latest 50 scored LIVE answers, frozen as of a time", async () => {
  const f = await forecastFixture();
  try {
    const p = who(f);
    await f.insertAnswer((await f.addWindow(600)).id, p.a, 5000);
    // 52 closed windows, each with an answer of 0.5 for YES (Brier 0.25) scored at the origin.
    await f.asOwner(async () => {
      for (let i = 0; i < 52; i++) {
        const id = randomUUID();
        await f.t.db.query(
          `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
           VALUES($1,$2,1,'DAILY',to_timestamp(1700000000+$3::int*3600),to_timestamp(1700000000+$3::int*3600-1800),to_timestamp(1700000000+$3::int*3600))`,
          [id, DEPLOYMENT, i],
        );
        await f.t.db.query(
          `INSERT INTO analytics.score_entries(id,deployment_id,market_id,window_id,mode,scorer,forecaster,probability_millionths,probability_millionths_times2,outcome,brier,missing,contaminated,evaluation_version)
           VALUES($1,$2,1,$3,'LIVE','AGENT',decode($4,'hex'),500000,1000000,'YES',$5,false,false,'v2')`,
          [
            randomUUID(),
            DEPLOYMENT,
            id,
            p.a.address.slice(2).toLowerCase(),
            i < 2 ? "1" : "0.25",
          ],
        );
      }
    });
    const [now] = await f.store.creditStats([a.address], null);
    // The two oldest (Brier 1) fall out of the latest 50.
    assert.deepEqual([now!.n, Number(now!.brierSum)], [50, 12.5]);
    // Scores recorded after the time asked for do not count.
    assert.equal(
      (await f.store.creditStats([a.address], new Date(1)))[0]?.n ?? 0,
      0,
    );
  } finally {
    await f.close();
  }
});

const ORIGIN_PLUS = (seconds: number) =>
  Math.floor(Date.UTC(2026, 9, 26, 12) / 1000) + seconds;
