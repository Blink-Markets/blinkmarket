import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tradingWorld, DEPLOYMENT } from "./helpers/trading.js";
import { inviteAgent } from "./helpers/database.js";
import { opsStatusCommand } from "../scripts/ops-status.js";
import { buildApi } from "../apps/api/src/server.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../packages/adapters/src/identity-store.js";
import { createOperatorStatusService } from "../packages/application/src/operator-status.js";
import { postgresOperatorStatusStore } from "../packages/adapters/src/operator-status-store.js";

test("operator candidates: admin only, own operator only, safe review and approval metadata", async () => {
  const w = await tradingWorld();
  const other = await inviteAgent(w.t, {
    name: "other-admin",
    scopes: ["admin"],
  });
  const id = randomUUID();
  const identity = createIdentityService(
    postgresIdentityStore(w.apiPool),
    identityCrypto,
    "https://blink.example",
  );
  const service = createOperatorStatusService({
    store: postgresOperatorStatusStore(w.apiPool, DEPLOYMENT),
    authenticateAdmin: (a) => identity.authenticate(a, "admin"),
  });
  const app = buildApi({ services: [service] });
  app.log.level = "silent";
  const get = (key?: string, query = "") =>
    app.inject({
      url: "/v1/admin/candidates" + query,
      headers: key ? { authorization: "Bearer " + key } : {},
    });
  try {
    await w.owner(async () => {
      await w.t.db.exec("BEGIN");
      await w.t.db.query(
        "INSERT INTO discovery.candidates(id,operator_id,current_revision) VALUES ($1,$2,1)",
        [id, w.agents.admin.operatorId],
      );
      await w.t.db.query(
        "INSERT INTO discovery.candidate_revisions(candidate_id,revision,snapshot) VALUES ($1,1,$2)",
        [
          id,
          JSON.stringify({
            candidateId: id,
            revision: 1,
            state: "DRAFT",
            thesis: "secret raw evidence",
            evidenceIds: [randomUUID()],
          }),
        ],
      );
      await w.t.db.exec("COMMIT");
    });
    for (const key of [undefined, "invalid", w.agents.taker.apiKey]) {
      const response = await get(key);
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "NOT_FOUND");
    }
    assert.deepEqual((await get(other.apiKey)).json(), {
      items: [],
      truncated: false,
    });
    const response = await get(w.agents.admin.apiKey, "?status=DRAFT");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response
        .json()
        .items.map((x: any) => [x.candidateId, x.status, x.approval]),
      [[id, "DRAFT", null]],
    );
    assert.doesNotMatch(response.body, /secret|evidenceIds|operatorId|keyId/);
    assert.deepEqual(
      (await get(w.agents.admin.apiKey, "?status=APPROVED")).json(),
      { items: [], truncated: false },
    );
    assert.equal(
      (await get(w.agents.admin.apiKey, "?status=WRONG")).statusCode,
      400,
    );
  } finally {
    await app.close();
    await w.close();
  }
});

test("operator jobs and budgets expose safe metadata and exact current-day money", async () => {
  const w = await tradingWorld();
  const identity = createIdentityService(
    postgresIdentityStore(w.apiPool),
    identityCrypto,
    "https://blink.example",
  );
  const app = buildApi({
    services: [
      createOperatorStatusService({
        store: postgresOperatorStatusStore(w.apiPool, DEPLOYMENT),
        authenticateAdmin: (a) => identity.authenticate(a, "admin"),
      }),
    ],
  });
  app.log.level = "silent";
  const get = (path: string, key = w.agents.admin.apiKey) =>
    app.inject({
      url: "/v1/admin/" + path,
      headers: { authorization: "Bearer " + key },
    });
  try {
    await w.owner(async () => {
      await w.t.db.query(
        "INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,attempt,last_error_code) VALUES ($1,'secret-type','secret-key',$2,'DEAD',3,'secret-error')",
        [
          randomUUID(),
          JSON.stringify({ apiKey: "secret", evidence: "secret" }),
        ],
      );
      await w.t.db.query(
        "INSERT INTO budgets.daily(day,cap_usd_micros) VALUES ((blink.now() AT TIME ZONE 'UTC')::date,20000000)",
      );
      await w.t.db.query(
        "INSERT INTO budgets.questions(question_key,cap_usd_micros) VALUES ('secret-question',2000000)",
      );
      for (const [state, amount, actual] of [
        ["RESERVED", "7", null],
        ["UNKNOWN", "11", null],
        ["RECONCILED", "17", "13"],
        ["RELEASED", "19", null],
      ]) {
        await w.t.db.query(
          "INSERT INTO budgets.reservations(id,day,question_key,run_id,provider,model,max_usd_micros,state,actual_usd_micros) VALUES ($1,(blink.now() AT TIME ZONE 'UTC')::date,'secret-question',$2,'secret-provider','secret-model',$3,$4,$5)",
          [randomUUID(), randomUUID(), amount, state, actual],
        );
      }
    });
    const jobs = await get("jobs?state=DEAD");
    assert.equal(jobs.statusCode, 200);
    assert.equal(jobs.json().items.length, 1);
    assert.equal(jobs.json().items[0].attempt, 3);
    assert.doesNotMatch(jobs.body, /secret|payload|lastError|leaseOwner/);
    assert.equal((await get("jobs?state=WRONG")).statusCode, 400);
    const budgets = await get("budgets");
    assert.equal(budgets.statusCode, 200);
    assert.deepEqual(budgets.json().daily, {
      ...budgets.json().daily,
      capUsdMicros: "20000000",
      spentUsdMicros: "13",
      reservedUsdMicros: "7",
      unknownUsdMicros: "11",
    });
    assert.doesNotMatch(budgets.body, /secret/);
    for (const path of ["jobs?state=DEAD", "budgets"])
      assert.equal((await get(path, w.agents.taker.apiKey)).statusCode, 404);
  } finally {
    await app.close();
    await w.close();
  }
});

test("pause and resolution queue reuse authenticated health and hide report content", async () => {
  const w = await tradingWorld();
  const { createHealthService } =
    await import("../packages/application/src/health.js");
  const { postgresHealthReader } =
    await import("../packages/adapters/src/health-reader.js");
  const identity = createIdentityService(
    postgresIdentityStore(w.apiPool),
    identityCrypto,
    "https://blink.example",
  );
  const authenticateAdmin = (a: string | undefined) =>
    identity.authenticate(a, "admin");
  const health = createHealthService({
    reader: postgresHealthReader(w.apiPool, DEPLOYMENT),
    authenticateAdmin,
    signerReachable: async () => true,
  });
  const app = buildApi({
    services: [
      createOperatorStatusService({
        store: postgresOperatorStatusStore(w.apiPool, DEPLOYMENT),
        authenticateAdmin,
        health,
      }),
    ],
  });
  app.log.level = "silent";
  const get = (path: string, key = w.agents.admin.apiKey) =>
    app.inject({
      url: "/v1/admin/" + path,
      headers: { authorization: "Bearer " + key },
    });
  try {
    await w.setCursor(w.chain.state.head);
    await w.owner(async () => {
      await w.t.db.query(
        "UPDATE chain.maker_state SET global_paused=true WHERE deployment_id=$1",
        [DEPLOYMENT],
      );
      await w.t.db.query(
        "UPDATE chain.markets SET state='DISPUTED',paused=true WHERE deployment_id=$1",
        [DEPLOYMENT],
      );
    });
    await w.owner(async () => {
      for (const agent of [w.agents.admin, w.agents.taker]) {
        await w.t.db.query(
          "INSERT INTO resolution.reports(id,deployment_id,market_id,agent_id,operator_id,outcome,evidence_ids,reason) VALUES ($1,$2,1,$3,$4,'YES',$5,'private report content')",
          [
            randomUUID(),
            DEPLOYMENT,
            agent.agentId,
            agent.operatorId,
            [randomUUID()],
          ],
        );
      }
    });
    const pause = await get("pause");
    assert.equal(pause.statusCode, 200);
    assert.equal(pause.json().globalPaused, true);
    assert.equal(pause.json().markets[0].paused, true);
    assert.equal(pause.json().health.details.chainIndex.fresh, true);
    const summary = await opsStatusCommand([], {
      apiUrl: "http://127.0.0.1:3001",
      adminKey: w.agents.admin.apiKey,
      request: async (url, init) => {
        const r = await app.inject({
          url: new URL(url).pathname + new URL(url).search,
          headers: init.headers as Record<string, string>,
        });
        return new Response(r.body, { status: r.statusCode });
      },
    });
    assert.match(summary, /Pause: global=true/);
    assert.match(summary, /Resolution queue.*disputed=1/);
    assert.match(summary, /Budget.*USD micros/);
    const queue = await get("resolutions");
    assert.equal(queue.statusCode, 200);
    assert.equal(queue.json().items[0].state, "DISPUTED");
    assert.ok(queue.json().items[0].hardDeadline);
    assert.equal(queue.json().items[0].openReports, "1");
    assert.doesNotMatch(queue.body, /evidence|reason|agentId|operatorId/i);
    for (const path of ["pause", "resolutions"])
      assert.equal((await get(path, w.agents.taker.apiKey)).statusCode, 404);
    await w.owner(() =>
      w.t.db.query("DELETE FROM chain.maker_state WHERE deployment_id=$1", [
        DEPLOYMENT,
      ]),
    );
    assert.equal((await get("pause")).json().globalPaused, null);
  } finally {
    await app.close();
    await w.close();
  }
});

async function statusApp(w: Awaited<ReturnType<typeof tradingWorld>>) {
  const { createHealthService } =
    await import("../packages/application/src/health.js");
  const { postgresHealthReader } =
    await import("../packages/adapters/src/health-reader.js");
  const identity = createIdentityService(
    postgresIdentityStore(w.apiPool),
    identityCrypto,
    "https://blink.example",
  );
  const authenticateAdmin = (a: string | undefined) =>
    identity.authenticate(a, "admin");
  const app = buildApi({
    services: [
      createOperatorStatusService({
        store: postgresOperatorStatusStore(w.apiPool, DEPLOYMENT),
        authenticateAdmin,
        health: createHealthService({
          reader: postgresHealthReader(w.apiPool, DEPLOYMENT),
          authenticateAdmin,
          signerReachable: async () => true,
        }),
      }),
    ],
  });
  app.log.level = "silent";
  return app;
}
const ROUTES = [
  "candidates",
  "jobs?state=DEAD",
  "budgets",
  "pause",
  "resolutions",
];

test("every operator-status route is 404 for another operator's admin key and for a revoked admin key", async () => {
  const w = await tradingWorld();
  const otherAdmin = await inviteAgent(w.t, {
    name: "other-admin-all",
    scopes: ["admin"],
  });
  const revoked = await inviteAgent(w.t, {
    name: "revoked-admin",
    scopes: ["admin"],
  });
  const app = await statusApp(w);
  const get = (path: string, key: string) =>
    app.inject({
      url: "/v1/admin/" + path,
      headers: { authorization: "Bearer " + key },
    });
  try {
    await w.setCursor(w.chain.state.head);
    // Before revocation the key works, so the later 404 is caused by revocation.
    for (const path of ROUTES)
      assert.equal((await get(path, revoked.apiKey)).statusCode, 200, path);
    await w.owner(() =>
      w.t.db.query(
        "UPDATE identity.api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
        [revoked.keyId],
      ),
    );
    for (const path of ROUTES) {
      const response = await get(path, revoked.apiKey);
      assert.equal(response.statusCode, 404, "revoked " + path);
      assert.equal(response.json().code, "NOT_FOUND");
    }
    // Another operator's admin is a valid admin: global diagnostics answer,
    // but operator-scoped candidates and report counts show none of ours.
    await w.owner(async () => {
      await w.t.db.query(
        "UPDATE chain.markets SET state='DISPUTED' WHERE deployment_id=$1",
        [DEPLOYMENT],
      );
      await w.t.db.query(
        "INSERT INTO resolution.reports(id,deployment_id,market_id,agent_id,operator_id,outcome,evidence_ids,reason) VALUES ($1,$2,1,$3,$4,'YES',$5,'private report content')",
        [
          randomUUID(),
          DEPLOYMENT,
          w.agents.admin.agentId,
          w.agents.admin.operatorId,
          [randomUUID()],
        ],
      );
    });
    assert.deepEqual((await get("candidates", otherAdmin.apiKey)).json(), {
      items: [],
      truncated: false,
    });
    assert.equal(
      (await get("resolutions", w.agents.admin.apiKey)).json().items[0]
        .openReports,
      "1",
    );
    assert.equal(
      (await get("resolutions", otherAdmin.apiKey)).json().items[0].openReports,
      "0",
    );
  } finally {
    await app.close();
    await w.close();
  }
});

test("candidates, jobs and resolutions return the newest 100 rows newest first and flag truncation", async () => {
  const w = await tradingWorld();
  const app = await statusApp(w);
  const get = (path: string) =>
    app.inject({
      url: "/v1/admin/" + path,
      headers: { authorization: "Bearer " + w.agents.admin.apiKey },
    });
  try {
    await w.owner(async () => {
      await w.t.db.query(
        `INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,created_at)
         SELECT gen_random_uuid(),'t','k'||i,'{}','DEAD',timestamptz '2026-01-01 00:00:00+00' + i * interval '1 second'
         FROM generate_series(1,101) i`,
      );
      await w.t.db.exec("BEGIN");
      await w.t.db.query(
        `INSERT INTO discovery.candidates(id,operator_id,current_revision,created_at)
         SELECT gen_random_uuid(),$1,1,timestamptz '2026-01-01 00:00:00+00' + i * interval '1 second'
         FROM generate_series(1,101) i`,
        [w.agents.admin.operatorId],
      );
      await w.t.db.query(
        `INSERT INTO discovery.candidate_revisions(candidate_id,revision,snapshot)
         SELECT id,1,jsonb_build_object('state','DRAFT') FROM discovery.candidates`,
      );
      await w.t.db.exec("COMMIT");
      await w.t.db.query(
        "UPDATE chain.markets SET state='DISPUTED',market_id=1 WHERE deployment_id=$1",
        [DEPLOYMENT],
      );
      await w.t.db.query(
        `INSERT INTO chain.markets SELECT (m).* FROM (
           SELECT jsonb_populate_record(m, jsonb_build_object('market_id',(i)::text,
             'spec_hash','\\x'||lpad(to_hex(i),64,'0'),'created_tx_hash','\\x'||lpad(to_hex(i),64,'0'))) AS m
           FROM chain.markets m, generate_series(2,101) i WHERE m.market_id=1) x`,
      );
    });
    const jobs = (await get("jobs?state=DEAD")).json();
    assert.equal(jobs.items.length, 100);
    assert.equal(jobs.truncated, true);
    assert.equal(jobs.items[0].createdAt, "2026-01-01T00:01:41.000Z");
    assert.equal(jobs.items[99].createdAt, "2026-01-01T00:00:02.000Z");
    const candidates = (await get("candidates")).json();
    assert.equal(candidates.items.length, 100);
    assert.equal(candidates.truncated, true);
    const queue = (await get("resolutions")).json();
    assert.equal(queue.items.length, 100);
    assert.equal(queue.truncated, true);
    assert.equal(queue.items[0].marketId, "101");
    assert.equal(queue.items[99].marketId, "2");
    await w.owner(() =>
      w.t.db.query("DELETE FROM operations.jobs WHERE dedupe_key='k1'"),
    );
    const exact = (await get("jobs?state=DEAD")).json();
    assert.equal(exact.items.length, 100);
    assert.equal(exact.truncated, false);
  } finally {
    await app.close();
    await w.close();
  }
});
