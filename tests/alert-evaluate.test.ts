import { seedProtocolDeployment } from "./helpers/protocol-index.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createTestDatabase } from "./helpers/database.js";
import { seedChain } from "./helpers/protocol-fixture.js";
import { postgresAlertEvaluateStore } from "../packages/adapters/src/alert-evaluate-store.js";
import { alertPayload } from "../packages/adapters/src/alert-payload.js";
import { dispatchOutbox } from "../packages/adapters/src/outbox-dispatcher.js";
import { postgresJobQueue } from "../packages/adapters/src/job-queue.js";
import { httpRpcProbe } from "../packages/adapters/src/rpc-probe.js";
import {
  createAlertEvaluateHandler,
  decideEpisodeChanges,
} from "../packages/application/src/alert-evaluate.js";
import {
  handlers,
  registerAlertEvaluate,
  scheduleAlertEvaluate,
} from "../apps/worker/src/handlers.js";
import { alertEvaluateConfig } from "../apps/worker/src/config.js";
import type { RpcProbe, RpcProbeResult } from "../packages/ports/src/index.js";

const DEPLOYMENT = "alerts";
const MINUTE = 60;
const policy = { reAlertMs: 60 * 60_000, rpcFailures: 3 };

async function world(
  options: {
    rpc?: RpcProbe | null;
    deploymentIds?: string[] | null;
    markets?: boolean;
    onError?: (code: string) => void;
  } = {},
) {
  const t = await createTestDatabase();
  await seedProtocolDeployment(t.pool, DEPLOYMENT);
  if (options.markets !== false)
    await seedChain(t.pool, { deploymentId: DEPLOYMENT });
  await t.pool.query(
    `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at)
     VALUES($1,10,decode(repeat('11',32),'hex'),1000,10,blink.now())`,
    [DEPLOYMENT],
  );
  await t.setRole("blink_worker");
  const handler = createAlertEvaluateHandler({
    store: postgresAlertEvaluateStore(t.pool, {
      onError: options.onError,
      jobLock: false,
    }),
    rpc: options.rpc ?? null,
    policy,
    deploymentIds:
      options.deploymentIds === undefined
        ? [DEPLOYMENT]
        : options.deploymentIds,
  });
  const owner = async <T>(run: () => Promise<T>) => {
    await t.setRole(null);
    try {
      return await run();
    } finally {
      await t.setRole("blink_worker");
    }
  };
  // Fixture writes; parameterless text may hold several statements.
  const sql = (text: string, params?: unknown[]) =>
    owner(async () => {
      if (params) await t.pool.query(text, params);
      else await t.db.exec(text);
    });
  const freshCursor = () =>
    sql(
      "UPDATE chain.cursors SET synced_at=blink.now(),head_timestamp=block_timestamp,head_number=block_number WHERE deployment_id=$1",
      [DEPLOYMENT],
    );
  return {
    t,
    owner,
    sql,
    freshCursor,
    /** Moves the business clock; the cursor stays fresh unless `stale` is set. */
    async clock(seconds: number, stale = false) {
      await t.db.exec(`SET blink.test_clock_offset_seconds='${seconds}'`);
      if (!stale) await freshCursor();
    },
    async run() {
      const queue = postgresJobQueue(t.pool);
      // Each run is a job of its own; the scheduler's 60 s bucket is exercised separately.
      await t.pool.query(
        "INSERT INTO operations.jobs(id,type,dedupe_key,payload,state) VALUES($1,'alert.evaluate',$2,'{}','QUEUED')",
        [randomUUID(), randomUUID()],
      );
      for (;;) {
        const job = await queue.lease("test", ["alert.evaluate"], 60_000);
        if (!job) break;
        await handler({ job, signal: new AbortController().signal });
        await queue.complete(job);
      }
    },
    async alerts(family?: string) {
      const { rows } = await t.pool.query(
        `SELECT event_type,aggregate_id,event_version::text AS version,payload FROM operations.outbox
         WHERE event_type LIKE 'alert.%' ${family ? "AND event_type=$1" : ""} ORDER BY created_at,id`,
        family ? ["alert." + family] : [],
      );
      return rows.map((row) => ({ ...row.payload, version: row.version }));
    },
    close: () => t.close(),
  };
}

const states = (alerts: { state: string }[]) => alerts.map((a) => a.state);

test("episode lifecycle: OPEN once, no duplicate across ticks, STILL_OPEN after the interval, CLEARED once", async () => {
  const w = await world();
  try {
    const gate = (reason: string | null) =>
      w.sql(
        "UPDATE protocol.makers SET data=data||jsonb_build_object('globalPaused',($2::text IS NOT NULL)) WHERE deployment_id=$1",
        [DEPLOYMENT, reason],
      );
    await gate("OVERCOMMITTED");
    await w.run();
    await w.run();
    await w.run();
    let pool = await w.alerts("pause");
    assert.deepEqual(states(pool), ["OPEN"]);
    assert.equal(pool[0].family, "pause");
    assert.equal(pool[0].subject, "global");
    assert.equal(pool[0].reason, "GLOBAL_PAUSED");
    assert.equal(pool[0].deploymentId, DEPLOYMENT);
    assert.match(pool[0].since, /^[0-9]+$/);
    // Still inside the interval 59 minutes later: nothing new.
    await w.clock(59 * MINUTE);
    await w.run();
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN"]);
    // Past the interval: one re-alert, then quiet again until the next interval.
    await w.clock(61 * MINUTE);
    await w.run();
    await w.run();
    pool = await w.alerts("pause");
    assert.deepEqual(states(pool), ["OPEN", "STILL_OPEN"]);
    assert.equal(pool[1].since, pool[0].since);
    await w.clock(100 * MINUTE);
    await w.run();
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN", "STILL_OPEN"]);
    // The condition ends: CLEARED exactly once.
    await gate(null);
    await w.run();
    await w.run();
    pool = await w.alerts("pause");
    assert.deepEqual(states(pool), ["OPEN", "STILL_OPEN", "CLEARED"]);
    assert.equal(pool[2].since, pool[0].since);
    // A new incident is a new episode with a new OPEN.
    await gate("OVERCOMMITTED");
    await w.run();
    assert.deepEqual(states(await w.alerts("pause")), [
      "OPEN",
      "STILL_OPEN",
      "CLEARED",
      "OPEN",
    ]);
    const { rows } = await w.t.pool.query(
      "SELECT active,alert_seq::text FROM operations.alert_episodes WHERE family='pause'",
    );
    assert.deepEqual(rows, [{ active: true, alert_seq: "4" }]);
  } finally {
    await w.close();
  }
});

test("alert.pause fires from the indexed global and per-market pause projection", async () => {
  const w = await world();
  try {
    await w.sql(
      `UPDATE protocol.markets SET data=data||jsonb_build_object('paused',true);
       UPDATE protocol.makers SET data=data||jsonb_build_object('globalPaused',true)`,
    );
    await w.run();
    const open = await w.alerts("pause");
    assert.deepEqual(open.map((a) => [a.subject, a.reason, a.state]).sort(), [
      ["global", "GLOBAL_PAUSED", "OPEN"],
      ["market:1", "MARKET_PAUSED", "OPEN"],
    ]);
    await w.sql(
      `UPDATE protocol.markets SET data=data||jsonb_build_object('paused',false); UPDATE protocol.makers SET data=data||jsonb_build_object('globalPaused',false)`,
    );
    await w.run();
    const all = await w.alerts("pause");
    assert.deepEqual(
      all
        .slice(2)
        .map((a) => [a.subject, a.state])
        .sort(),
      [
        ["global", "CLEARED"],
        ["market:1", "CLEARED"],
      ],
    );
  } finally {
    await w.close();
  }
});

test("alert.indexer_lag uses the health freshness rule and carries block numbers", async () => {
  const w = await world();
  try {
    await w.run();
    assert.deepEqual(await w.alerts("indexer_lag"), []);
    // More than 30 timestamp seconds behind the head.
    await w.sql(
      "UPDATE chain.cursors SET head_number=block_number+4,head_timestamp=block_timestamp+31",
    );
    await w.run();
    let lag = await w.alerts("indexer_lag");
    assert.deepEqual(states(lag), ["OPEN"]);
    assert.equal(lag[0].reason, "LAG_BLOCKS");
    assert.equal(lag[0].blockNumber, "10");
    assert.equal(lag[0].headNumber, "14");
    // Healthy again, then stopped for more than 30 seconds.
    await w.freshCursor();
    await w.run();
    await w.clock(31, true);
    await w.run();
    lag = await w.alerts("indexer_lag");
    assert.deepEqual(states(lag), ["OPEN", "CLEARED", "OPEN"]);
    assert.equal(lag[2].reason, "STALE_CURSOR");
    // A gated cursor reports the gate (a reason change, announced after 10 minutes).
    await w.clock(41 * MINUTE, true);
    await w.sql(
      "UPDATE chain.cursors SET synced_at=blink.now(),gate_reason='REORG_IN_PROGRESS'",
    );
    await w.run();
    await w.run();
    assert.deepEqual(states(await w.alerts("indexer_lag")), [
      "OPEN",
      "CLEARED",
      "OPEN",
      "STILL_OPEN",
    ]);
    await w.sql("UPDATE chain.cursors SET gate_reason=NULL");
    await w.run();
    assert.equal((await w.alerts("indexer_lag")).at(-1).state, "CLEARED");
  } finally {
    await w.close();
  }
});

const scripted = (...results: RpcProbeResult[]): RpcProbe => ({
  async probe() {
    return results.shift() ?? { ok: true };
  },
});

test("alert.rpc opens after 3 consecutive probe failures, a success resets the streak and clears", async () => {
  const fail: RpcProbeResult = { ok: false, reason: "RPC_UNREACHABLE" };
  const w = await world({
    rpc: scripted(fail, fail, { ok: true }, fail, fail, fail, fail, {
      ok: true,
    }),
  });
  try {
    await w.run();
    await w.run();
    assert.deepEqual(await w.alerts("rpc"), []);
    await w.run(); // success resets the streak
    await w.run();
    await w.run();
    assert.deepEqual(await w.alerts("rpc"), []);
    await w.run(); // third consecutive failure
    let rpc = await w.alerts("rpc");
    assert.deepEqual(states(rpc), ["OPEN"]);
    assert.equal(rpc[0].subject, "rpc");
    assert.equal(rpc[0].reason, "RPC_UNREACHABLE");
    assert.equal(rpc[0].failures, "3");
    await w.run(); // fourth failure: still the same episode
    assert.deepEqual(states(await w.alerts("rpc")), ["OPEN"]);
    await w.run(); // first success clears
    rpc = await w.alerts("rpc");
    assert.deepEqual(states(rpc), ["OPEN", "CLEARED"]);
    const { rows } = await w.t.pool.query(
      "SELECT active,consecutive_failures FROM operations.alert_episodes WHERE family='rpc'",
    );
    assert.deepEqual(rows, [{ active: false, consecutive_failures: 0 }]);
  } finally {
    await w.close();
  }
});

test("without a configured RPC the rpc family is not evaluated", async () => {
  const w = await world({ rpc: null });
  try {
    await w.run();
    assert.equal(
      (
        await w.t.pool.query(
          "SELECT count(*)::int AS n FROM operations.alert_episodes WHERE family='rpc'",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await w.alerts("rpc"), []);
  } finally {
    await w.close();
  }
});

test("the RPC probe reports a closed port, a wrong chain, bad answers and a hang as fixed codes", async () => {
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const closedPort = (closed.address() as { port: number }).port;
  closed.close();
  await once(closed, "close");
  const signal = new AbortController().signal;
  assert.deepEqual(
    await httpRpcProbe(`http://127.0.0.1:${closedPort}/key-secret`).probe(
      signal,
    ),
    { ok: false, reason: "RPC_UNREACHABLE" },
  );
  let mode = "ok";
  let chain = "0x14a34";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (mode === "hang") return;
      if (mode === "500") return void response.writeHead(500).end("secret");
      if (mode === "garbage") return void response.end("not json secret");
      const { id, method } = JSON.parse(body);
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: method === "eth_chainId" ? chain : "0x10",
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await httpRpcProbe(url).probe(signal), { ok: true });
    chain = "0x1";
    assert.deepEqual(await httpRpcProbe(url).probe(signal), {
      ok: false,
      reason: "RPC_WRONG_CHAIN",
    });
    mode = "garbage";
    assert.deepEqual(await httpRpcProbe(url).probe(signal), {
      ok: false,
      reason: "RPC_BAD_RESPONSE",
    });
    mode = "500";
    assert.deepEqual(await httpRpcProbe(url).probe(signal), {
      ok: false,
      reason: "RPC_UNREACHABLE",
    });
    mode = "hang";
    const started = Date.now();
    assert.deepEqual(
      await httpRpcProbe(url, { timeoutMs: 100 }).probe(signal),
      {
        ok: false,
        reason: "RPC_UNREACHABLE",
      },
    );
    assert.ok(Date.now() - started < 3000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("alert.evaluate runs with infrastructure configuration only", async () => {
  const w = await world();
  try {
    delete handlers["alert.evaluate"];
    registerAlertEvaluate(
      w.t.pool,
      alertEvaluateConfig({ BLINK_DEPLOYMENT_ID: DEPLOYMENT }),
      { jobLock: false },
    );
    await deadJob(w, "forecast.schedule", 5);
    await scheduleAlertEvaluate(w.t.pool);
    await scheduleAlertEvaluate(w.t.pool);
    const queue = postgresJobQueue(w.t.pool);
    const job = await queue.lease("worker", ["alert.evaluate"], 60_000);
    assert.ok(job);
    assert.equal(await queue.lease("worker", ["alert.evaluate"], 60_000), null);
    await handlers["alert.evaluate"]!({
      job,
      signal: new AbortController().signal,
    });
    assert.deepEqual(states(await w.alerts("jobs_dead")), ["OPEN"]);
  } finally {
    delete handlers["alert.evaluate"];
    await w.close();
  }
});

test("without a configured deployment every registered protocol deployment is evaluated", async () => {
  const w = await world({ deploymentIds: null });
  try {
    await deadJob(w, "forecast.schedule", 5);
    await w.run();
    assert.equal((await w.alerts("jobs_dead")).length, 1);
  } finally {
    await w.close();
  }
});

test("a failed observation neither clears nor emits anything", async () => {
  const calls: string[] = [];
  const handler = createAlertEvaluateHandler({
    store: {
      tryLock: async () => ({ release: async () => {} }),
      deployments: async () => ["d"],
      observe: async () => {
        throw new Error("DATABASE_DOWN");
      },
      transition: async () => {
        calls.push("transition");
        return [];
      },
    },
    rpc: null,
    policy,
    deploymentIds: null,
  });
  await assert.rejects(
    handler({ job: {} as never, signal: new AbortController().signal }),
    /DATABASE_DOWN/,
  );
  assert.deepEqual(calls, []);
});

test("the episode row and its outbox alert commit together", async () => {
  const w = await world();
  try {
    await deadJob(w, "forecast.schedule", 5);
    // The alert cannot be written, so the episode must not be either.
    await w.sql("REVOKE INSERT ON operations.outbox FROM blink_worker");
    await assert.rejects(w.run());
    const { rows } = await w.t.pool.query(
      "SELECT count(*)::int AS n FROM operations.alert_episodes WHERE family='jobs_dead'",
    );
    assert.equal(rows[0].n, 0);
  } finally {
    await w.close();
  }
});

test("alert_episodes is readable and writable by the worker login only", async () => {
  const w = await world();
  try {
    await w.t.pool.query("SELECT count(*) FROM operations.alert_episodes");
    for (const role of ["blink_api", "blink_indexer"]) {
      await w.t.setRole(role);
      await assert.rejects(
        w.t.pool.query("SELECT 1 FROM operations.alert_episodes"),
        /permission denied/,
        role,
      );
    }
    await w.t.setRole("blink_worker");
  } finally {
    await w.close();
  }
});

test("episode alerts reach delivery through a closed allow-list: codes and numbers only", async () => {
  const w = await world();
  try {
    await deadJob(w, "forecast.schedule", 5);
    await w.run();
    // A hostile or buggy row cannot smuggle text through the projection.
    await w.t.pool.query(
      "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,'alert.hostile','hostile',1,$2)",
      [
        randomUUID(),
        {
          deploymentId: DEPLOYMENT,
          family: "not_a_family",
          state: "FINE",
          subject: "Free Text With Spaces",
          reason: "lower case reason https://secret.example",
          since: "yesterday",
          count: "12 apples",
          jobTypes: ["forecast.schedule", "https://secret.example", 7],
          error: "stack trace",
          evidence: "private",
          apiKey: "key",
        },
      ],
    );
    assert.equal(await dispatchOutbox(w.t.pool, {}), 2);
    const queue = postgresJobQueue(w.t.pool);
    const payloads = [];
    for (;;) {
      const job = await queue.lease("test", ["alert.deliver"], 60_000);
      if (!job) break;
      payloads.push(job.payload);
      await queue.complete(job);
    }
    const real = payloads.find((p) => p.type === "alert.jobs_dead")!;
    assert.deepEqual(
      { ...real, dedupeKey: "k", since: "s" },
      {
        dedupeKey: "k",
        type: "alert.jobs_dead",
        family: "jobs_dead",
        state: "OPEN",
        subject: "jobs",
        reason: "DEAD_JOBS",
        since: "s",
        count: "1",
        jobTypes: ["forecast.schedule"],
      },
    );
    const hostile = payloads.find((p) => p.type === "alert.hostile")!;
    assert.deepEqual(Object.keys(hostile).sort(), [
      "dedupeKey",
      "deploymentId",
      "jobTypes",
      "type",
    ]);
    assert.deepEqual(hostile.jobTypes, ["forecast.schedule"]);
    assert.equal(JSON.stringify(payloads).includes("secret"), false);
    // The projection is closed for any input.
    assert.deepEqual(
      Object.keys(
        alertPayload(randomUUID(), "alert.rpc", {
          url: "x",
          reason: "RPC_UNREACHABLE",
        }),
      ).sort(),
      ["dedupeKey", "reason", "type"],
    );
  } finally {
    await w.close();
  }
});

test("episode transitions are decided from the stored state only", () => {
  const now = new Date(10_000_000);
  const ep = (patch = {}) => ({
    family: "jobs_dead" as const,
    subject: "jobs",
    active: true,
    reason: "DEAD_JOBS",
    openedAt: new Date(now.getTime() - 1000),
    lastAlertAt: new Date(now.getTime() - 1000),
    consecutiveFailures: 0,
    lastCount: 0,
    ...patch,
  });
  const seen = {
    family: "jobs_dead" as const,
    subject: "jobs",
    reason: "DEAD_JOBS",
  };
  const base = {
    evaluated: ["jobs_dead"] as const,
    now,
    policy,
    rpc: null,
  };
  assert.deepEqual(
    decideEpisodeChanges({ ...base, episodes: [ep()], observations: [seen] }),
    [],
  );
  assert.deepEqual(
    decideEpisodeChanges({
      ...base,
      episodes: [ep({ active: false })],
      observations: [seen],
    }).map((c) => c.emit?.state),
    ["OPEN"],
  );
  // A new reason inside an open episode is announced, but at most every 10 minutes.
  const reasoned = { ...seen, reason: "OTHER_REASON" };
  assert.deepEqual(
    decideEpisodeChanges({
      ...base,
      episodes: [ep({ lastAlertAt: new Date(now.getTime() - 11 * 60_000) })],
      observations: [reasoned],
    }).map((c) => [c.emit?.state, c.reason]),
    [["STILL_OPEN", "OTHER_REASON"]],
  );
  assert.deepEqual(
    decideEpisodeChanges({
      ...base,
      episodes: [ep()],
      observations: [reasoned],
    }),
    [],
  );
  // The clear is limited to the families that were evaluated.
  assert.deepEqual(
    decideEpisodeChanges({
      ...base,
      episodes: [ep({ family: "rpc", subject: "rpc" })],
      observations: [],
    }),
    [],
  );
});

test("alert.evaluate configuration has defaults, reuses the worker RPC and fails closed on bad values", () => {
  assert.deepEqual(alertEvaluateConfig({}), {
    rpcUrl: null,
    deploymentIds: null,
    rpcFailures: 3,
    reAlertMs: 60 * 60_000,
  });
  assert.deepEqual(
    alertEvaluateConfig({
      BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
      BLINK_DEPLOYMENT_ID: "base-sepolia-1",
      ALERT_RPC_FAILURES: "5",
      ALERT_REALERT_MINUTES: "30",
    }),
    {
      rpcUrl: "http://127.0.0.1:8545",
      deploymentIds: ["base-sepolia-1"],
      rpcFailures: 5,
      reAlertMs: 30 * 60_000,
    },
  );
  for (const env of [
    { ALERT_RPC_FAILURES: "0" },
    { ALERT_RPC_FAILURES: "many" },
    { ALERT_REALERT_MINUTES: "-1" },
    { ALERT_REALERT_MINUTES: "99999" },
    { BASE_SEPOLIA_RPC_URL: "not a url" },
    { BASE_SEPOLIA_RPC_URL: "ftp://rpc.invalid" },
    { BASE_SEPOLIA_RPC_URL: "https://name:secret@rpc.invalid" },
    { BLINK_DEPLOYMENT_ID: "bad id!" },
  ])
    assert.throws(
      () => alertEvaluateConfig(env),
      /^Error: INVALID_ALERT_EVALUATE_CONFIGURATION$/,
      JSON.stringify(env),
    );
});

// --- Fix round 1: unknown is not inactive, no truncation, windowed growth families, global scope ---

const failing = (n: number): RpcProbe =>
  scripted(
    ...Array.from({ length: n }, () => ({
      ok: false as const,
      reason: "RPC_UNREACHABLE",
    })),
  );
const deadJob = (w: Awaited<ReturnType<typeof world>>, type: string, age = 0) =>
  w.sql(
    "INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,finished_at) VALUES($1,$2,$3,'{}','DEAD',blink.now()-$4*interval '1 second')",
    [randomUUID(), type, randomUUID(), age],
  );

test("a gated or missing chain cursor makes pause unknown: no CLEARED, no second OPEN", async () => {
  const w = await world();
  try {
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('paused',true)",
    );
    await w.sql("UPDATE chain.cursors SET block_timestamp=4601");
    await w.run();
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN"]);
    await w.sql("UPDATE chain.cursors SET gate_reason='REORG_IN_PROGRESS'");
    await w.run();
    await w.run();
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN"]);
    // The indexer's own problem is still reported, by its own family.
    assert.equal(
      (await w.alerts("indexer_lag"))[0].reason,
      "REORG_IN_PROGRESS",
    );
    await w.clock(11 * MINUTE, true); // a reason change is announced at most every 10 minutes
    await w.sql("DELETE FROM chain.cursors");
    await w.run();
    assert.equal(
      (await w.alerts("indexer_lag")).at(-1).reason,
      "CURSOR_MISSING",
    );
    await w.sql(
      `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at)
       VALUES('${DEPLOYMENT}',10,decode(repeat('11',32),'hex'),4601,10,blink.now())`,
    );
    await w.run();
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN"]);
    // Once the source is readable and the market is no longer due, it does clear.
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('state','FINAL')",
    );
    await w.run();
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN", "CLEARED"]);
  } finally {
    await w.close();
  }
});

test("episodes beyond 1000 historical rows never cause a duplicate OPEN or stall the rpc streak", async () => {
  const w = await world({ rpc: failing(10) });
  try {
    await w.sql(
      `INSERT INTO operations.alert_episodes(deployment_id,family,subject,active,reason,opened_at,last_alert_at)
       SELECT '${DEPLOYMENT}','pause','market:'||g,false,'MARKET_PAUSED',blink.now(),blink.now()
       FROM generate_series(1000,2400) g`,
    );
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('paused',true)",
    );
    for (let n = 0; n < 5; n++) await w.run();
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN"]);
    const rpc = await w.alerts("rpc");
    assert.deepEqual(states(rpc), ["OPEN"]);
    assert.equal(rpc[0].failures, "3");
  } finally {
    await w.close();
  }
});

test("old inactive episodes are pruned in the evaluation tick, recent ones are kept", async () => {
  const w = await world();
  try {
    await w.sql(
      `INSERT INTO operations.alert_episodes(deployment_id,family,subject,active,reason,opened_at,last_alert_at)
       VALUES('${DEPLOYMENT}','pause','market:98',false,'MARKET_PAUSED',blink.now()-interval '40 days',blink.now()-interval '40 days'),
             ('${DEPLOYMENT}','pause','market:99',false,'MARKET_PAUSED',blink.now()-interval '10 days',blink.now()-interval '10 days')`,
    );
    await w.run();
    const { rows } = await w.t.pool.query(
      "SELECT subject FROM operations.alert_episodes WHERE family='pause' ORDER BY subject",
    );
    assert.deepEqual(rows, [{ subject: "market:99" }]);
  } finally {
    await w.close();
  }
});

test("jobs_dead is active for DEAD jobs of the last 24 hours, re-alerts on growth, has no heartbeat, and clears when the window empties", async () => {
  const w = await world();
  try {
    await deadJob(w, "forecast.schedule", 25 * 3600); // too old to count
    await w.run();
    assert.deepEqual(await w.alerts("jobs_dead"), []);
    await deadJob(w, "forecast.schedule", 60);
    await w.run();
    await w.run();
    let dead = await w.alerts("jobs_dead");
    assert.deepEqual(states(dead), ["OPEN"]);
    assert.equal(dead[0].count, "1");
    assert.equal(dead[0].deploymentId, undefined);
    // A new DEAD job is announced at once, with the new count and types.
    await deadJob(w, "evaluation.score", 30);
    await w.run();
    await w.run();
    dead = await w.alerts("jobs_dead");
    assert.deepEqual(states(dead), ["OPEN", "STILL_OPEN"]);
    assert.equal(dead[1].count, "2");
    assert.deepEqual(dead[1].jobTypes, [
      "evaluation.score",
      "forecast.schedule",
    ]);
    // No hourly heartbeat while the count is unchanged.
    await w.clock(3 * 3600);
    await w.run();
    assert.deepEqual(states(await w.alerts("jobs_dead")), [
      "OPEN",
      "STILL_OPEN",
    ]);
    // Jobs age out of the 24 h window: CLEARED.
    await w.clock(26 * 3600);
    await w.run();
    dead = await w.alerts("jobs_dead");
    assert.equal(dead.at(-1).state, "CLEARED");
    assert.equal(dead.filter((a) => a.state === "CLEARED").length, 1);
  } finally {
    await w.close();
  }
});

test("a paused market that resolves clears its pause episode even though the pause flag stays", async () => {
  const w = await world();
  try {
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('paused',true)",
    );
    await w.run();
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('state','FINAL')",
    );
    await w.run();
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN", "CLEARED"]);
  } finally {
    await w.close();
  }
});

test("global conditions alert once per tick under one global scope, not once per deployment", async () => {
  const w = await world({ deploymentIds: null, rpc: failing(10) });
  try {
    await w.owner(() => seedProtocolDeployment(w.t.pool, "second"));
    await deadJob(w, "forecast.schedule", 10);
    for (let n = 0; n < 3; n++) await w.run();
    for (const [family, subject] of [
      ["jobs_dead", "jobs"],
      ["rpc", "rpc"],
    ] as const) {
      const sent = (await w.alerts(family)).filter(
        (a) => a.subject === subject,
      );
      assert.deepEqual(states(sent), ["OPEN"], family);
      assert.equal(sent[0].deploymentId, undefined, family);
    }
  } finally {
    await w.close();
  }
});

test("a failing family is unknown and logged by code only; the other families still evaluate", async () => {
  const errors: string[] = [];
  const w = await world({ onError: (code) => errors.push(code) });
  try {
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('paused',true)",
    );
    await w.run();
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('paused',false)",
    );
    await w.sql("REVOKE SELECT ON protocol.maker_reads FROM blink_worker");
    await deadJob(w, "forecast.schedule", 10);
    await w.run();
    // The pause family could not be judged: its open episode neither clears nor changes.
    assert.deepEqual(states(await w.alerts("pause")), ["OPEN"]);
    assert.deepEqual(states(await w.alerts("jobs_dead")), ["OPEN"]);
    assert.ok(errors.length > 0);
    for (const code of errors) assert.match(code, /^[A-Z0-9_:a-z]{1,80}$/);
    assert.equal(errors.join().includes("maker_state"), false);
  } finally {
    await w.close();
  }
});

test("more subjects than the bound are truncated, flagged, and never cleared while truncated", async () => {
  const w = await world();
  try {
    await w.sql(
      `INSERT INTO protocol.markets(deployment_id,key,data,as_of_block_hash)
       SELECT deployment_id,g::text,data||jsonb_build_object('marketId',g::text,'specHash','0x'||md5('s'||g)||md5('s'||g)),as_of_block_hash FROM protocol.markets,generate_series(2,150) g WHERE key='1'`,
    );
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('paused',true)",
    );
    await w.run();
    let pause = await w.alerts("pause");
    assert.equal(pause.length, 100);
    assert.ok(pause.every((a) => a.truncated === true));
    // Market 1 is no longer paused, but while truncated nothing is cleared; the window moves on
    // to market 101, which opens.
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('paused',false) WHERE key::numeric=1",
    );
    await w.run();
    pause = await w.alerts("pause");
    assert.equal(pause.length, 101);
    assert.equal(pause.filter((a) => a.state === "CLEARED").length, 0);
    // Back under the bound: the clearing resumes.
    await w.sql(
      "UPDATE protocol.markets SET data=data||jsonb_build_object('paused',false)",
    );
    await w.run();
    pause = await w.alerts("pause");
    assert.equal(pause.filter((a) => a.state === "CLEARED").length, 101);
  } finally {
    await w.close();
  }
});

test("indexer_lag: exactly 30 timestamp seconds behind is healthy, 31 is lag, a missing cursor is CURSOR_MISSING; unpaused markets never alert", async () => {
  const w = await world();
  try {
    await w.sql(
      "UPDATE chain.cursors SET head_number=block_number+3,head_timestamp=block_timestamp+30",
    );
    await w.run();
    assert.deepEqual(await w.alerts("indexer_lag"), []);
    assert.deepEqual(await w.alerts("pause"), []);
    await w.sql("DELETE FROM chain.cursors");
    await w.run();
    const lag = await w.alerts("indexer_lag");
    assert.equal(lag[0].reason, "CURSOR_MISSING");
    assert.equal(lag[0].blockNumber, undefined);
  } finally {
    await w.close();
  }
});

// --- Fix round 2 ---

test("a subject pruned after 30 quiet days reopens with a delivered OPEN and no identity collision", async () => {
  const w = await world();
  try {
    await deadJob(w, "forecast.schedule", 60);
    await w.run();
    await w.clock(25 * 3600);
    await w.run();
    assert.deepEqual(states(await w.alerts("jobs_dead")), ["OPEN", "CLEARED"]);
    // 31 days later the cleared episode is pruned in the tick.
    await w.clock(31 * 24 * 3600);
    await w.run();
    assert.equal(
      (
        await w.t.pool.query(
          "SELECT count(*)::int AS n FROM operations.alert_episodes WHERE family='jobs_dead'",
        )
      ).rows[0].n,
      0,
    );
    await deadJob(w, "forecast.schedule", 10);
    await w.run();
    await w.run();
    assert.deepEqual(states(await w.alerts("jobs_dead")), [
      "OPEN",
      "CLEARED",
      "OPEN",
    ]);
    // Both OPENs are dispatchable: nothing collides on the outbox identity.
    assert.equal(await dispatchOutbox(w.t.pool, {}), 3);
  } finally {
    await w.close();
  }
});

test("a failing scope does not stop the other scopes; the first failure is rethrown afterwards", async () => {
  const seen: string[] = [];
  const handler = createAlertEvaluateHandler({
    store: {
      tryLock: async () => ({ release: async () => {} }),
      deployments: async () => ["d1", "d2"],
      observe: async () => ({ observations: [], unknown: [], truncated: [] }),
      transition: async (scope) => {
        seen.push(scope);
        if (scope === "*" || scope === "d1")
          throw new Error("SCOPE_DOWN:" + scope);
        return [];
      },
    },
    rpc: null,
    policy,
    deploymentIds: null,
  });
  await assert.rejects(
    handler({ job: {} as never, signal: new AbortController().signal }),
    /SCOPE_DOWN:\*/,
  );
  assert.deepEqual(seen, ["*", "d1", "d2"]);
});

test("an alternating rpc reason is announced at most once per 10 minutes", async () => {
  const bad = (reason: string): RpcProbeResult => ({ ok: false, reason });
  const alternating = Array.from({ length: 30 }, (_, n) =>
    bad(n % 2 ? "RPC_BAD_RESPONSE" : "RPC_UNREACHABLE"),
  );
  const w = await world({ rpc: scripted(...alternating) });
  try {
    for (let n = 0; n < 8; n++) await w.run(); // opens at the 3rd probe, then 5 reason flips
    assert.deepEqual(states(await w.alerts("rpc")), ["OPEN"]);
    await w.clock(11 * MINUTE);
    await w.run();
    await w.run();
    const rpc = await w.alerts("rpc");
    assert.deepEqual(states(rpc), ["OPEN", "STILL_OPEN"]);
    assert.notEqual(rpc[1].reason, rpc[0].reason);
  } finally {
    await w.close();
  }
});

test("the RPC probe refuses mainnet with its own code", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () =>
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(body).id,
          result: "0x2105",
        }),
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    assert.deepEqual(
      await httpRpcProbe(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      ).probe(new AbortController().signal),
      { ok: false, reason: "MAINNET_REFUSED" },
    );
  } finally {
    server.close();
  }
});
