import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { identityAdmin } from "../../packages/adapters/src/identity-admin.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import {
  EvidenceUnreadableError,
  postgresResolutionJobsStore,
  postgresResolutionStore,
} from "../../packages/adapters/src/resolution-store.js";
import {
  createResolutionAlertHandler,
  createResolutionParseHandler,
  createResolutionService,
} from "../../packages/application/src/resolution.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;

// Creates and drops a random database; never touches the supplied one.
async function withDatabase(
  run: (db: {
    owner: pg.Pool;
    api: pg.Pool;
    worker: pg.Pool;
    reporter: { apiKey: string; operatorId: string; keyId: string };
    admin: { apiKey: string; keyId: string };
  }) => Promise<void>,
) {
  const name = "blink_t11_" + randomUUID().replaceAll("-", "");
  const control = new pg.Client({ connectionString: adminUrl });
  await control.connect();
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  const owner = new pg.Pool({ connectionString: url.toString(), max: 3 });
  const api = new pg.Pool({
    connectionString: url.toString(),
    max: 2,
    options: "-c role=blink_api",
  });
  const worker = new pg.Pool({
    connectionString: url.toString(),
    max: 4,
    options: "-c role=blink_worker",
  });
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    const migration = await owner.connect();
    try {
      await migrate(migration);
    } finally {
      migration.release();
    }
    const invite = (scopes: ("report:write" | "admin")[]) =>
      identityAdmin(owner).invite({
        operatorName: "fixture",
        agentName: "fixture",
        scopes,
        reason: "resolution fixture",
      });
    await run({
      owner,
      api,
      worker,
      reporter: await invite(["report:write"]),
      admin: await invite(["admin"]),
    });
  } finally {
    await Promise.all([owner.end(), api.end(), worker.end()]);
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
  }
}

const marketFixture = (state: string, proposedAgoSeconds: number) =>
  `INSERT INTO markets.deployments(id,manifest,market_address) VALUES('test','{}',decode(repeat('11',20),'hex'));
   INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,proposed_at,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
   VALUES('test',1,decode(repeat('22',32),'hex'),'fixture','REPLAY',floor(extract(epoch from blink.now()))-3600,9999999999,9999999999,120,floor(extract(epoch from blink.now()))-${proposedAgoSeconds},100,100,'${state}',1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'));`;

const jobContext = (type: "resolution.parse" | "resolution.alerts") => ({
  job: {
    id: "fixture",
    payload: {},
    type,
    attempt: 1,
    maxAttempts: 3,
    leaseToken: "1",
    workerId: "test",
  },
  signal: new AbortController().signal,
});

test(
  "real PostgreSQL: reports, replay and triage work under the least-privilege API role",
  { skip: !adminUrl, timeout: 30000 },
  () =>
    withDatabase(async ({ owner, api, reporter, admin }) => {
      await owner.query(marketFixture("OPEN", 0));
      const source = randomUUID(),
        evidence = randomUUID();
      await owner.query(
        "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES($1,'fixture','https://fixture.invalid/report')",
        [source],
      );
      await owner.query(
        "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy) VALUES($1,$2,$3,decode(repeat('55',32),'hex'),'fixture','PRIVATE')",
        [evidence, source, reporter.operatorId],
      );
      const service = createResolutionService({
        store: postgresResolutionStore(api),
        crypto: identityCrypto,
      });
      const call = (
        method: "GET" | "POST",
        path: string,
        key: string,
        params: Record<string, string>,
        query: Record<string, string>,
        body: unknown,
        agent: { apiKey: string },
      ) =>
        service.handle({
          method,
          path,
          params,
          query,
          body,
          authorization: "Bearer " + agent.apiKey,
          idempotencyKey: method === "POST" ? key : undefined,
          requestId: randomUUID(),
        } as never);
      const report = () =>
        call(
          "POST",
          "/v1/markets/:id/resolution-reports",
          "report-1",
          { id: "1" },
          { deploymentId: "test" },
          { outcome: "YES", evidenceIds: [evidence], reason: "Official result" },
          reporter,
        );
      const first = await report();
      assert.equal(first.status, 202);
      assert.deepEqual(await report(), first);
      const reportId = (first.body as { reportId: string }).reportId;
      for (const state of ["TRIAGED", "ACTIONED"])
        await call(
          "POST",
          "/v1/admin/resolution-reports/:id/triage",
          state,
          { id: reportId },
          {},
          { state, reason: "Human reviewed" },
          admin,
        );
      const listed = (await call(
        "GET",
        "/v1/admin/resolution-reports",
        "",
        {},
        { deploymentId: "test", limit: "20" },
        undefined,
        admin,
      )) as unknown as {
        body: { items: { reportId: string; state: string }[] };
      };
      assert.deepEqual(
        listed.body.items.map((i) => [i.reportId, i.state]),
        [[reportId, "ACTIONED"]],
      );
      assert.equal(
        (await owner.query("SELECT 1 FROM resolution.report_events")).rowCount,
        3,
      );
      await assert.rejects(
        api.query("UPDATE resolution.reports SET reason=reason"),
        /permission denied|resolution\.reports/,
      );
    }),
);

test(
  "real PostgreSQL: concurrent workers emit each deadline alert exactly once",
  { skip: !adminUrl, timeout: 30000 },
  () =>
    withDatabase(async ({ owner, worker }) => {
      // 25 s of challenge window left: REPLAY thresholds 60 and 30 are reached, 10 is not.
      await owner.query(marketFixture("PROPOSED", 95));
      const handler = createResolutionAlertHandler(
        postgresResolutionJobsStore(worker),
      );
      await Promise.all(
        Array.from({ length: 4 }, () =>
          handler(jobContext("resolution.alerts")),
        ),
      );
      const sent = await owner.query<{ kind: string; threshold_seconds: number }>(
        "SELECT kind,threshold_seconds FROM resolution.alerts_sent WHERE kind='CHALLENGE_END' ORDER BY threshold_seconds",
      );
      assert.deepEqual(
        sent.rows.map((r) => r.threshold_seconds),
        [30, 60],
      );
      assert.equal(
        (
          await owner.query(
            "SELECT 1 FROM operations.outbox WHERE event_type='alert.deadline' AND payload->>'kind'='CHALLENGE_END'",
          )
        ).rowCount,
        2,
      );
    }),
);

test(
  "real PostgreSQL: concurrent parse scans store each suggestion and manual-review or unreadable audit once",
  { skip: !adminUrl, timeout: 30000 },
  () =>
    withDatabase(async ({ owner, worker, reporter, admin }) => {
      await owner.query(marketFixture("OPEN", 0));
      const candidate = randomUUID(),
        source = randomUUID();
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO discovery.candidates(id,operator_id,current_revision) VALUES($1,$2,1)",
          [candidate, reporter.operatorId],
        );
        await client.query(
          "INSERT INTO discovery.candidate_revisions(candidate_id,revision,snapshot) VALUES($1,1,$2)",
          [
            candidate,
            {
              candidateId: candidate,
              revision: 1,
              state: "APPROVED",
              templateId: "GM_LT_V1",
              entityId: "fixture",
              thresholdBps: 6125,
            },
          ],
        );
        await client.query(
          "INSERT INTO markets.specs(hash,object_uri,public_uri) VALUES(decode(repeat('22',32),'hex'),'fixture','fixture')",
        );
        await client.query(
          "INSERT INTO markets.approvals(id,candidate_id,revision,deployment_id,spec_hash,actor_key_id,budget_micros,reason) VALUES($1,$2,1,'test',decode(repeat('22',32),'hex'),$3,1,'fixture')",
          [randomUUID(), candidate, admin.keyId],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await owner.query(
        "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES($1,'fixture','https://fixture.invalid/report')",
        [source],
      );
      for (const uri of ["yes", "ambiguous", "missing"])
        await owner.query(
          "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy,observed_at) VALUES($1,$2,$3,decode(repeat('66',32),'hex'),$4,'PRIVATE',blink.now())",
          [randomUUID(), source, reporter.operatorId, uri],
        );
      const handler = createResolutionParseHandler(
        postgresResolutionJobsStore(worker),
        async (uri) => {
          if (uri === "missing")
            throw new EvidenceUnreadableError("EVIDENCE_OBJECT_MISSING");
          return uri === "yes"
            ? "GAAP gross margin 61.24%"
            : "GAAP gross margin 61.255%";
        },
      );
      await Promise.all(
        Array.from({ length: 4 }, () => handler(jobContext("resolution.parse"))),
      );
      const suggestions = await owner.query<{ outcome: string }>(
        "SELECT outcome FROM resolution.suggestions",
      );
      assert.deepEqual(
        suggestions.rows.map((r) => r.outcome),
        ["YES"],
      );
      assert.equal(
        (
          await owner.query(
            "SELECT 1 FROM operations.audit_log WHERE action='resolution.manual_required'",
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT 1 FROM operations.audit_log WHERE action='resolution.evidence_unreadable'",
          )
        ).rowCount,
        1,
      );
    }),
);
