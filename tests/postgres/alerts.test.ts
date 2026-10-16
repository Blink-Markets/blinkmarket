import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { dispatchOutbox } from "../../packages/adapters/src/outbox-dispatcher.js";
import { postgresJobQueue } from "../../packages/adapters/src/job-queue.js";
import { postgresResolutionJobsStore } from "../../packages/adapters/src/resolution-store.js";
import { fileAlertSink } from "../../packages/adapters/src/alert-sinks.js";
import { createAlertDeliveryHandler } from "../../packages/application/src/alerts.js";
import { createResolutionAlertHandler } from "../../packages/application/src/resolution.js";
import { scheduleResolution } from "../../apps/worker/src/handlers.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_POSTGRES_ADMIN_URL_REQUIRED");

test(
  "local alert drill: five alert families delivered once; scheduler produces deadline without a keeper",
  { timeout: 30_000 },
  async () => {
    const name = "blink_a4_" + randomUUID().replaceAll("-", "");
    const control = new pg.Client({ connectionString: adminUrl });
    const url = new URL(adminUrl!);
    url.pathname = "/" + name;
    const owner = new pg.Pool({ connectionString: url.toString(), max: 2 });
    const worker = new pg.Pool({
      connectionString: url.toString(),
      options: "-c role=blink_worker",
      max: 3,
    });
    const directory = await mkdtemp(join(tmpdir(), "blink-alert-drill-"));
    let created = false;
    await control.connect();
    try {
      await control.query(`CREATE DATABASE "${name}"`);
      created = true;
      const client = await owner.connect();
      try {
        await migrate(client);
      } finally {
        client.release();
      }
      // Fixed DB business time makes exactly the REPLAY 60-second threshold due.
      await owner.query(`CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT to_timestamp(1000000) $$;
      INSERT INTO markets.deployments(id,manifest,market_address) VALUES('drill','{}',decode(repeat('11',20),'hex'));
      INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
      VALUES('drill',1,decode(repeat('22',32),'hex'),'fixture','REPLAY',999000,1000030,1000045,120,100,100,'OPEN',1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'));`);
      const queue = postgresJobQueue(worker);
      // No keeper handler, signer, RPC or keeper process exists in this harness.
      await scheduleResolution(worker);
      await scheduleResolution(worker);
      const deadlineJob = await queue.lease(
        "scheduler-drill",
        ["resolution.alerts"],
        60_000,
      );
      assert.ok(deadlineJob);
      await createResolutionAlertHandler(postgresResolutionJobsStore(worker))({
        job: deadlineJob,
        signal: new AbortController().signal,
      });
      await queue.complete(deadlineJob);
      assert.equal(
        await queue.lease("scheduler-drill", ["resolution.alerts"], 60_000),
        null,
      );
      // The other families are injected outbox fixtures: their producers are outside delivery's scope.
      for (const type of [
        "alert.budget",
        "alert.pause",
        "alert.rpc_failure",
        "alert.indexer_lag",
      ])
        await worker.query(
          "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,$2,'drill',1,$3)",
          [randomUUID(), type, { secret: "private-fixture" }],
        );
      await Promise.all([
        dispatchOutbox(worker, {}),
        dispatchOutbox(worker, {}),
      ]);
      const path = join(directory, "alerts.jsonl");
      const deliver = createAlertDeliveryHandler(fileAlertSink(path));
      for (let n = 0; n < 5; n++) {
        const job = await queue.lease(
          "delivery-drill",
          ["alert.deliver"],
          60_000,
        );
        assert.ok(job);
        await deliver({ job, signal: new AbortController().signal });
        assert.equal(await queue.complete(job), true);
      }
      assert.equal(
        await queue.lease("delivery-drill", ["alert.deliver"], 60_000),
        null,
      );
      // Re-dispatching outbox history cannot create duplicate deliveries.
      await worker.query("UPDATE operations.outbox SET dispatched_at=NULL");
      await dispatchOutbox(worker, {});
      assert.equal(
        await queue.lease("delivery-drill", ["alert.deliver"], 60_000),
        null,
      );
      const alerts = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(alerts.length, 5);
      assert.deepEqual(alerts.map((a) => a.type).sort(), [
        "alert.budget",
        "alert.deadline",
        "alert.indexer_lag",
        "alert.pause",
        "alert.rpc_failure",
      ]);
      assert.equal(new Set(alerts.map((a) => a.dedupeKey)).size, 5);
      assert.equal(JSON.stringify(alerts).includes("private-fixture"), false);
      assert.equal(
        alerts.find((a) => a.type === "alert.deadline").thresholdSeconds,
        60,
      );
    } finally {
      await worker.end();
      await owner.end();
      if (created) {
        // pool.end() resolves before the sockets close; let the sessions leave first so
        // DROP ... FORCE never kills a client that is still shutting down.
        for (let i = 0; i < 100; i += 1) {
          const { rows } = await control.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
            [name],
          );
          if (rows[0].n === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
      await control.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
