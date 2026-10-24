import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase, inviteAgent } from "./helpers/database.js";
import { postgresEvaluationStore } from "../packages/adapters/src/evaluation-store.js";
import { createEvaluationHandler } from "../packages/application/src/evaluation.js";

async function setup() {
  const t = await createTestDatabase();
  const agents: Awaited<ReturnType<typeof inviteAgent>>[] = [];
  for (const name of ["A", "B", "C", "D"])
    agents.push(await inviteAgent(t, { name, scopes: ["forecast:write"] }));
  await t.db.exec(
    "INSERT INTO markets.deployments(id,manifest,market_address) VALUES('test','{}',decode(repeat('11',20),'hex'))",
  );
  async function market(
    id: number,
    mode = "REPLAY",
    outcome = "YES",
    state = "FINAL",
  ) {
    await t.db.query(
      `INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,final_outcome,created_block_number,created_tx_hash,as_of_block_hash)
      VALUES('test',$1::integer,decode(lpad(to_hex($1::integer),64,'0'),'hex'),'fixture',$2,1,2,3,1,100,100,$4,$3,1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'))`,
      [id, mode, outcome, state],
    );
  }
  let windowSequence = 0;
  async function window(
    marketId: number,
    probabilities: (string | null)[],
    annotations: Record<number, string> = {},
  ) {
    const id = randomUUID();
    await t.db.query(
      `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
      SELECT $1,'test',$2,'DAILY',d,d-interval '30 minutes',d FROM (SELECT '2020-01-01'::timestamptz + $3::integer * interval '1 hour' AS d) clock`,
      [id, marketId, windowSequence++],
    );
    for (let i = 0; i < probabilities.length; i++) {
      if (probabilities[i] === null) continue;
      const submission = randomUUID(),
        agent = agents[i]!;
      await t.db.query(
        `INSERT INTO forecasts.submissions(id,window_id,agent_id,operator_id,key_id,probability,evidence_ids,rationale,agent_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,'fixture','v1')`,
        [
          submission,
          id,
          agent.agentId,
          agent.operatorId,
          agent.keyId,
          probabilities[i],
          [randomUUID()],
        ],
      );
      if (annotations[i])
        await t.db.query(
          `INSERT INTO forecasts.annotations(id,submission_id,kind,reason,actor) VALUES($1,$2,$3,'fixture','fixture')`,
          [randomUUID(), submission, annotations[i]],
        );
    }
    return id;
  }
  const store = postgresEvaluationStore(t.pool);
  const score = () =>
    createEvaluationHandler(store)({
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
    });
  return { t, agents, market, window, store, score };
}

test("evaluation scores final windows once, separates withdrawn, contaminated and INVALID entries per agent", async () => {
  const s = await setup();
  try {
    await s.market(1);
    const good = await s.window(1, ["0.6", "0.600001", "0.5", "0.123457"]);
    const partial = await s.window(1, ["0.6", null]);
    const contaminated = await s.window(1, ["0.6", "0.7"], {
      0: "OUTCOME_ALREADY_PUBLIC",
    });
    const withdrawn = await s.window(1, ["0.6", "0.7", "0.5", "0.4"], {
      1: "WITHDRAWN",
      2: "WITHDRAWN",
      3: "WINDOW_CONTAMINATED",
    });
    await s.market(2, "LIVE", "INVALID");
    await s.window(2, ["0.6", "0.7", "0.5", "0.4"]);
    await s.market(3, "LIVE", "YES", "OPEN");
    await s.window(3, ["0.6", "0.7"]);
    await s.t.setRole("blink_worker");
    await assert.rejects(
      s.t.db.query("SELECT * FROM forecasts.submissions"),
      /permission denied/,
    );
    await s.score();
    const rows = (
      await s.t.db.query<Record<string, unknown>>(
        "SELECT *, brier::text AS exact FROM analytics.score_entries ORDER BY id",
      )
    ).rows;
    assert.equal(rows.length, 15);
    assert.ok(rows.every((r) => r.scorer === "AGENT"));
    const entry = (window: string, agent: number) =>
      rows.find(
        (r) =>
          r.window_id === window && r.agent_id === s.agents[agent]!.agentId,
      )!;
    assert.equal(entry(good, 0).exact, "0.16");
    assert.equal(entry(good, 0).probability_millionths, 600000);
    assert.equal(entry(good, 1).exact, "0.159999200001");
    assert.equal(entry(good, 2).exact, "0.25");
    assert.equal(entry(good, 3).exact, "0.768327630849");
    assert.equal(entry(good, 3).probability_millionths, 123457);
    // An agent that did not submit has no entry: nothing is invented for it.
    assert.equal(rows.filter((r) => r.window_id === partial).length, 1);
    assert.equal(entry(partial, 0).missing, false);
    assert.equal(entry(contaminated, 0).contaminated, true);
    assert.equal(entry(contaminated, 1).contaminated, false);
    assert.equal(entry(withdrawn, 0).contaminated, false);
    assert.equal(entry(withdrawn, 1).missing, true);
    assert.equal(entry(withdrawn, 1).brier, null);
    assert.equal(entry(withdrawn, 1).probability_millionths_times2, null);
    assert.equal(entry(withdrawn, 3).missing, false);
    assert.equal(entry(withdrawn, 3).contaminated, true);
    assert.ok(
      rows
        .filter((r) => r.outcome === "INVALID")
        .every((r) => r.brier === null),
    );
    assert.equal(rows.filter((r) => r.outcome === "INVALID").length, 4);
    await s.score();
    assert.deepEqual(
      (
        await s.t.db.query(
          "SELECT *, brier::text AS exact FROM analytics.score_entries ORDER BY id",
        )
      ).rows,
      rows,
    );
    await assert.rejects(
      s.t.db.exec("UPDATE analytics.score_entries SET missing=true"),
      /permission denied/,
    );
    await s.t.setRole(null);
    await assert.rejects(
      s.t.db.exec("DELETE FROM analytics.score_entries"),
      /append-only/,
    );
    await s.t.setRole("blink_api");
    await assert.rejects(
      s.t.db.exec(
        "INSERT INTO analytics.score_entries SELECT * FROM analytics.score_entries",
      ),
      /permission denied/,
    );
  } finally {
    await s.t.close();
  }
});

test("public metrics weight each market equally across its agent entries and isolate mode", async () => {
  const { createMetricsService } =
    await import("../packages/application/src/evaluation.js");
  const { buildApi } = await import("../apps/api/src/server.js");
  const { apiContracts } = await import("../packages/schemas/src/index.ts");
  const s = await setup();
  const app = buildApi({
    services: [createMetricsService({ store: s.store })],
  });
  try {
    await s.market(1);
    await s.window(1, ["0.5", "0.5"]);
    await s.window(1, ["0.5", "0.5"]);
    await s.window(1, ["0.9", "0.9"], { 0: "WINDOW_CONTAMINATED" });
    await s.market(2);
    for (let i = 0; i < 3; i++) await s.window(2, ["0.8", "0.8"]);
    await s.market(3);
    await s.window(3, ["0.8", "0.8"], { 1: "WITHDRAWN" });
    await s.market(4, "REPLAY", "INVALID"); // Count even without windows.
    await s.market(5, "LIVE");
    await s.window(5, ["0", "0"]);
    await s.t.setRole("blink_worker");
    await s.score();
    await s.t.setRole("blink_api");
    const replay = await app.inject({ url: "/v1/metrics?mode=REPLAY" });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.headers["cache-control"], "public, max-age=60");
    assert.deepEqual(replay.json(), {
      mode: "REPLAY",
      eventCount: "3",
      missingCount: "1",
      invalidCount: "1",
      brier: 0.094,
    });
    apiContracts
      .find((c) => c.path === "/v1/metrics")!
      .response.parse(replay.json());
    const live = (await app.inject({ url: "/v1/metrics?mode=LIVE" })).json();
    assert.equal(live.eventCount, "1");
    assert.equal(live.brier, 1);
    assert.equal(live.missingCount, "0");
    assert.equal(live.invalidCount, "0");
    assert.equal(
      (await app.inject({ url: "/v1/metrics?mode=OTHER" })).statusCode,
      400,
    );
    assert.equal((await app.inject({ url: "/v1/metrics" })).statusCode, 400);
  } finally {
    await app.close();
    await s.t.close();
  }
});

test("metrics return null without eligible events and round the exact mean to six decimals", async () => {
  const s = await setup();
  try {
    assert.deepEqual(await s.store.metrics("LIVE"), {
      eventCount: "0",
      missingCount: "0",
      invalidCount: "0",
      brier: null,
    });
    await s.market(1, "LIVE", "NO");
    await s.window(1, ["0.123457", "0.123457"]);
    await s.t.setRole("blink_worker");
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(s.store.scoreFinalWindows(() => [], cancelled.signal));
    await s.score();
    await s.t.setRole("blink_api");
    assert.equal((await s.store.metrics("LIVE")).brier, 0.015242);
    assert.equal((await s.store.metrics("REPLAY")).brier, null);
  } finally {
    await s.t.close();
  }
});

test("worker registration scores indexed markets and schedules once per ten-minute DB-clock bucket", async () => {
  const {
    handlers,
    outboxMapping,
    registerEvaluationHandler,
    scheduleEvaluation,
  } = await import("../apps/worker/src/handlers.js");
  const { dispatchOutbox } =
    await import("../packages/adapters/src/outbox-dispatcher.js");
  const { postgresJobQueue } =
    await import("../packages/adapters/src/job-queue.js");
  const s = await setup();
  try {
    await s.market(1);
    await s.window(1, ["0.7", "0.7"]);
    await s.t.db.query(
      "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,'market.indexed','1',1,$2)",
      [randomUUID(), { deploymentId: "test", marketId: "1", state: "FINAL" }],
    );
    await s.t.setRole("blink_worker");
    registerEvaluationHandler(s.t.pool);
    await dispatchOutbox(s.t.pool, outboxMapping);
    const queue = postgresJobQueue(s.t.pool);
    const job = await queue.lease("test", ["evaluation.score"], 60000);
    assert.ok(job);
    await handlers["evaluation.score"]!({
      job,
      signal: new AbortController().signal,
    });
    await queue.complete(job);
    await s.t.setRole(null);
    await s.t.db
      .exec(`CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
      SELECT '2026-01-01 00:00:00Z'::timestamptz + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds',true),''),'0')::double precision)
    $$`);
    await s.t.setRole("blink_worker");
    await scheduleEvaluation(s.t.pool);
    await scheduleEvaluation(s.t.pool);
    assert.equal((await queue.stats()).queued, 1);
    await s.t.db.exec("SET blink.test_clock_offset_seconds='600'");
    await scheduleEvaluation(s.t.pool);
    assert.equal((await queue.stats()).queued, 2);
    assert.equal((await s.store.metrics("REPLAY")).eventCount, "1");
  } finally {
    delete handlers["evaluation.score"];
    await s.t.close();
  }
});
