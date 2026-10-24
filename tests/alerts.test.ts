import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./helpers/database.js";
import { dispatchOutbox } from "../packages/adapters/src/outbox-dispatcher.js";
import { postgresJobQueue } from "../packages/adapters/src/job-queue.js";
import { startJobLoops } from "../apps/worker/src/loops.js";
import { isAllowedAlertWebhookUrl } from "../packages/adapters/src/alert-url.js";
import { alertPayload } from "../packages/adapters/src/alert-payload.js";
import { postgresHealthReader } from "../packages/adapters/src/health-reader.js";
import { alertSinkFor } from "../apps/worker/src/alerts.js";

test("every alert.* event becomes a durable delivery job, including unknown alert types", async () => {
  const t = await createTestDatabase();
  try {
    for (const type of [
      "alert.budget",
      "alert.pause",
      "alert.rpc_failure",
      "alert.deadline",
      "alert.indexer_lag",
      "alert.future",
      "other.unmapped",
    ])
      await t.pool.query(
        "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1::uuid,$2,$1::text,1,$3)",
        [randomUUID(), type, { secret: "must-not-leave-db" }],
      );
    await t.setRole("blink_worker");
    assert.equal(await dispatchOutbox(t.pool, {}), 7);
    assert.equal(await dispatchOutbox(t.pool, {}), 0);
    const queue = postgresJobQueue(t.pool);
    const keys = new Set();
    for (let n = 0; n < 6; n++) {
      const job = await queue.lease("alerts-test", ["alert.deliver"], 60_000);
      assert.ok(job);
      assert.equal(
        JSON.stringify(job.payload).includes("must-not-leave-db"),
        false,
      );
      keys.add(job.payload.dedupeKey);
      await queue.complete(job);
    }
    assert.equal(keys.size, 6);
    assert.equal(
      await queue.lease("alerts-test", ["alert.deliver"], 60_000),
      null,
    );
  } finally {
    await t.close();
  }
});

import { createServer } from "node:http";
import { once } from "node:events";
import { webhookAlertSink } from "../packages/adapters/src/alert-sinks.js";
import { createAlertDeliveryHandler } from "../packages/application/src/alerts.js";
import { startWorker } from "../packages/application/src/worker-runtime.js";
import { setTimeout as delay } from "node:timers/promises";

test("sink rejection stays pending with backoff; retry succeeds with the same dedupe key and safe payload", async () => {
  const received: { key?: string; body: string }[] = [];
  let status = 503;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ key: req.headers["idempotency-key"] as string, body });
    res.writeHead(status).end("sensitive sink error");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const t = await createTestDatabase();
  let worker: ReturnType<typeof startWorker> | undefined;
  try {
    await t.pool.query(
      "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,'alert.deadline','private aggregate',1,$2)",
      [
        randomUUID(),
        {
          deadline: "1000000",
          thresholdSeconds: 60,
          mode: "REPLAY",
          kind: "HARD_DEADLINE",
          marketId: "1",
          evidence: "private evidence",
          token: "secret",
          nested: { key: "secret" },
        },
      ],
    );
    await t.setRole("blink_worker");
    await dispatchOutbox(t.pool, {});
    const queue = postgresJobQueue(t.pool);
    const handler = createAlertDeliveryHandler(
      webhookAlertSink(`http://127.0.0.1:${address.port}`),
    );
    worker = startWorker({
      queue,
      handlers: { "alert.deliver": handler },
      workerId: "test",
      pollIntervalMs: 10,
    });
    for (let n = 0; n < 200; n++) {
      const row = (
        await t.pool.query("SELECT state,last_error_code FROM operations.jobs")
      ).rows[0];
      if (row?.last_error_code) break;
      await delay(10);
    }
    await worker.stop();
    worker = undefined;
    const row = (
      await t.pool.query(
        "SELECT state,last_error_code,extract(epoch FROM(next_run_at-blink.now())) AS wait FROM operations.jobs",
      )
    ).rows[0]!;
    assert.equal(row.state, "QUEUED");
    assert.equal(row.last_error_code, "ALERT_SINK_FAILED");
    assert.ok(Number(row.wait) > 0);
    assert.equal(received.length, 1);
    for (const text of ["private", "secret", "token", "nested"])
      assert.equal(received[0]!.body.includes(text), false);
    status = 204;
    await t.setRole(null);
    await t.pool.query("UPDATE operations.jobs SET next_run_at=blink.now()");
    await t.setRole("blink_worker");
    worker = startWorker({
      queue,
      handlers: { "alert.deliver": handler },
      workerId: "retry",
      pollIntervalMs: 10,
    });
    for (let n = 0; n < 200; n++) {
      if (
        (await t.pool.query("SELECT state FROM operations.jobs")).rows[0]
          ?.state === "SUCCEEDED"
      )
        break;
      await delay(10);
    }
    await worker.stop();
    worker = undefined;
    assert.equal(
      (await t.pool.query("SELECT state FROM operations.jobs")).rows[0]?.state,
      "SUCCEEDED",
    );
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], received[1]);
    assert.equal(JSON.parse(received[0]!.body).deadline, "1000000");
  } finally {
    await worker?.stop();
    await t.close();
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAlertSink } from "../packages/adapters/src/alert-sinks.js";
import { alertConfig } from "../apps/worker/src/config.js";

test("local file sink appends safe JSON lines and config refuses incomplete or placeholder destinations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-alerts-"));
  try {
    const path = join(dir, "alerts.jsonl");
    const sink = fileAlertSink(path);
    const alert = {
      dedupeKey: `alert:${randomUUID()}`,
      type: "alert.budget",
      secret: "do-not-send",
    };
    await sink.deliver(alert, new AbortController().signal);
    await sink.deliver(alert, new AbortController().signal);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), {
      dedupeKey: alert.dedupeKey,
      type: alert.type,
    });
    assert.deepEqual(alertConfig({}), { sink: "stdout" });
    assert.deepEqual(
      alertConfig({ ALERT_SINK: "file", ALERT_FILE_PATH: path }),
      { sink: "file", path },
    );
    for (const env of [
      { ALERT_SINK: "file" },
      { ALERT_SINK: "webhook" },
      { ALERT_SINK: "off" },
      { ALERT_WEBHOOK_URL: "<TO BE PROVIDED: alert destination>" },
      {
        ALERT_SINK: "webhook",
        ALERT_WEBHOOK_URL: "<TO BE PROVIDED: alert destination>",
      },
    ])
      assert.throws(() => alertConfig(env), /ALERT/);
    assert.throws(
      () => webhookAlertSink("<TO BE PROVIDED: alert destination>"),
      /INVALID_ALERT_WEBHOOK_URL/,
    );
    await assert.rejects(
      fileAlertSink(join(dir, "missing", "file")).deliver(
        alert,
        new AbortController().signal,
      ),
      /ALERT_SINK_FAILED/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sink failures remain pending past the ordinary retry ceiling", async () => {
  const t = await createTestDatabase();
  try {
    const queue = postgresJobQueue(t.pool);
    await queue.enqueue({
      type: "alert.deliver",
      dedupeKey: "ceiling",
      payload: {},
      maxAttempts: 1,
    });
    const job = await queue.lease("ceiling", ["alert.deliver"], 60_000);
    assert.ok(job);
    assert.equal(
      await queue.fail(job, { code: "ALERT_SINK_FAILED", retryable: true }),
      "RETRY",
    );
    assert.equal(
      (await t.pool.query("SELECT state FROM operations.jobs")).rows[0]?.state,
      "QUEUED",
    );
    await t.pool.query("UPDATE operations.jobs SET next_run_at=blink.now()");
    const retry = await queue.lease("ceiling", ["alert.deliver"], 60_000);
    assert.ok(retry);
    await t.pool.query(
      "UPDATE operations.jobs SET lease_until=blink.now()-interval '1 second'",
    );
    const recovered = await queue.lease("recovered", ["alert.deliver"], 60_000);
    assert.ok(
      recovered,
      "crashed delivery workers cannot dead-letter the alert",
    );
    assert.equal(recovered.id, job.id);
  } finally {
    await t.close();
  }
});

import { spawnSync } from "node:child_process";

test("stdout sink emits one safe JSON line", () => {
  const id = randomUUID();
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { stdoutAlertSink } from './packages/adapters/src/alert-sinks.ts'; await stdoutAlertSink().deliver({ dedupeKey: 'alert:${id}', type: 'alert.pause', privateEvidence: 'secret' }, new AbortController().signal);`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    dedupeKey: `alert:${id}`,
    type: "alert.pause",
  });
});

const outboxRow = (
  db: { query: (s: string, p: unknown[]) => Promise<unknown> },
  type: string,
  payload: unknown,
) =>
  db.query(
    "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,$2,'agg',1,$3::jsonb)",
    [randomUUID(), type, JSON.stringify(payload)],
  );

async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return true;
    await delay(10);
  }
  return false;
}

test("a hung alert sink never holds the slot of evidence.fetch or evaluation.score", async () => {
  const t = await createTestDatabase();
  let release!: () => void;
  const hung = new Promise<void>((resolve) => (release = resolve));
  let sinkCalls = 0;
  let loops: ReturnType<typeof startJobLoops> | undefined;
  try {
    const queue = postgresJobQueue(t.pool);
    // The alert is due first, so a shared single-slot loop would lease it before the others.
    await queue.enqueue({
      type: "alert.deliver",
      dedupeKey: "hang",
      payload: { dedupeKey: `alert:${randomUUID()}`, type: "alert.budget" },
    });
    await delay(5);
    for (const type of ["evidence.fetch", "evaluation.score"] as const)
      await queue.enqueue({ type, dedupeKey: type, payload: {} });
    const done: string[] = [];
    loops = startJobLoops({
      queue,
      handlers: {
        "evidence.fetch": async () => void done.push("evidence.fetch"),
        "evaluation.score": async () => void done.push("evaluation.score"),
      },
      alertHandler: createAlertDeliveryHandler({
        async deliver() {
          sinkCalls++;
          await hung;
        },
      }),
      workerId: "loops",
      pollIntervalMs: 10,
    });
    assert.ok(
      await until(async () => done.length === 2),
      "other jobs ran while the sink hung",
    );
    assert.equal(sinkCalls, 1);
    const states = (
      await t.pool.query("SELECT type,state FROM operations.jobs ORDER BY type")
    ).rows;
    assert.deepEqual(states, [
      { type: "alert.deliver", state: "LEASED" },
      { type: "evaluation.score", state: "SUCCEEDED" },
      { type: "evidence.fetch", state: "SUCCEEDED" },
    ]);
    release();
    await loops.stop();
    loops = undefined;
  } finally {
    release();
    await loops?.stop();
    await t.close();
  }
});

test("the alert loop leases only alert.deliver and the main loop never leases it", async () => {
  const t = await createTestDatabase();
  let loops: ReturnType<typeof startJobLoops> | undefined;
  try {
    const queue = postgresJobQueue(t.pool);
    await queue.enqueue({
      type: "alert.deliver",
      dedupeKey: "a",
      payload: { dedupeKey: `alert:${randomUUID()}`, type: "alert.budget" },
    });
    const seen: string[] = [];
    loops = startJobLoops({
      queue,
      handlers: {
        "evidence.fetch": async ({ job }) => void seen.push(job.type),
        // Even if a caller registers it, the main loop must not take alert.deliver.
        "alert.deliver": async ({ job }) => void seen.push("main:" + job.type),
      },
      alertHandler: async ({ job }) => void seen.push("alert:" + job.type),
      workerId: "split",
      pollIntervalMs: 10,
    });
    assert.ok(await until(async () => seen.length === 1));
    await delay(60);
    assert.deepEqual(seen, ["alert:alert.deliver"]);
  } finally {
    await loops?.stop();
    await t.close();
  }
});

async function sinkServer(handler: (status: number) => number | "hang") {
  let calls = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    req.resume();
    const out = handler(++calls);
    if (out !== "hang") res.writeHead(out).end();
  });
  server.on("connection", (s) => sockets.add(s));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    async close() {
      for (const s of sockets) s.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

const deliverJob = (id = randomUUID()) => ({
  id: "j",
  type: "alert.deliver" as const,
  payload: { dedupeKey: `alert:${id}`, type: "alert.budget" },
  attempt: 1,
  maxAttempts: 3,
  leaseToken: "1",
  workerId: "w",
});

test("HTTP 4xx is a distinct permanent sink error except 408 and 429; every failure is retryable", async () => {
  for (const [status, code] of [
    [400, "ALERT_SINK_REJECTED"],
    [401, "ALERT_SINK_REJECTED"],
    [404, "ALERT_SINK_REJECTED"],
    [408, "ALERT_SINK_FAILED"],
    [429, "ALERT_SINK_FAILED"],
    [500, "ALERT_SINK_FAILED"],
    [503, "ALERT_SINK_FAILED"],
  ] as const) {
    const server = await sinkServer(() => status);
    try {
      const handler = createAlertDeliveryHandler(webhookAlertSink(server.url));
      await assert.rejects(
        handler({ job: deliverJob(), signal: new AbortController().signal }),
        (error: { code?: string; retryable?: boolean }) =>
          error.code === code && error.retryable === true,
        String(status),
      );
    } finally {
      await server.close();
    }
  }
});

test("a rejected alert stays queued with its distinct code and is never DEAD or delivered", async () => {
  const t = await createTestDatabase();
  const server = await sinkServer(() => 404);
  let worker: ReturnType<typeof startWorker> | undefined;
  try {
    const queue = postgresJobQueue(t.pool);
    await queue.enqueue({
      type: "alert.deliver",
      dedupeKey: "rejected",
      payload: { dedupeKey: `alert:${randomUUID()}`, type: "alert.budget" },
      maxAttempts: 1,
    });
    worker = startWorker({
      queue,
      handlers: {
        "alert.deliver": createAlertDeliveryHandler(
          webhookAlertSink(server.url),
        ),
      },
      workerId: "rejected",
      pollIntervalMs: 10,
    });
    assert.ok(await until(async () => server.calls() >= 1));
    await worker.stop();
    worker = undefined;
    const row = (
      await t.pool.query("SELECT state,last_error_code FROM operations.jobs")
    ).rows[0]!;
    assert.deepEqual(row, {
      state: "QUEUED",
      last_error_code: "ALERT_SINK_REJECTED",
    });
  } finally {
    await worker?.stop();
    await server.close();
    await t.close();
  }
});

test("the webhook timeout is injectable and a timed-out alert is re-queued, not delivered", async () => {
  const t = await createTestDatabase();
  const server = await sinkServer(() => "hang");
  let worker: ReturnType<typeof startWorker> | undefined;
  try {
    const queue = postgresJobQueue(t.pool);
    await queue.enqueue({
      type: "alert.deliver",
      dedupeKey: "timeout",
      payload: { dedupeKey: `alert:${randomUUID()}`, type: "alert.budget" },
    });
    worker = startWorker({
      queue,
      handlers: {
        "alert.deliver": createAlertDeliveryHandler(
          webhookAlertSink(server.url, { timeoutMs: 50 }),
        ),
      },
      workerId: "timeout",
      pollIntervalMs: 10,
    });
    assert.ok(
      await until(
        async () =>
          (await t.pool.query("SELECT last_error_code FROM operations.jobs"))
            .rows[0]?.last_error_code === "ALERT_SINK_FAILED",
      ),
    );
    await worker.stop();
    worker = undefined;
    assert.equal(
      (await t.pool.query("SELECT state FROM operations.jobs")).rows[0]?.state,
      "QUEUED",
    );
  } finally {
    await worker?.stop();
    await server.close();
    await t.close();
  }
});

test("an abort mid-delivery re-queues the alert instead of acknowledging it", async () => {
  const t = await createTestDatabase();
  const server = await sinkServer(() => "hang");
  const stop = new AbortController();
  let worker: ReturnType<typeof startWorker> | undefined;
  try {
    const queue = postgresJobQueue(t.pool);
    await queue.enqueue({
      type: "alert.deliver",
      dedupeKey: "abort",
      payload: { dedupeKey: `alert:${randomUUID()}`, type: "alert.budget" },
    });
    worker = startWorker({
      queue,
      handlers: {
        "alert.deliver": createAlertDeliveryHandler(
          webhookAlertSink(server.url),
        ),
      },
      workerId: "abort",
      pollIntervalMs: 10,
      signal: stop.signal,
    });
    assert.ok(await until(async () => server.calls() === 1));
    stop.abort();
    await worker.stop();
    worker = undefined;
    const row = (
      await t.pool.query("SELECT state,last_error_code FROM operations.jobs")
    ).rows[0]!;
    assert.deepEqual(row, {
      state: "QUEUED",
      last_error_code: "ALERT_SINK_FAILED",
    });
  } finally {
    await worker?.stop();
    await server.close();
    await t.close();
  }
});

test("webhook URLs must be https except for loopback, with no credentials or fragment", () => {
  for (const ok of [
    "https://alerts.example/hook",
    "http://127.0.0.1:8080/x",
    "http://localhost:9/x",
    "http://[::1]:9/x",
  ])
    assert.equal(isAllowedAlertWebhookUrl(ok), true, ok);
  for (const bad of [
    "http://alerts.example/hook",
    "http://10.0.0.5/hook",
    "ftp://127.0.0.1/x",
    "https://user:pass@alerts.example/x",
    "https://alerts.example/x#frag",
    "<TO BE PROVIDED: alert destination URL>",
    "not a url",
    "",
  ])
    assert.equal(isAllowedAlertWebhookUrl(bad), false, bad);
  assert.throws(
    () => webhookAlertSink("http://alerts.example/hook"),
    /INVALID_ALERT_WEBHOOK_URL/,
  );
  assert.throws(
    () =>
      alertConfig({
        ALERT_SINK: "webhook",
        ALERT_WEBHOOK_URL: "http://alerts.example/hook",
      }),
    /INVALID_ALERT_CONFIGURATION/,
  );
});

test("a non-object alert payload is delivered as a marked minimal alert and never stalls the outbox", async () => {
  for (const bad of [null, [1], "text", 7]) {
    assert.deepEqual(
      alertPayload(
        "11111111-1111-1111-1111-111111111111",
        "alert.budget",
        bad as never,
      ),
      {
        dedupeKey: "alert:11111111-1111-1111-1111-111111111111",
        type: "alert.budget",
        marker: "PAYLOAD_INVALID",
      },
    );
  }
  const t = await createTestDatabase();
  try {
    await outboxRow(t.pool, "alert.budget", null);
    await outboxRow(t.pool, "market.indexed", { marketId: "1" });
    await outboxRow(t.pool, "alert.pause", { marketId: "2" });
    await t.setRole("blink_worker");
    assert.equal(await dispatchOutbox(t.pool, {}), 3);
    const queue = postgresJobQueue(t.pool);
    const payloads = [];
    for (let n = 0; n < 2; n++) {
      const job = await queue.lease("nulls", ["alert.deliver"], 60_000);
      assert.ok(job);
      payloads.push(job.payload);
      await queue.complete(job);
    }
    assert.deepEqual(payloads.map((p) => [p.type, p.marker ?? null]).sort(), [
      ["alert.budget", "PAYLOAD_INVALID"],
      ["alert.pause", null],
    ]);
  } finally {
    await t.close();
  }
});

test("an explicit alert.* mapping adds jobs beside delivery instead of being overridden", async () => {
  const t = await createTestDatabase();
  try {
    await outboxRow(t.pool, "alert.custom", { marketId: "9" });
    await t.setRole("blink_worker");
    await dispatchOutbox(t.pool, {
      "alert.custom": () => [
        { type: "operations.prune", dedupeKey: "extra", payload: {} },
      ],
    });
    const types = (
      await t.pool.query("SELECT type FROM operations.jobs ORDER BY type")
    ).rows.map((r) => r.type);
    assert.deepEqual(types, ["alert.deliver", "operations.prune"]);
  } finally {
    await t.close();
  }
});

test("the projection carries a format-checked deploymentId", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  assert.equal(
    alertPayload(id, "alert.deadline", { deploymentId: "base-sepolia_1" })
      .deploymentId,
    "base-sepolia_1",
  );
  for (const bad of ["", "-x", "a b", "x".repeat(129), "../x", 5])
    assert.equal(
      alertPayload(id, "alert.deadline", { deploymentId: bad }).deploymentId,
      undefined,
    );
});

test("health shows a stalled alert in details only and never as a readiness reason", async () => {
  const t = await createTestDatabase();
  try {
    const queue = postgresJobQueue(t.pool);
    await queue.enqueue({
      type: "alert.deliver",
      dedupeKey: "stalled",
      payload: {},
    });
    const read = async (options?: { alertStallMs?: number }) =>
      postgresHealthReader(t.pool, "none", options).health();
    const alerts = async (options?: { alertStallMs?: number }) =>
      (await read(options)).details.alerts;
    const none = {
      stalled: false,
      stalledCount: "0",
      oldestStalledSeconds: null,
    };
    const job = await queue.lease("h", ["alert.deliver"], 60_000);
    assert.ok(job);
    await queue.fail(job, { code: "ALERT_SINK_FAILED", retryable: true });
    // Failing, but younger than the 15 minute default.
    assert.deepEqual(await alerts(), none);
    await t.pool.query(
      "UPDATE operations.jobs SET created_at=blink.now()-interval '16 minutes'",
    );
    const stalled = await alerts();
    assert.equal(stalled.stalled, true);
    assert.equal(stalled.stalledCount, "1");
    assert.ok(Number(stalled.oldestStalledSeconds) >= 960);
    assert.equal(
      (await read()).reasons.some((r) => String(r).includes("ALERT")),
      false,
    );
    // The threshold is configurable.
    assert.deepEqual(await alerts({ alertStallMs: 3_600_000 }), none);
    await t.pool.query(
      "UPDATE operations.jobs SET last_error_code='ALERT_SINK_REJECTED'",
    );
    assert.equal((await alerts()).stalled, true);
    await t.pool.query(
      "UPDATE operations.jobs SET state='SUCCEEDED',next_run_at=blink.now()",
    );
    assert.deepEqual(await alerts(), none);
  } finally {
    await t.close();
  }
});

test("a hung first attempt counts as a stalled alert: queued or leased, older than the threshold, no error recorded", async () => {
  const t = await createTestDatabase();
  try {
    await t.setRole("blink_worker");
    const queue = postgresJobQueue(t.pool);
    for (const key of ["a", "b"])
      await queue.enqueue({
        type: "alert.deliver",
        dedupeKey: key,
        payload: { dedupeKey: "alert:" + randomUUID(), type: "alert.budget" },
      });
    const alerts = async () =>
      (await postgresHealthReader(t.pool, "none").health()).details.alerts;
    assert.equal((await alerts()).stalled, false);
    await t.pool.query(
      "UPDATE operations.jobs SET created_at=blink.now()-interval '16 minutes'",
    );
    // Both still QUEUED with last_error_code NULL.
    assert.equal((await alerts()).stalledCount, "2");
    // One is now LEASED and hanging (no failure is ever recorded).
    assert.ok(await queue.lease("hung", ["alert.deliver"], 600_000));
    const hung = await alerts();
    assert.equal(hung.stalledCount, "2");
    assert.equal(hung.stalled, true);
    assert.equal(
      (
        await t.pool.query(
          "SELECT count(*)::int AS n FROM operations.jobs WHERE last_error_code IS NOT NULL",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await t.close();
  }
});

test("the worker picks the sink from ALERT_SINK: file and webhook deliver, stdout writes a line, mixed settings are refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-alert-sink-"));
  const alert = { dedupeKey: "alert:" + randomUUID(), type: "alert.budget" };
  const signal = new AbortController().signal;
  const received: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push(body);
      response.writeHead(204).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const write = process.stdout.write;
  try {
    const path = join(directory, "alerts.jsonl");
    await alertSinkFor(
      alertConfig({ ALERT_SINK: "file", ALERT_FILE_PATH: path }),
    ).deliver(alert, signal);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).dedupeKey,
      alert.dedupeKey,
    );
    await alertSinkFor(
      alertConfig({
        ALERT_SINK: "webhook",
        ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
      }),
    ).deliver(alert, signal);
    assert.equal(JSON.parse(received[0]!).dedupeKey, alert.dedupeKey);
    const lines: string[] = [];
    process.stdout.write = ((chunk: string, callback?: () => void) => {
      lines.push(String(chunk));
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    await alertSinkFor(alertConfig({})).deliver(alert, signal);
    process.stdout.write = write;
    assert.equal(JSON.parse(lines[0]!).dedupeKey, alert.dedupeKey);
    for (const env of [
      {
        ALERT_SINK: "stdout",
        ALERT_WEBHOOK_URL: "https://alerts.example/hook",
      },
      { ALERT_SINK: "stdout", ALERT_FILE_PATH: path },
      {
        ALERT_SINK: "file",
        ALERT_FILE_PATH: path,
        ALERT_WEBHOOK_URL: "https://alerts.example/hook",
      },
    ])
      assert.throws(() => alertConfig(env), /INVALID_ALERT_CONFIGURATION/);
  } finally {
    process.stdout.write = write;
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a webhook redirect is refused and never followed", async () => {
  let targetHits = 0;
  const target = createServer((_request, response) => {
    targetHits += 1;
    response.writeHead(204).end();
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const targetPort = (target.address() as { port: number }).port;
  const redirector = createServer((_request, response) => {
    response
      .writeHead(307, { location: `http://127.0.0.1:${targetPort}/elsewhere` })
      .end();
  });
  redirector.listen(0, "127.0.0.1");
  await once(redirector, "listening");
  try {
    const sink = webhookAlertSink(
      `http://127.0.0.1:${(redirector.address() as { port: number }).port}/hook`,
    );
    await assert.rejects(
      sink.deliver(
        { dedupeKey: "alert:" + randomUUID(), type: "alert.budget" },
        new AbortController().signal,
      ),
      (error: { code?: string }) => error.code === "ALERT_SINK_FAILED",
    );
    assert.equal(targetHits, 0);
  } finally {
    redirector.close();
    target.close();
  }
});
