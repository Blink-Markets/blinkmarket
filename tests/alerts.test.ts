import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./helpers/database.js";
import { dispatchOutbox } from "../packages/adapters/src/outbox-dispatcher.js";
import { postgresJobQueue } from "../packages/adapters/src/job-queue.js";

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
