import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../apps/api/src/server.js";
import { createHealthService } from "../packages/application/src/health.js";

test("health fails closed without adapters and reports only public reasons", async () => {
  const app = buildApi();
  try {
    const response = await app.inject("/v1/health");
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      status: "not-ready",
      tradingEnabled: false,
      reasons: ["SERVICE_NOT_READY"],
    });
  } finally {
    await app.close();
  }
});

import { statusWorld, DEPLOYMENT } from "./helpers/status.js";
import { postgresHealthReader } from "../packages/adapters/src/health-reader.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import { postgresIdentityStore } from "../packages/adapters/src/identity-store.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import {
  AdminMetricsResponse,
  HealthResponse,
} from "../packages/schemas/src/index.js";

test("API role reports infrastructure readiness and safe job metrics without execution tables", async () => {
  const w = await statusWorld();
  let now = 0;
  const identity = createIdentityService(
    postgresIdentityStore(w.apiPool),
    identityCrypto,
    "https://blink.example",
  );
  const health = createHealthService({
    reader: postgresHealthReader(w.apiPool, DEPLOYMENT),
    now: () => now,
    authenticateAdmin: (a) => identity.authenticate(a, "admin"),
  });
  const app = buildApi({ health, services: [health] });
  app.log.level = "silent";
  const get = (url: string, key?: string) => {
    now += 2000;
    return app.inject({
      url,
      headers: key ? { authorization: "Bearer " + key } : {},
    });
  };
  try {
    assert.deepEqual((await get("/v1/health")).json(), {
      status: "ready",
      tradingEnabled: false,
      reasons: [],
    });
    assert.equal((await get("/health/ready")).statusCode, 200);
    assert.equal(
      (await get("/v1/health", w.agents.taker.apiKey)).statusCode,
      403,
    );
    const admin = (await get("/v1/health", w.agents.admin.apiKey)).json();
    assert.ok(HealthResponse.safeParse(admin).success);
    assert.equal(admin.details.chainIndex.blockNumber, "100");
    assert.equal((await get("/v1/admin/metrics")).statusCode, 401);
    await w.owner(() =>
      w.t.db.query(
        `INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,attempt,last_error_code)
      VALUES($1::uuid,'evaluation.score',$1::text,'{}','DEAD',1,'SCORE_FAILED')`,
        [randomUUID()],
      ),
    );
    const metrics = (
      await get("/v1/admin/metrics", w.agents.admin.apiKey)
    ).json();
    assert.ok(AdminMetricsResponse.safeParse(metrics).success);
    assert.deepEqual(metrics.counts.jobs, [{ name: "DEAD", count: "1" }]);
    assert.deepEqual(metrics.counts.errors, [
      { name: "job:SCORE_FAILED", count: "1" },
    ]);
    await w.owner(() =>
      w.t.db.query(
        "UPDATE chain.cursors SET synced_at=blink.now()-interval '1 hour'",
      ),
    );
    assert.deepEqual((await get("/v1/health")).json().reasons, ["INDEXER_LAG"]);
  } finally {
    await app.close();
    await w.close();
  }
});

test("dependency failures cannot disclose exception secrets", async () => {
  const health = createHealthService({
    reader: {
      health: async () => {
        throw new Error("postgres://secret:password@host signer-token");
      },
      metrics: async () => {
        throw new Error("unused");
      },
    },
    authenticateAdmin: async () => {},
  });
  assert.deepEqual(await health.read(), {
    status: "not-ready",
    tradingEnabled: false,
    reasons: ["SERVICE_NOT_READY"],
  });
});

test("health endpoints share a single-flight snapshot, rate limit bursts and refresh failures", async () => {
  let now = 0;
  let reads = 0;
  let failed = false;
  const health = createHealthService({
    now: () => now,
    reader: {
      async health() {
        reads++;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (failed) throw new Error("dependency down");
        return {
          reasons: [],
          details: {
            queue: [],
            chainIndex: { blockNumber: "1", headNumber: "1", fresh: true },
            budgetGates: { dailyClosed: false, questionsClosed: "0" },
            alerts: {
              stalled: false,
              stalledCount: "0",
              oldestStalledSeconds: null,
            },
          },
        };
      },
      async metrics() {
        throw new Error("unused");
      },
    },
    authenticateAdmin: async () => {},
  });
  const app = buildApi({
    health,
    publicReadLimit: { capacity: 60, refillPerSecond: 1, now: () => now },
  });
  app.log.level = "silent";
  try {
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, i) =>
        app.inject(i % 2 ? "/v1/health" : "/health/ready"),
      ),
    );
    assert.equal(responses.filter((r) => r.statusCode === 429).length, 190);
    assert.equal(reads, 1);
    failed = true;
    now = 2000;
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    assert.equal(reads, 2);
    assert.equal((await app.inject("/v1/health")).json().details, undefined);
  } finally {
    await app.close();
  }
});

test("health accepts only a protocol deployment and refuses 31 seconds of timestamp lag", async () => {
  const { createTestDatabase } = await import("./helpers/database.ts");
  const { seedProtocolDeployment } =
    await import("./helpers/protocol-index.ts");
  const t = await createTestDatabase();
  try {
    await seedProtocolDeployment(t.pool);
    await t.pool.query(
      "INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,head_timestamp,synced_at) VALUES('d1',10,decode(repeat('11',32),'hex'),1000,11,1030,blink.now())",
    );
    await t.setRole("blink_api");
    const reader = postgresHealthReader(t.pool, "d1");
    assert.deepEqual((await reader.health()).reasons, []);
    await t.setRole(null);
    await t.pool.query("UPDATE chain.cursors SET head_timestamp=1031");
    assert.deepEqual((await reader.health()).reasons, ["INDEXER_LAG"]);
  } finally {
    await t.close();
  }
});

test("API health rejects a recent cursor one block and 31 timestamp seconds behind", async () => {
  const w = await statusWorld();
  try {
    await w.t.pool.query(
      "UPDATE chain.cursors SET head_number=block_number+1,head_timestamp=block_timestamp+31",
    );
    assert.deepEqual(
      (await postgresHealthReader(w.apiPool, DEPLOYMENT).health()).reasons,
      ["INDEXER_LAG"],
    );
  } finally {
    await w.close();
  }
});
