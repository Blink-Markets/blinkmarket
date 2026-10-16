import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { identityAdmin } from "../../packages/adapters/src/identity-admin.js";
import {
  seedDeployment,
  seedChain,
  testManifest,
} from "../helpers/signer-fixture.js";
import { postgresOperatorStatusStore } from "../../packages/adapters/src/operator-status-store.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl) throw new Error("TEST_POSTGRES_ADMIN_URL_REQUIRED");
test("real PostgreSQL: operator status reads under blink_api grants, approval isolation and exact money", async () => {
  const name = "blink_a3_" + randomUUID().replaceAll("-", "");
  const control = new pg.Client({ connectionString: adminUrl });
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  const owner = new pg.Pool({ connectionString: url.toString() });
  const api = new pg.Pool({
    connectionString: url.toString(),
    options: "-c role=blink_api -c default_transaction_read_only=on",
  });
  let created = false;
  await control.connect();
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(owner);
    const manifest = testManifest();
    await seedDeployment(owner, manifest);
    await seedChain(owner, {
      deploymentId: manifest.deploymentId,
      state: "DISPUTED",
    });
    const operator = await identityAdmin(owner).invite({
      operatorName: "operator",
      agentName: "admin",
      scopes: ["admin"],
      reason: "test",
    });
    const operatorId = (
      await owner.query(
        "SELECT operator_id FROM identity.api_keys WHERE id=$1",
        [operator.keyId],
      )
    ).rows[0].operator_id;
    const candidateId = randomUUID(),
      approvalId = randomUUID(),
      intentId = randomUUID();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO discovery.candidates(id,operator_id,current_revision) VALUES ($1,$2,1)",
        [candidateId, operatorId],
      );
      await client.query(
        "INSERT INTO discovery.candidate_revisions(candidate_id,revision,snapshot) VALUES ($1,1,$2)",
        [
          candidateId,
          JSON.stringify({
            candidateId,
            revision: 1,
            state: "APPROVED",
            thesis: "private evidence",
          }),
        ],
      );
      await client.query(
        "INSERT INTO markets.specs(hash,object_uri,public_uri) VALUES (decode(repeat('ab',32),'hex'),'private-object','https://blink.example/spec')",
      );
      await client.query(
        "INSERT INTO markets.approvals(id,candidate_id,revision,deployment_id,spec_hash,actor_key_id,budget_micros,reason) VALUES ($1,$2,1,$3,decode(repeat('ab',32),'hex'),$4,2000000,'private-reason')",
        [approvalId, candidateId, manifest.deploymentId, operator.keyId],
      );
      await client.query(
        "INSERT INTO markets.creation_intents(id,approval_id,state,payload) VALUES ($1,$2,'AWAITING_ADMIN_SIGNATURE','{}')",
        [intentId, approvalId],
      );
      await client.query(
        "INSERT INTO discovery.candidate_revisions(candidate_id,revision,snapshot) VALUES ($1,2,$2)",
        [
          candidateId,
          JSON.stringify({
            candidateId,
            revision: 2,
            state: "DEPLOY_PENDING",
            thesis: "private evidence",
          }),
        ],
      );
      await client.query(
        "UPDATE discovery.candidates SET current_revision=2 WHERE id=$1",
        [candidateId],
      );
      await client.query("COMMIT");
    } finally {
      await client.release();
    }
    await owner.query(
      "INSERT INTO operations.jobs(id,type,dedupe_key,payload,state) VALUES ($1,'private','private','{}','DEAD')",
      [randomUUID()],
    );
    await owner.query(
      "INSERT INTO budgets.daily(day) VALUES ((blink.now() AT TIME ZONE 'UTC')::date)",
    );
    await owner.query(
      "INSERT INTO budgets.questions(question_key,cap_usd_micros) VALUES ('private',2000000)",
    );
    await owner.query(
      "INSERT INTO budgets.reservations(id,day,question_key,run_id,provider,model,max_usd_micros,state,actual_usd_micros) VALUES ($1,(blink.now() AT TIME ZONE 'UTC')::date,'private',$2,'private','private',1,'RECONCILED',9007199254740993)",
      [randomUUID(), randomUUID()],
    );
    const store = postgresOperatorStatusStore(api, manifest.deploymentId);
    const candidates = await store.candidates(operatorId, "DEPLOY_PENDING");
    assert.deepEqual(candidates.items[0]?.approval, {
      approvalId,
      deploymentId: manifest.deploymentId,
      budgetMicros: "2000000",
      creationIntentId: intentId,
      state: "AWAITING_ADMIN_SIGNATURE",
    });
    assert.deepEqual(await store.candidates(randomUUID()), {
      items: [],
      truncated: false,
    });
    assert.equal(candidates.truncated, false);
    assert.equal((await store.jobs()).items.length, 1);
    assert.equal(
      (await store.budgets()).daily.spentUsdMicros,
      "9007199254740993",
    );
    assert.equal((await store.pause()).globalPaused, false);
    assert.equal(
      (await store.resolutions(operatorId)).items[0]?.state,
      "DISPUTED",
    );
    // 100 DEAD jobs plus the one above: newest 100 returned, truncated, newest first.
    await owner.query(
      `INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,created_at)
       SELECT gen_random_uuid(),'private','k'||i,'{}','DEAD',timestamptz '2026-01-01 00:00:00+00' + i * interval '1 second'
       FROM generate_series(1,100) i`,
    );
    const jobs = await store.jobs();
    assert.equal(jobs.items.length, 100);
    assert.equal(jobs.truncated, true);
    assert.ok(
      jobs.items.every(
        (j, i) => i === 0 || jobs.items[i - 1]!.createdAt >= j.createdAt,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(candidates),
      /private|actorKey|operatorId/,
    );
    await assert.rejects(
      api.query("UPDATE budgets.daily SET cap_usd_micros=0"),
      /read-only|permission denied/,
    );
    await assert.rejects(
      api.query("SELECT raw_transaction FROM signing.artifacts"),
      /permission denied/,
    );
  } finally {
    await Promise.all([owner.end(), api.end()]);
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
  }
});
