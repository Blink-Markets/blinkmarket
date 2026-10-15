import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dispatchOutbox } from "../packages/adapters/src/outbox-dispatcher.js";
import {
  assertTradingAdminRole,
  tradingAdmin,
} from "../packages/adapters/src/trading-admin.js";
import {
  handlers,
  outboxMapping,
  quoteReconcileJobs,
  QUOTE_RECONCILE_BUCKET_MS,
  registerQuoteReconcile,
  scheduleQuoteReconcile,
} from "../apps/worker/src/handlers.js";
import { poolAs } from "./helpers/research.js";
import {
  DEPLOYMENT,
  HEAD_TS,
  tradingWorld,
  type TradingWorld,
} from "./helpers/trading.js";

const jobs = (w: TradingWorld) =>
  w.query<{
    type: string;
    dedupe_key: string;
    payload: Record<string, unknown>;
    ahead: boolean;
  }>(
    `SELECT type, dedupe_key, payload, next_run_at > blink.now() AS ahead FROM operations.jobs
    WHERE type='quote.reconcile' ORDER BY dedupe_key`,
  );
const outbox = (
  w: TradingWorld,
  type: string,
  deploymentId: string,
  version: number,
) =>
  w.query(
    "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES ($1,$2,$3,$4,$5)",
    [
      randomUUID(),
      type,
      deploymentId,
      version,
      { deploymentId, blockNumber: String(version) },
    ],
  );

test("trading:admin closes and reopens a market's quoting, with an audit row each way", async () => {
  const w = await tradingWorld();
  try {
    const admin = tradingAdmin(w.t.pool);
    const gate = {
      deploymentId: DEPLOYMENT,
      marketId: "1",
      reason: "OUTCOME_KNOWN" as const,
      note: "The company already published the result",
    };
    await w.owner(async () => undefined);
    // Without the group role the tool can do nothing.
    await w.t.db.exec("SET ROLE blink_api");
    await assert.rejects(admin.closeGate(gate), /permission denied/);
    await w.t.db.exec("RESET ROLE; SET ROLE blink_trading_admin");
    await assertTradingAdminRole(w.t.pool);
    await assert.rejects(
      admin.closeGate({ ...gate, note: "  " }),
      /INVALID_QUOTE_GATE/,
    );
    await assert.rejects(
      admin.closeGate({ ...gate, reason: "NOPE" as never }),
      /INVALID_QUOTE_GATE/,
    );
    await assert.rejects(
      admin.closeGate({ ...gate, marketId: "0" }),
      /INVALID_QUOTE_GATE/,
    );
    await admin.closeGate(gate);
    await assert.rejects(
      admin.closeGate(gate),
      /unique|duplicate/,
      "one open gate per reason",
    );
    // Another reason on the same market is its own gate.
    await admin.closeGate({
      ...gate,
      reason: "OPERATOR_PAUSE",
      note: "manual hold",
    });

    const blocked = await w.post("while-closed");
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().code, "NO_QUOTE");
    assert.equal(blocked.json().details.reason, "OPERATOR_PAUSE");

    await w.t.db.exec("RESET ROLE; SET ROLE blink_trading_admin");
    await assert.rejects(
      admin.reopenGate({ ...gate, reason: "SPEC_INTEGRITY" }),
      /QUOTE_GATE_NOT_CLOSED/,
    );
    await admin.reopenGate(gate);
    await admin.reopenGate({
      ...gate,
      reason: "OPERATOR_PAUSE",
      note: "hold released",
    });
    assert.equal((await w.post("after-reopen")).statusCode, 200);
    // A reopened reason can be closed again.
    await w.t.db.exec("RESET ROLE; SET ROLE blink_trading_admin");
    await admin.closeGate(gate);

    const audit = await w.query<{
      action: string;
      resource: string;
      reason: string;
    }>(
      "SELECT action, resource, reason FROM operations.audit_log WHERE action LIKE 'trading.%' ORDER BY created_at",
    );
    assert.deepEqual(
      audit.map((row) => row.action),
      [
        "trading.gate_closed",
        "trading.gate_closed",
        "trading.gate_reopened",
        "trading.gate_reopened",
        "trading.gate_closed",
      ],
    );
    assert.equal(audit[0]!.resource, `${DEPLOYMENT}:1:OUTCOME_KNOWN`);
    assert.equal(audit[2]!.reason, gate.note);
    const rows = await w.query<{ actor: string; reopened_by: string | null }>(
      "SELECT actor, reopened_by FROM trading.quote_gates ORDER BY closed_at, reason",
    );
    assert.ok(rows.every((row) => row.actor === "blink_trading_admin"));
    // The tool refuses a login that is not exactly an ordinary trading admin.
    await w.owner(async () => undefined);
    await w.t.db.exec("SET ROLE blink_api");
    await assert.rejects(
      assertTradingAdminRole(w.t.pool),
      /UNSAFE_TRADING_ADMIN_DATABASE_ROLE/,
    );
    await w.t.db.exec(
      "RESET ROLE; CREATE ROLE trading_super SUPERUSER; GRANT blink_trading_admin TO trading_super; SET ROLE trading_super",
    );
    await assert.rejects(
      assertTradingAdminRole(w.t.pool),
      /UNSAFE_TRADING_ADMIN_DATABASE_ROLE/,
    );
  } finally {
    await w.close();
  }
});

test("least privilege: each runtime role touches only what its job needs", async () => {
  const w = await tradingWorld();
  try {
    assert.equal((await w.post("k")).statusCode, 200);
    const as = async (role: string, sql: string, params?: unknown[]) => {
      await w.t.db.exec("RESET ROLE; SET ROLE " + role);
      try {
        return await w.t.db.query(sql, params);
      } finally {
        await w.t.db.exec("RESET ROLE");
      }
    };
    // The signer reads quotes and reservations and writes nothing there.
    assert.deepEqual(
      (
        await as(
          "blink_signer",
          "SELECT count(*)::int AS n FROM trading.quotes",
        )
      ).rows,
      [{ n: 1 }],
    );
    await assert.rejects(
      as(
        "blink_signer",
        "UPDATE trading.collateral_reservations SET state='RELEASED'",
      ),
      /permission denied/,
    );
    await assert.rejects(
      as("blink_signer", "SELECT * FROM trading.reservation_events"),
      /permission denied/,
    );
    // The API cannot rewrite what a quote is: only its progress columns move.
    await assert.rejects(
      as("blink_api", "UPDATE trading.quotes SET price_bps=1"),
      /permission denied/,
    );
    await assert.rejects(
      as(
        "blink_api",
        "UPDATE trading.collateral_reservations SET amount_micros=1",
      ),
      /permission denied/,
    );
    await assert.rejects(
      as(
        "blink_api",
        "INSERT INTO trading.quote_gates(id,deployment_id,market_id,reason,actor,note) VALUES (gen_random_uuid(),'rfq-test',1,'OPERATOR_PAUSE','x','y')",
      ),
      /permission denied/,
    );
    await assert.rejects(
      as("blink_api", "DELETE FROM trading.quotes"),
      /permission denied/,
    );
    // The history of reservations is append-only for everyone, owner included.
    await assert.rejects(
      as("blink_worker", "UPDATE trading.reservation_events SET reason='x'"),
      /permission denied/,
    );
    await assert.rejects(
      w.t.db.query("UPDATE trading.reservation_events SET reason='x'"),
      /append-only/,
    );
    await assert.rejects(
      w.t.db.query("DELETE FROM trading.reservation_events"),
      /append-only/,
    );
    // The worker reconciles: it can settle a reservation and set the pool gate.
    await as(
      "blink_worker",
      "UPDATE trading.maker_pools SET gate_reason='OVERCOMMITTED'",
    );
    await assert.rejects(
      as("blink_worker", "UPDATE trading.maker_pools SET gate_reason='NOPE'"),
      /check/,
    );
    // The admin role sees gates, not quotes.
    await assert.rejects(
      as("blink_trading_admin", "SELECT * FROM trading.quotes"),
      /permission denied/,
    );
  } finally {
    await w.close();
  }
});

test("chain events coalesce into one reconcile job per deployment and time bucket", async () => {
  const w = await tradingWorld();
  try {
    const worker = poolAs(w.t, "blink_worker");
    const at = 10 * QUOTE_RECONCILE_BUCKET_MS + 100;
    // Same bucket: one job however many blocks arrive, and a reorg joins it.
    for (const [version, type] of [
      [1, "chain.synced"],
      [2, "chain.synced"],
      [3, "chain.reorged"],
    ] as const)
      await outbox(w, type, DEPLOYMENT, version);
    await outbox(w, "chain.synced", "other-deployment", 1);
    await outbox(w, "chain.synced", "", 2);
    const mapping = {
      "chain.synced": (event: Parameters<typeof quoteReconcileJobs>[0]) =>
        quoteReconcileJobs(event, at),
      "chain.reorged": (event: Parameters<typeof quoteReconcileJobs>[0]) =>
        quoteReconcileJobs(event, at + 500),
    };
    assert.equal(await dispatchOutbox(worker, mapping), 5);
    const created = await jobs(w);
    assert.deepEqual(
      created.map((job) => [job.dedupe_key, job.payload]),
      [
        [`quote.reconcile:${DEPLOYMENT}:10`, { deploymentId: DEPLOYMENT }],
        [
          "quote.reconcile:other-deployment:10",
          { deploymentId: "other-deployment" },
        ],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    // The job starts after its bucket ends, so it sees every block that bucket delivered.
    assert.deepEqual(
      (
        await w.query<{ at: string }>(
          "SELECT (extract(epoch from next_run_at)*1000)::bigint::text AS at FROM operations.jobs ORDER BY dedupe_key",
        )
      ).map((row) => row.at),
      [
        String(11 * QUOTE_RECONCILE_BUCKET_MS),
        String(11 * QUOTE_RECONCILE_BUCKET_MS),
      ],
    );
    // The next bucket gets its own job.
    await outbox(w, "chain.synced", DEPLOYMENT, 4);
    await dispatchOutbox(worker, {
      "chain.synced": (event) =>
        quoteReconcileJobs(event, at + QUOTE_RECONCILE_BUCKET_MS),
    });
    assert.equal((await jobs(w)).length, 3);
  } finally {
    await w.close();
  }
});

test("the registered worker mapping adds the reconcile job next to any existing mapping", () => {
  const event = {
    id: "e",
    type: "chain.synced",
    aggregateId: DEPLOYMENT,
    payload: { deploymentId: DEPLOYMENT },
  };
  for (const type of ["chain.synced", "chain.reorged"]) {
    const specs = outboxMapping[type]!({ ...event, type });
    const reconcile = specs.filter((spec) => spec.type === "quote.reconcile");
    assert.equal(reconcile.length, 1, type);
    assert.equal(reconcile[0]!.coalesce, true);
    assert.deepEqual(reconcile[0]!.payload, { deploymentId: DEPLOYMENT });
  }
});

test("the 5 second backstop schedules each deployment with open reservations or a gated pool once per bucket", async () => {
  const w = await tradingWorld();
  try {
    const worker = poolAs(w.t, "blink_worker");
    // Pin blink.now() so two calls cannot straddle a bucket boundary.
    await w.query(`CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
      SELECT '${new Date(Math.floor(Date.now() / 5000) * 5000).toISOString()}'::timestamptz + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds',true),''),'0')::double precision) $$`);
    await scheduleQuoteReconcile(worker);
    assert.deepEqual(await jobs(w), [], "nothing to reconcile yet");
    assert.equal((await w.post("k")).statusCode, 200);
    await scheduleQuoteReconcile(worker);
    await scheduleQuoteReconcile(worker);
    assert.equal((await jobs(w)).length, 1);
    await w.setDbClock(5);
    await scheduleQuoteReconcile(worker);
    assert.equal((await jobs(w)).length, 2, "the next 5 second bucket");
    // A settled pool with a gate still needs its pass.
    await w.query(
      "UPDATE trading.collateral_reservations SET state='RELEASED'",
    );
    await w.query("UPDATE trading.maker_pools SET gate_reason='OVERCOMMITTED'");
    await w.setDbClock(10);
    await scheduleQuoteReconcile(worker);
    assert.equal((await jobs(w)).length, 3);
  } finally {
    await w.close();
  }
});

test("the registered quote.reconcile handler reconciles through the worker's own grants", async () => {
  const w = await tradingWorld();
  try {
    assert.equal((await w.post("k")).statusCode, 200);
    registerQuoteReconcile(poolAs(w.t, "blink_worker"));
    await w.setCursor({ number: 101n, timestamp: HEAD_TS + 30n });
    await handlers["quote.reconcile"]!({
      job: { id: "j", payload: { deploymentId: DEPLOYMENT } },
      signal: new AbortController().signal,
    } as never);
    const [row] = await w.query<{ state: string }>(
      "SELECT state FROM trading.collateral_reservations",
    );
    assert.equal(row!.state, "RELEASED");
  } finally {
    await w.close();
  }
});
