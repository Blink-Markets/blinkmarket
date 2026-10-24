import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase, inviteAgent } from "./helpers/database.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import { postgresForecastStore } from "../packages/adapters/src/forecast-store.js";
import {
  createForecastService,
  createWindowScheduler,
  createForecastScheduleHandler,
  ForecastScheduleError,
} from "../packages/application/src/forecasts.js";
import { buildApi } from "../apps/api/src/server.js";
import { apiContracts } from "../packages/schemas/src/index.ts";
import { JobError } from "../packages/domain/src/jobs.ts";

async function setup() {
  const t = await createTestDatabase();
  // Pin only this unit-test clock's origin so offset=600 is exactly the deadline.
  // The PostgreSQL race suite uses the unmodified production blink.now().
  const origin = Math.floor(Date.now() / 1000) * 1000;
  await t.db
    .exec(`CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
    SELECT '${new Date(origin).toISOString()}'::timestamptz + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds',true),''),'0')::double precision)
  $$`);
  const a = await inviteAgent(t, { name: "A", scopes: ["forecast:write"] });
  const b = await inviteAgent(t, { name: "B", scopes: ["forecast:write"] });
  await t.db
    .exec(`INSERT INTO markets.deployments(id,manifest,market_address) VALUES('test','{}',decode(repeat('11',20),'hex'));
 INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
 VALUES('test',1,decode(repeat('22',32),'hex'),'fixture','REPLAY',floor(extract(epoch from blink.now()))+7200,9999999999,9999999999,120,100,100,'OPEN',1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'));`);
  const source = randomUUID(),
    evidence = randomUUID();
  await t.db.query(
    "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES($1,'fixture','https://fixture.invalid/evidence')",
    [source],
  );
  await t.db.query(
    "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy) VALUES($1,$2,$3,decode(repeat('55',32),'hex'),'fixture','PUBLIC')",
    [evidence, source, a.operatorId],
  );
  const windowId = randomUUID();
  const deadline = new Date(origin + 600000).toISOString();
  await t.db.query(
    "INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline) VALUES($1,'test',1,'DAILY',$2,$2::timestamptz-interval '30 minutes',$2)",
    [windowId, deadline],
  );
  const store = postgresForecastStore(t.pool);
  const app = buildApi({
    services: [createForecastService({ store, crypto: identityCrypto })],
  });
  const body = {
    horizonKey: { horizonType: "DAILY", scheduledAt: deadline },
    probability: 0.6,
    evidenceIds: [evidence],
    rationale: "fixture rationale",
    agentVersion: "v1",
  };
  const post = (key: string, agent = a, payload = body) =>
    app.inject({
      method: "POST",
      url: "/v1/markets/1/forecasts?deploymentId=test",
      headers: {
        authorization: "Bearer " + agent.apiKey,
        "idempotency-key": key,
      },
      payload,
    });
  const get = (authorization?: string) =>
    app.inject({
      method: "GET",
      url: `/v1/markets/1/forecasts?deploymentId=test&windowId=${windowId}`,
      headers: authorization === undefined ? {} : { authorization },
    });
  await t.setRole("blink_api");
  return {
    t,
    a,
    b,
    store,
    app,
    body,
    post,
    get,
    windowId,
    deadline,
    evidence,
    source,
    async close() {
      await app.close();
      await t.close();
    },
  };
}

test("forecast submit is immutable, idempotent, audited and matches the wire contract", async () => {
  const s = await setup();
  try {
    const first = await s.post("one");
    assert.equal(first.statusCode, 201, first.body);
    apiContracts
      .find(
        (c) => c.method === "POST" && c.path === "/v1/markets/:id/forecasts",
      )!
      .response.parse(first.json());
    assert.deepEqual((await s.post("one")).json(), first.json());
    assert.equal(
      (await s.post("two")).json().code,
      "FORECAST_ALREADY_SUBMITTED",
    );
    assert.equal(
      (await s.post("one", s.a, { ...s.body, probability: 0.7 })).json().code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(
      (
        await s.t.db.query(
          "SELECT * FROM operations.audit_log WHERE action='forecast.submitted'",
        )
      ).rows.length,
      1,
    );
    await assert.rejects(
      s.t.db.exec("UPDATE forecasts.submissions SET rationale='changed'"),
      /permission denied/,
    );
    // blink_api holds UPDATE(id) only so SELECT ... FOR UPDATE can lock a window.
    await assert.rejects(
      s.t.db.exec("UPDATE forecasts.windows SET id=id"),
      /append-only table/,
    );
  } finally {
    await s.close();
  }
});

test("DB deadlines, evidence ownership, visibility, pagination and scheduler permissions", async () => {
  const s = await setup();
  try {
    await s.t.db.exec("SET blink.test_clock_offset_seconds='-1801'");
    const early = await s.post("early");
    assert.equal(early.json().code, "FORECAST_WINDOW_CLOSED");
    assert.equal(early.json().details.reason, "NOT_OPEN");
    await s.t.db.exec("SET blink.test_clock_offset_seconds='600'");
    const late = await s.post("late");
    assert.equal(late.json().details.reason, "CLOSED");
    await s.t.db.exec("SET blink.test_clock_offset_seconds='0'");
    await s.t.setRole(null);
    const privateId = randomUUID();
    await s.t.db.query(
      "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy) VALUES($1,$2,$3,decode(repeat('77',32),'hex'),'fixture','PRIVATE')",
      [privateId, s.source, s.b.operatorId],
    );
    await s.t.setRole("blink_api");
    assert.equal(
      (
        await s.post("private", s.a, { ...s.body, evidenceIds: [privateId] })
      ).json().code,
      "EVIDENCE_NOT_ALLOWED",
    );
    assert.equal(
      (
        await s.post("missing", s.a, { ...s.body, evidenceIds: [randomUUID()] })
      ).json().code,
      "EVIDENCE_NOT_ALLOWED",
    );
    const a = await s.post("a");
    // The same UUID in two letter cases is one record, not a missing one.
    const b = await s.post("b", s.b, {
      ...s.body,
      evidenceIds: [privateId, privateId.toUpperCase() as typeof privateId],
    });
    assert.equal(b.statusCode, 201, b.body);
    assert.deepEqual((await s.get()).json().items, []);
    assert.deepEqual(
      (await s.get("Bearer " + s.a.apiKey))
        .json()
        .items.map((i: { agentId: string }) => i.agentId),
      [s.a.agentId],
    );
    assert.equal((await s.get("garbage")).statusCode, 401);
    assert.equal(
      (await s.get("Bearer " + s.a.apiKey.slice(0, -1) + "x")).statusCode,
      401,
    );
    await s.t.setRole(null);
    for (const kind of ["WITHDRAWN", "OUTCOME_ALREADY_PUBLIC"])
      await s.t.db.query(
        "INSERT INTO forecasts.annotations(id,submission_id,kind,reason,actor) VALUES($1,$2,$3,'fixture','fixture')",
        [randomUUID(), a.json().submissionId, kind],
      );
    await s.t.setRole("blink_api");
    await s.t.db.exec("SET blink.test_clock_offset_seconds='601'");
    const visible = (await s.get()).json();
    assert.equal(visible.items.length, 2);
    apiContracts
      .find(
        (c) => c.method === "GET" && c.path === "/v1/markets/:id/forecasts",
      )!
      .response.parse(visible);
    const flagged = visible.items.find(
      (i: { agentId: string }) => i.agentId === s.a.agentId,
    );
    assert.ok(flagged.withdrawnAt);
    assert.equal(flagged.contaminated, true);
    assert.deepEqual(
      (await s.post("a")).json(),
      a.json(),
      "replay survives deadline",
    );
    assert.equal(
      (await s.get("invalid")).statusCode,
      401,
      "closed windows still reject invalid auth",
    );
    const firstPage = await s.app.inject({
      url: `/v1/markets/1/forecasts?deploymentId=test&windowId=${s.windowId}&limit=1`,
    });
    const secondPage = await s.app.inject({
      url: `/v1/markets/1/forecasts?deploymentId=test&windowId=${s.windowId}&limit=1&cursor=${firstPage.json().nextCursor}`,
    });
    assert.equal(secondPage.json().items.length, 1);
    assert.notEqual(
      firstPage.json().items[0].submissionId,
      secondPage.json().items[0].submissionId,
    );
    await s.t.setRole("blink_worker");
    await assert.rejects(
      s.t.db.query("SELECT * FROM forecasts.submissions"),
      /permission denied/,
    );
    const scheduler = createWindowScheduler(s.store);
    assert.ok((await scheduler.scheduleOnce()) > 0);
    assert.equal(await scheduler.scheduleOnce(), 0);
    const handler = createForecastScheduleHandler(scheduler);
    await handler({
      job: { id: randomUUID(), payload: {} },
      signal: new AbortController().signal,
    });
    const boom = new Error("database down");
    await assert.rejects(
      createForecastScheduleHandler({
        scheduleOnce: async () => {
          throw boom;
        },
      })({
        job: { id: randomUUID(), payload: {} },
        signal: new AbortController().signal,
      }),
      (error) =>
        error instanceof ForecastScheduleError &&
        error instanceof JobError &&
        error.code === "FORECAST_SCHEDULE_FAILED" &&
        error.retryable &&
        error.cause === boom,
    );
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      handler({
        job: { id: randomUUID(), payload: {} },
        signal: aborted.signal,
      }),
      /OPERATION_ABORTED/,
    );
    await s.t.setRole("blink_api");
    const windows = await s.app.inject({
      url: "/v1/markets/1/forecast-windows?deploymentId=test&limit=1",
    });
    apiContracts
      .find((c) => c.path === "/v1/markets/:id/forecast-windows")!
      .response.parse(windows.json());
    assert.equal(windows.json().items[0].status, "CLOSED");
    assert.ok(windows.json().nextCursor);
    const next = await s.app.inject({
      url:
        "/v1/markets/1/forecast-windows?deploymentId=test&limit=1&cursor=" +
        encodeURIComponent(windows.json().nextCursor),
    });
    assert.equal(next.statusCode, 200, next.body);
    assert.notEqual(
      next.json().items[0].windowId,
      windows.json().items[0].windowId,
    );
  } finally {
    await s.close();
  }
});

test("forecast admin appends audited annotations under its role", async () => {
  const { forecastAdmin, assertForecastAdminRole } =
    await import("../packages/adapters/src/forecast-admin.js");
  const { assertIdentityRuntimeRole } =
    await import("../packages/adapters/src/identity-store.js");
  const s = await setup();
  try {
    const submission = await s.post("admin-fixture");
    const admin = forecastAdmin(s.t.pool);
    await assert.rejects(
      admin.annotate({
        submissionId: submission.json().submissionId,
        kind: "WITHDRAWN",
        reason: "Reviewed withdrawal",
      }),
      /permission denied/,
    );
    await s.t.db.exec("RESET ROLE; SET ROLE blink_forecast_admin");
    await assertForecastAdminRole(s.t.pool);
    await assert.rejects(
      admin.annotate({
        submissionId: submission.json().submissionId,
        kind: "WITHDRAWN",
        reason: " ",
      }),
    );
    await admin.annotate({
      submissionId: submission.json().submissionId,
      kind: "WITHDRAWN",
      reason: "Reviewed withdrawal",
    });
    await s.t.setRole(null);
    assert.equal(
      (
        await s.t.db.query(
          "SELECT * FROM operations.audit_log WHERE action LIKE 'forecast.%' AND action<>'forecast.submitted'",
        )
      ).rows.length,
      1,
    );
    await s.t.db.exec(
      "CREATE ROLE forecast_mixed; GRANT blink_api,blink_forecast_admin TO forecast_mixed; SET ROLE forecast_mixed",
    );
    await assert.rejects(
      assertIdentityRuntimeRole(s.t.pool),
      /UNSAFE_API_DATABASE_ROLE/,
    );
  } finally {
    await s.close();
  }
});

test("forecast rejection is atomic for absent windows, closed markets, invalid input and scope", async () => {
  const s = await setup();
  try {
    assert.equal(
      (
        await s.post("absent", s.a, {
          ...s.body,
          horizonKey: {
            ...s.body.horizonKey,
            scheduledAt: new Date(Date.parse(s.deadline) + 1000).toISOString(),
          },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await s.post("precision", s.a, { ...s.body, probability: 0.1234567 }))
        .statusCode,
      400,
    );
    await s.t.setRole(null);
    const unscoped = await inviteAgent(s.t, {
      name: "unscoped",
      scopes: ["candidate:write"],
    });
    await s.t.setRole("blink_api");
    assert.equal((await s.post("scope", unscoped)).statusCode, 403);
    await s.t.setRole(null);
    await s.t.db.exec("UPDATE chain.markets SET state='FINAL'");
    await s.t.setRole("blink_api");
    assert.equal((await s.post("closed")).json().code, "MARKET_CLOSED");
    await s.t.setRole(null);
    await s.t.db.exec(
      "UPDATE chain.markets SET state='OPEN',close_at=floor(extract(epoch from blink.now()))",
    );
    await s.t.setRole("blink_api");
    assert.equal((await s.post("expired-market")).json().code, "MARKET_CLOSED");
    assert.equal(
      (await s.t.db.query("SELECT * FROM forecasts.submissions")).rows.length,
      0,
    );
    assert.equal(
      (await s.t.db.query("SELECT * FROM operations.idempotency_records")).rows
        .length,
      0,
    );
  } finally {
    await s.close();
  }
});
