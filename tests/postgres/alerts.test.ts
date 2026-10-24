import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchOutbox } from "../../packages/adapters/src/outbox-dispatcher.js";
import { postgresJobQueue } from "../../packages/adapters/src/job-queue.js";
import { postgresResolutionJobsStore } from "../../packages/adapters/src/resolution-store.js";
import { postgresAlertEvaluateStore } from "../../packages/adapters/src/alert-evaluate-store.js";
import { httpRpcProbe } from "../../packages/adapters/src/rpc-probe.js";
import { fileAlertSink } from "../../packages/adapters/src/alert-sinks.js";
import { createAlertDeliveryHandler } from "../../packages/application/src/alerts.js";
import { createAlertEvaluateHandler } from "../../packages/application/src/alert-evaluate.js";
import { createResolutionAlertHandler } from "../../packages/application/src/resolution.js";
import { scheduleResolution } from "../../apps/worker/src/handlers.js";
import { withDatabase } from "../helpers/postgres-database.js";

// Fixed business time (epoch 1_000_000 s) makes the REPLAY 60-second deadline threshold exactly due.
const NOW = 1_000_000;
const sign = (alert: Record<string, unknown>) =>
  `${alert.type}|${alert.state ?? ""}|${alert.subject ?? ""}`;

test(
  "local alert drill: every alert family fires from its real condition, is delivered once, and CLEARED on recovery",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "blink-alert-drill-"));
    let rpcServer: Server | undefined;
    try {
      await withDatabase(async ({ owner, pool }) => {
        // A connection that assumes the blink_worker role, so only the worker's grants apply.
        const worker = pool("blink_worker", 3);
        await owner.query(`CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT to_timestamp(${NOW}) $$;
          INSERT INTO markets.deployments(id,manifest,market_address) VALUES('drill','{}',decode(repeat('11',20),'hex'));
          INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
          VALUES('drill',1,decode(repeat('22',32),'hex'),'fixture','REPLAY',999000,1000030,1000045,120,100,100,'OPEN',1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex')),
                ('drill',2,decode(repeat('23',32),'hex'),'fixture','REPLAY',990000,998000,999000,120,100,100,'OPEN',1,decode(repeat('34',32),'hex'),decode(repeat('44',32),'hex'));
          INSERT INTO chain.maker_state(deployment_id,free_balance_micros,epoch,as_of_block_hash) VALUES('drill',0,0,decode(repeat('44',32),'hex'));
          INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at)
          VALUES('drill',10,decode(repeat('55',32),'hex'),${NOW},10,to_timestamp(${NOW}));`);
        const queue = postgresJobQueue(worker);
        const path = join(directory, "alerts.jsonl");
        const deliver = createAlertDeliveryHandler(fileAlertSink(path));

        // The RPC is a closed local port until the drill "restores" it.
        const closed = createServer();
        closed.listen(0, "127.0.0.1");
        await once(closed, "listening");
        const rpcPort = (closed.address() as { port: number }).port;
        closed.close();
        await once(closed, "close");
        let target = httpRpcProbe(`http://127.0.0.1:${rpcPort}`);
        const evaluate = createAlertEvaluateHandler({
          store: postgresAlertEvaluateStore(worker),
          rpc: { probe: (signal) => target.probe(signal) },
          policy: { reAlertMs: 60 * 60_000, rpcFailures: 3 },
          deploymentIds: ["drill"],
        });
        const signal = new AbortController().signal;
        const tick = async () => {
          await queue.enqueue({
            type: "alert.evaluate",
            dedupeKey: randomUUID(),
            payload: {},
          });
          const job = await queue.lease("drill", ["alert.evaluate"], 60_000);
          assert.ok(job);
          await evaluate({ job, signal });
          assert.equal(await queue.complete(job), true);
        };
        const flush = async () => {
          await dispatchOutbox(worker, {});
          for (;;) {
            const job = await queue.lease("drill", ["alert.deliver"], 60_000);
            if (!job) break;
            await deliver({ job, signal });
            assert.equal(await queue.complete(job), true);
          }
        };
        const delivered = async () =>
          (await readFile(path, "utf8").catch(() => ""))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);

        // alert.deadline from the scheduler, with no keeper, signer or RPC process.
        await scheduleResolution(worker);
        const deadlineJob = await queue.lease(
          "drill",
          ["resolution.alerts"],
          60_000,
        );
        assert.ok(deadlineJob);
        await createResolutionAlertHandler(postgresResolutionJobsStore(worker))(
          {
            job: deadlineJob,
            signal,
          },
        );
        await queue.complete(deadlineJob);

        await flush();
        assert.deepEqual((await delivered()).map(sign), ["alert.deadline||"]);

        // Real conditions, written the way the system would.
        await owner.query(`
          INSERT INTO budgets.daily(day,gate_closed_reason) VALUES((to_timestamp(${NOW}) AT TIME ZONE 'UTC')::date,'OVERRUN');
          UPDATE chain.markets SET paused=true WHERE market_id=1;
          UPDATE chain.maker_state SET global_paused=true;
          UPDATE chain.cursors SET synced_at=to_timestamp(${NOW - 1000});
          INSERT INTO operations.jobs(id,type,dedupe_key,payload,state) VALUES('00000000-0000-4000-8000-000000000003','evaluation.score','drill-dead','{"private":"private-fixture"}','DEAD');
          UPDATE operations.jobs SET finished_at=to_timestamp(${NOW - 30}) WHERE state='DEAD';`);
        // The RPC streak: two failures are not an incident yet.
        await tick();
        await tick();
        await flush();
        assert.equal(
          (await delivered()).filter((a) => a.type === "alert.rpc").length,
          0,
        );
        await tick();
        await flush();
        const opened = (await delivered()).slice(1);
        assert.deepEqual(opened.map(sign).sort(), [
          "alert.budget|OPEN|daily",
          "alert.indexer_lag|OPEN|indexer",
          "alert.jobs_dead|OPEN|jobs",
          "alert.pause|OPEN|global",
          "alert.pause|OPEN|market:1",
          "alert.rpc|OPEN|rpc",
        ]);
        const rpcAlert = opened.find((a) => a.type === "alert.rpc")!;
        assert.equal(rpcAlert.reason, "RPC_UNREACHABLE");
        assert.equal(rpcAlert.failures, "3");
        assert.equal(
          new Set((await delivered()).map((a) => a.dedupeKey)).size,
          7,
        );
        // Every alert.* row came from a real producer: no injected fixtures.
        assert.equal(
          (
            await owner.query(
              `SELECT count(*)::int AS n FROM operations.outbox WHERE event_type LIKE 'alert.%'
               AND event_type<>'alert.deadline' AND aggregate_id NOT LIKE '["alert",%'`,
            )
          ).rows[0].n,
          0,
        );
        // More ticks while everything stays broken add nothing.
        await tick();
        await flush();
        assert.equal((await delivered()).length, 10);

        // Recovery: each condition ends and is reported once as CLEARED.
        rpcServer = createServer((request, response) => {
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            const { id, method } = JSON.parse(body);
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: method === "eth_chainId" ? "0x14a34" : "0x10",
              }),
            );
          });
        });
        rpcServer.listen(0, "127.0.0.1");
        await once(rpcServer, "listening");
        target = httpRpcProbe(
          `http://127.0.0.1:${(rpcServer.address() as { port: number }).port}`,
        );
        await owner.query(`
          UPDATE budgets.daily SET gate_closed_reason=NULL;
          UPDATE chain.markets SET paused=false;
          UPDATE chain.maker_state SET global_paused=false;
          UPDATE chain.cursors SET synced_at=to_timestamp(${NOW});
          UPDATE chain.markets SET state='FINAL' WHERE market_id=2;
          UPDATE operations.jobs SET state='SUCCEEDED',finished_at=to_timestamp(${NOW}) WHERE state='DEAD';`);
        await tick();
        await tick();
        await flush();
        const all = await delivered();
        assert.deepEqual(all.slice(7).map(sign).sort(), [
          "alert.budget|CLEARED|daily",
          "alert.indexer_lag|CLEARED|indexer",
          "alert.jobs_dead|CLEARED|jobs",
          "alert.pause|CLEARED|global",
          "alert.pause|CLEARED|market:1",
          "alert.rpc|CLEARED|rpc",
        ]);

        // Delivery history cannot be replayed into duplicate deliveries.
        await owner.query("UPDATE operations.outbox SET dispatched_at=NULL");
        await dispatchOutbox(worker, {});
        assert.equal(
          await queue.lease("drill", ["alert.deliver"], 60_000),
          null,
        );
        assert.equal(all.length, 19);
        assert.equal(JSON.stringify(all).includes("private"), false);
      });
    } finally {
      rpcServer?.closeAllConnections();
      rpcServer?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

const RACE_SETUP = `INSERT INTO markets.deployments(id,manifest,market_address) VALUES('race','{}',decode(repeat('11',20),'hex'));
  INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,finished_at)
  VALUES('00000000-0000-4000-8000-000000000009','evaluation.score','race-dead','{}','DEAD',now());`;
const evaluator = (
  worker: Parameters<typeof postgresAlertEvaluateStore>[0],
  options: Parameters<typeof postgresAlertEvaluateStore>[1] = {},
  onSkip?: (code: string) => void,
) =>
  createAlertEvaluateHandler({
    store: postgresAlertEvaluateStore(worker, options),
    rpc: null,
    policy: { reAlertMs: 60 * 60_000, rpcFailures: 3 },
    deploymentIds: ["race"],
    ...(onSkip ? { onSkip } : {}),
  });
const run = (handler: ReturnType<typeof evaluator>) =>
  handler({ job: {} as never, signal: new AbortController().signal });
const raceAlerts = async (owner: {
  query: (sql: string) => Promise<{ rows: unknown[] }>;
}) =>
  (
    await owner.query(
      `SELECT event_type,payload->>'state' AS state FROM operations.outbox WHERE event_type LIKE 'alert.%' ORDER BY event_type`,
    )
  ).rows;
// jobs_dead (global) and the missing cursor of the deployment: one OPEN each.
const RACE_EXPECTED = [
  { event_type: "alert.indexer_lag", state: "OPEN" },
  { event_type: "alert.jobs_dead", state: "OPEN" },
];

test(
  "concurrent alert.evaluate runs emit one OPEN per episode: the per-scope lock alone, and the job lock",
  { timeout: 60_000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      const worker = pool("blink_worker", 12);
      await owner.query(RACE_SETUP);
      // Without the job lock, four evaluators race on the transaction lock.
      const racing = () => evaluator(worker, { jobLock: false });
      await Promise.all([
        run(racing()),
        run(racing()),
        run(racing()),
        run(racing()),
      ]);
      assert.deepEqual(await raceAlerts(owner), RACE_EXPECTED);
    });
    await withDatabase(async ({ owner, pool }) => {
      const worker = pool("blink_worker", 12);
      await owner.query(RACE_SETUP);
      const skipped: string[] = [];
      const guarded = () => evaluator(worker, {}, (code) => skipped.push(code));
      await Promise.all([
        run(guarded()),
        run(guarded()),
        run(guarded()),
        run(guarded()),
      ]);
      assert.deepEqual(await raceAlerts(owner), RACE_EXPECTED);
      assert.ok(skipped.length >= 1);
      assert.ok(
        skipped.every((code) => code === "ALERT_EVALUATE_SKIPPED_OVERLAP"),
      );
    });
  },
);

test(
  "a tick is skipped, not failed, while another evaluator holds the job lock",
  { timeout: 60_000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      const worker = pool("blink_worker", 4);
      await owner.query(RACE_SETUP);
      const skipped: string[] = [];
      const holder = await owner.connect();
      try {
        await holder.query(
          "SELECT pg_advisory_lock(hashtextextended('alert.evaluate:job',0))",
        );
        await run(evaluator(worker, {}, (code) => skipped.push(code)));
        assert.deepEqual(skipped, ["ALERT_EVALUATE_SKIPPED_OVERLAP"]);
        assert.deepEqual(await raceAlerts(owner), []);
      } finally {
        await holder.query(
          "SELECT pg_advisory_unlock(hashtextextended('alert.evaluate:job',0))",
        );
        holder.release();
      }
      await run(evaluator(worker, {}, (code) => skipped.push(code)));
      assert.deepEqual(await raceAlerts(owner), RACE_EXPECTED);
      assert.equal(skipped.length, 1);
    });
  },
);
