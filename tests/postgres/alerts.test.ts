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
        // A real login with only the worker's grants, as the deployed worker runs.
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
        const evaluate = createAlertEvaluateHandler({
          store: postgresAlertEvaluateStore(worker),
          rpc: httpRpcProbe(`http://127.0.0.1:${rpcPort}`),
          policy: { reAlertMs: 60 * 60_000, rpcFailures: 3 },
          keeperOverdueSeconds: 600,
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
          INSERT INTO signing.economic_intents(id,deployment_id,kind,role,dedupe_key,payload,payload_hash,created_by)
          VALUES('00000000-0000-4000-8000-000000000001','drill','FINALIZE_TIMEOUT','keeper','drill-intent','{}',decode(repeat('aa',32),'hex'),'drill');
          INSERT INTO signing.sign_requests(id,intent_id,role,request_hash,unsigned_payload,policy_version,state,reject_code,updated_at)
          VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','keeper',decode(repeat('bb',32),'hex'),'{}','v1','REJECTED','GAS_DAILY_CAP_EXCEEDED',to_timestamp(${NOW - 60}));
          UPDATE chain.markets SET paused=true WHERE market_id=1;
          UPDATE chain.maker_state SET global_paused=true;
          INSERT INTO trading.maker_pools(deployment_id,gate_reason) VALUES('drill','OVERCOMMITTED');
          UPDATE chain.cursors SET synced_at=to_timestamp(${NOW - 1000});
          INSERT INTO operations.jobs(id,type,dedupe_key,payload,state) VALUES('00000000-0000-4000-8000-000000000003','tx.dispatch','drill-dead','{"private":"private-fixture"}','DEAD');`);
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
          "alert.budget|OPEN|role:keeper",
          "alert.indexer_lag|OPEN|indexer",
          "alert.jobs_dead|OPEN|jobs",
          "alert.keeper_overdue|OPEN|market:2",
          "alert.pause|OPEN|global",
          "alert.pause|OPEN|market:1",
          "alert.pause|OPEN|pool",
          "alert.rpc|OPEN|rpc",
        ]);
        const rpcAlert = opened.find((a) => a.type === "alert.rpc")!;
        assert.equal(rpcAlert.reason, "RPC_UNREACHABLE");
        assert.equal(rpcAlert.failures, "3");
        assert.equal(
          opened.find((a) => a.type === "alert.keeper_overdue")!.overdueSeconds,
          "1000",
        );
        assert.equal(
          new Set((await delivered()).map((a) => a.dedupeKey)).size,
          10,
        );
        // Every alert.* row came from a real producer: no injected fixtures.
        assert.equal(
          (
            await owner.query(
              `SELECT count(*)::int AS n FROM operations.outbox WHERE event_type LIKE 'alert.%'
               AND event_type<>'alert.deadline' AND aggregate_id NOT LIKE '["alert","drill",%'`,
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
        rpcServer.listen(rpcPort, "127.0.0.1");
        await once(rpcServer, "listening");
        await owner.query(`
          UPDATE budgets.daily SET gate_closed_reason=NULL;
          UPDATE signing.sign_requests SET updated_at=to_timestamp(${NOW - 90_000});
          UPDATE chain.markets SET paused=false;
          UPDATE chain.maker_state SET global_paused=false;
          UPDATE trading.maker_pools SET gate_reason=NULL;
          UPDATE chain.cursors SET synced_at=to_timestamp(${NOW});
          UPDATE chain.markets SET state='FINAL' WHERE market_id=2;
          UPDATE operations.jobs SET state='SUCCEEDED',finished_at=to_timestamp(${NOW}) WHERE state='DEAD';`);
        await tick();
        await tick();
        await flush();
        const all = await delivered();
        assert.deepEqual(all.slice(10).map(sign).sort(), [
          "alert.budget|CLEARED|daily",
          "alert.budget|CLEARED|role:keeper",
          "alert.indexer_lag|CLEARED|indexer",
          "alert.jobs_dead|CLEARED|jobs",
          "alert.keeper_overdue|CLEARED|market:2",
          "alert.pause|CLEARED|global",
          "alert.pause|CLEARED|market:1",
          "alert.pause|CLEARED|pool",
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
