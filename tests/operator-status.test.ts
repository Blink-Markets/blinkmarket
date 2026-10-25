import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { statusWorld, DEPLOYMENT } from "./helpers/status.js";
import { inviteAgent } from "./helpers/database.js";
import { opsStatusCommand } from "../scripts/ops-status.js";
import { buildApi } from "../apps/api/src/server.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../packages/adapters/src/identity-store.js";
import { createOperatorStatusService } from "../packages/application/src/operator-status.js";
import { postgresOperatorStatusStore } from "../packages/adapters/src/operator-status-store.js";

test("operator jobs expose safe metadata only", async () => {
  const w = await statusWorld();
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
    });
    const jobs = await get("jobs?state=DEAD");
    assert.equal(jobs.statusCode, 200);
    assert.equal(jobs.json().items.length, 1);
    assert.equal(jobs.json().items[0].attempt, 3);
    assert.doesNotMatch(jobs.body, /secret|payload|lastError|leaseOwner/);
    assert.equal((await get("jobs?state=WRONG")).statusCode, 400);
    assert.equal(
      (await get("jobs?state=DEAD", w.agents.taker.apiKey)).statusCode,
      404,
    );
  } finally {
    await app.close();
    await w.close();
  }
});

test("pause reuses authenticated health", async () => {
  const w = await statusWorld();
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
    await w.owner(async () => {
      await w.t.db.query(
        "UPDATE protocol.makers SET data=data||jsonb_build_object('globalPaused',true) WHERE deployment_id=$1",
        [DEPLOYMENT],
      );
      await w.t.db.query(
        "UPDATE protocol.markets SET data=data||jsonb_build_object('state','DISPUTED','paused',true) WHERE deployment_id=$1",
        [DEPLOYMENT],
      );
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
    assert.match(summary, /Failed jobs/);
    assert.doesNotMatch(summary, /Budget|Candidates|Resolution queue/);
    assert.equal((await get("pause", w.agents.taker.apiKey)).statusCode, 404);
    await w.owner(() =>
      w.t.db.query("DELETE FROM protocol.makers WHERE deployment_id=$1", [
        DEPLOYMENT,
      ]),
    );
    assert.equal((await get("pause")).json().globalPaused, null);
  } finally {
    await app.close();
    await w.close();
  }
});

async function statusApp(w: Awaited<ReturnType<typeof statusWorld>>) {
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
        }),
      }),
    ],
  });
  app.log.level = "silent";
  return app;
}
const ROUTES = ["jobs?state=DEAD", "pause"];

test("every operator-status route is 404 for a revoked admin key and global for another operator's admin", async () => {
  const w = await statusWorld();
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
    // Another operator's admin is a valid admin: the diagnostics are global.
    for (const path of ROUTES)
      assert.equal((await get(path, otherAdmin.apiKey)).statusCode, 200, path);
  } finally {
    await app.close();
    await w.close();
  }
});

test("jobs return the newest 100 rows newest first and flag truncation", async () => {
  const w = await statusWorld();
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
    });
    const jobs = (await get("jobs?state=DEAD")).json();
    assert.equal(jobs.items.length, 100);
    assert.equal(jobs.truncated, true);
    assert.equal(jobs.items[0].createdAt, "2026-01-01T00:01:41.000Z");
    assert.equal(jobs.items[99].createdAt, "2026-01-01T00:00:02.000Z");
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
