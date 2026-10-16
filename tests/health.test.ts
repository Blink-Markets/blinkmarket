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

import { tradingWorld, DEPLOYMENT } from "./helpers/trading.js";
import { postgresHealthReader } from "../packages/adapters/src/health-reader.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import { postgresIdentityStore } from "../packages/adapters/src/identity-store.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import {
  AdminMetricsResponse,
  HealthResponse,
} from "../packages/schemas/src/index.js";

test("real API role: public readiness, admin diagnostics and persisted RFQ metrics", async () => {
  const w = await tradingWorld();
  let signer = true;
  let healthTime = 0;
  const identity = createIdentityService(
    postgresIdentityStore(w.apiPool),
    identityCrypto,
    "https://blink.example",
  );
  const health = createHealthService({
    now: () => healthTime,
    reader: postgresHealthReader(w.apiPool, DEPLOYMENT),
    signerReachable: async () => signer,
    authenticateAdmin: (authorization) =>
      identity.authenticate(authorization, "admin"),
  });
  const app = buildApi({ health, services: [health] });
  app.log.level = "silent";
  const get = (url: string, apiKey?: string) => {
    healthTime += 2000;
    return app.inject({
      url,
      headers: apiKey ? { authorization: "Bearer " + apiKey } : {},
    });
  };
  try {
    await w.setCursor(w.chain.state.head);
    assert.equal((await get("/v1/health")).statusCode, 200);
    assert.equal((await get("/health/ready")).statusCode, 200);
    assert.deepEqual((await get("/v1/health")).json(), {
      status: "ready",
      tradingEnabled: true,
      reasons: [],
    });
    assert.equal(
      (await get("/v1/health", w.agents.taker.apiKey)).statusCode,
      403,
    );
    const admin = (await get("/v1/health", w.agents.admin.apiKey)).json();
    assert.ok(HealthResponse.safeParse(admin).success);
    assert.equal(admin.details.signerReachable, true);
    assert.equal(admin.details.chainIndex.blockNumber, "100");
    assert.equal((await get("/v1/admin/metrics")).statusCode, 401);
    assert.equal(
      (await get("/v1/admin/metrics", w.agents.taker.apiKey)).statusCode,
      403,
    );
    const quote = await w.post("health-metrics");
    assert.equal(quote.statusCode, 200);
    await w.owner(() =>
      w.t.db.query(
        "UPDATE trading.quotes SET signed_at=created_at+interval '2 seconds'",
      ),
    );
    const metrics = (
      await get("/v1/admin/metrics", w.agents.admin.apiKey)
    ).json();
    assert.ok(AdminMetricsResponse.safeParse(metrics).success);
    assert.deepEqual(metrics.rfqLatency, {
      samples: "1",
      p50Ms: 2000,
      p95Ms: 2000,
    });
    assert.deepEqual(metrics.txInclusionLatency, {
      samples: "0",
      p50Ms: null,
      p95Ms: null,
    });
    assert.deepEqual(metrics.counts.quotes, [{ name: "SIGNED", count: "1" }]);
    await assert.rejects(
      w.apiPool.query("SELECT raw_transaction FROM signing.artifacts"),
      /permission denied/,
    );
    // A transaction receipt has a separate observation time from later status updates.
    const attemptId = randomUUID();
    await w.owner(() =>
      w.t.db.query(
        `
      INSERT INTO signing.tx_attempts(id,intent_id,artifact_id,tx_hash,nonce,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,max_cost_wei,status,submitted_at)
      SELECT $1,q.intent_id,a.id,decode(repeat('ab',32),'hex'),0,21000,1,0,21000,'SUBMITTED',clock_timestamp()-interval '10 seconds'
      FROM trading.quotes q JOIN signing.artifacts a ON a.sign_request_id=q.sign_request_id`,
        [attemptId],
      ),
    );
    await w.owner(() =>
      w.t.db.query(
        "UPDATE signing.tx_attempts SET status='INCLUDED' WHERE id=$1",
        [attemptId],
      ),
    );
    const observed = (
      await w.query<{ included_at: Date }>(
        "SELECT included_at FROM signing.tx_attempts WHERE id=$1",
        [attemptId],
      )
    )[0]!.included_at;
    assert.ok(observed);
    await w.owner(() =>
      w.t.db.query(
        "UPDATE signing.tx_attempts SET status='FINALIZED',updated_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [attemptId],
      ),
    );
    assert.deepEqual(
      (
        await w.query(
          "SELECT included_at FROM signing.tx_attempts WHERE id=$1",
          [attemptId],
        )
      )[0]!.included_at,
      observed,
    );
    await w.owner(() =>
      w.t.db.query(
        "UPDATE signing.tx_attempts SET included_at=submitted_at+interval '3 seconds' WHERE id=$1",
        [attemptId],
      ),
    );
    await w.owner(() =>
      w.t.db.query(
        "INSERT INTO signing.gas_spend(role,day,spent_wei,reserved_wei) VALUES ('keeper','2026-10-15',900719925474099312345,7)",
      ),
    );
    const included = (
      await get("/v1/admin/metrics", w.agents.admin.apiKey)
    ).json();
    assert.deepEqual(included.txInclusionLatency, {
      samples: "1",
      p50Ms: 3000,
      p95Ms: 3000,
    });
    assert.deepEqual(included.gasSpent, [
      {
        role: "keeper",
        day: "2026-10-15",
        spentWei: "900719925474099312345",
        reservedWei: "7",
      },
    ]);
    await w.owner(() =>
      w.t.db.query(
        "UPDATE signing.tx_attempts SET status='REORGED' WHERE id=$1",
        [attemptId],
      ),
    );
    assert.deepEqual(
      (await get("/v1/admin/metrics", w.agents.admin.apiKey)).json()
        .txInclusionLatency,
      { samples: "0", p50Ms: null, p95Ms: null },
    );
    await assert.rejects(
      w.apiPool.query("SELECT tx_hash FROM signing.tx_attempts"),
      /permission denied/,
    );
    await w.owner(() =>
      w.t.db.query(
        "UPDATE trading.maker_pools SET gate_reason='OVERCOMMITTED'",
      ),
    );
    assert.ok(
      (await get("/v1/health")).json().reasons.includes("POOL_GATE_CLOSED"),
    );
    await w.owner(() =>
      w.t.db.query("UPDATE trading.maker_pools SET gate_reason=NULL"),
    );
    await w.owner(() =>
      w.t.db.query(
        "INSERT INTO budgets.daily(day,gate_closed_reason) VALUES ((blink.now() AT TIME ZONE 'UTC')::date,'OVERRUN')",
      ),
    );
    assert.ok(
      (await get("/v1/health")).json().reasons.includes("BUDGET_GATE_CLOSED"),
    );
    await w.owner(() =>
      w.t.db.query("UPDATE budgets.daily SET gate_closed_reason=NULL"),
    );
    await w.setCursor(w.chain.state.head);
    signer = false;
    const down = await get("/v1/health");
    assert.equal(down.statusCode, 503);
    assert.deepEqual(down.json().reasons, ["SIGNER_UNAVAILABLE"]);
    assert.equal(down.headers["cache-control"], "no-store");
    await w.owner(() =>
      w.t.db.query(
        "UPDATE chain.cursors SET synced_at=blink.now()-interval '1 hour'",
      ),
    );
    assert.ok((await get("/v1/health")).json().reasons.includes("INDEXER_LAG"));
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
    signerReachable: async () => {
      throw new Error("signer-token");
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
  let signerReads = 0;
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
            poolGate: { closed: false, reconcileRequired: false },
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
    signerReachable: async () => {
      signerReads++;
      return true;
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
    assert.equal(signerReads, 1);
    failed = true;
    now = 2000;
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    assert.equal(reads, 2);
    assert.equal((await app.inject("/v1/health")).json().details, undefined);
  } finally {
    await app.close();
  }
});
