import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { creationRpc } from "../helpers/creation-rpc.js";
import { creationReceiptReader } from "../../packages/adapters/src/creation-receipt-reader.js";
import { postgresCreationTrackerStore } from "../../packages/adapters/src/creation-tracker-store.js";
import { postgresCreationTrackingSchedule } from "../../packages/adapters/src/creation-tracking-schedule.js";
import { CreationChainStatus } from "../../packages/schemas/src/creation-status.js";
import type { CreationIntent } from "../../packages/ports/src/index.js";
import { readFile } from "node:fs/promises";
import { postgresApprovalStore } from "../../packages/adapters/src/approval-store.js";
import { registerVerifiedDeployment } from "../../packages/adapters/src/deployment-registry.js";
import { createSpecArchive } from "../../packages/adapters/src/spec-archive.js";
import { evidenceIntegrity } from "../../packages/adapters/src/evidence-integrity.js";
import { encodeMarketCreation } from "../../packages/adapters/src/creation-calldata.js";
import { createApprovalService } from "../../packages/application/src/approval.js";
import { deploymentFixture } from "../helpers/deployment-fixture.js";
import type { ImmutableObjectStore } from "../../packages/ports/src/index.js";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { identityAdmin } from "../../packages/adapters/src/identity-admin.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
import { postgresPreparationStore } from "../../packages/adapters/src/preparation-store.js";
import { evidenceAdmin } from "../../packages/adapters/src/evidence-admin.js";
import { createPreparationService } from "../../packages/application/src/preparation.js";
import {
  createIdentityService,
  IdentityError,
} from "../../packages/application/src/identity.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "TEST_POSTGRES_ADMIN_URL_REQUIRED: dedicated local/CI PostgreSQL with CREATEDB and CREATEROLE privileges",
  );

test(
  "real PostgreSQL: concurrent idempotency, one-time nonce and wallet uniqueness",
  { timeout: 30000 },
  async () => {
    // Never migrate or truncate the supplied DB. Create and drop only our random test DB.
    const name = "blink_m2_" + randomUUID().replaceAll("-", "");
    assert.match(name, /^blink_m2_[a-f0-9]{32}$/);
    const control = new pg.Client({ connectionString: adminUrl });
    await control.connect();
    let created = false;
    const databaseUrl = new URL(adminUrl!);
    databaseUrl.pathname = "/" + name;
    const owner = new pg.Pool({
      connectionString: databaseUrl.toString(),
      max: 2,
    });
    const adminPool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      options: "-c role=blink_identity_admin",
      max: 2,
    });
    const apiPool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      options: "-c role=blink_api",
      max: 10,
    });
    const indexerPool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      options: "-c role=blink_indexer",
      max: 3,
    });
    try {
      await control.query(`CREATE DATABASE "${name}"`);
      created = true;
      const migrationClient = await owner.connect();
      try {
        await migrate(migrationClient);
      } finally {
        migrationClient.release();
      }
      const admin = identityAdmin(adminPool);
      const invitation = () =>
        admin.invite({
          operatorName: "Race test",
          agentName: "Race agent",
          scopes: ["trade:quote", "candidate:write"],
          reason: "Isolated PG integration",
        });
      const invited = await invitation();
      const service = createIdentityService(
        postgresIdentityStore(apiPool),
        identityCrypto,
        "https://blink.example",
      );
      // Public deterministic test keys, never funded and never sent to any RPC.
      const wallet = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
      const auth = "Bearer " + invited.apiKey;
      const challengePath = "/v1/auth/wallet-challenges";
      const verifyPath = "/v1/auth/wallet-verifications";
      const request = {
        authorization: auth,
        idempotencyKey: "same",
        body: { address: wallet.address },
        requestId: "pg-test",
      };
      const repeated = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.mutate(challengePath, request).catch((error: unknown) => {
            assert.ok(
              error instanceof IdentityError &&
                error.code === "REQUEST_IN_PROGRESS",
            );
            return null;
          }),
        ),
      );
      const completed = repeated.filter((r) => r !== null);
      assert.ok(completed.length >= 1);
      const c = (await service.mutate(challengePath, request)).body;
      assert.ok(completed.every((r) => r.body.challengeId === c.challengeId));
      assert.equal(
        (await owner.query("SELECT * FROM identity.wallet_challenges"))
          .rowCount,
        1,
      );
      const signature = await wallet.signMessage({
        message: c.message as string,
      });
      const verifications = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          service.mutate(verifyPath, {
            ...request,
            idempotencyKey: "verify-" + i,
            body: { challengeId: c.challengeId, signature },
          }),
        ),
      );
      assert.equal(verifications.filter((r) => r.status === 200).length, 1);
      assert.equal(
        verifications.filter((r) => r.body.code === "WALLET_CHALLENGE_USED")
          .length,
        7,
      );
      assert.equal(
        (await owner.query("SELECT * FROM identity.wallet_bindings")).rowCount,
        1,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT * FROM operations.audit_log WHERE action='identity.wallet_bound'",
          )
        ).rowCount,
        1,
      );

      const bob = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
      const contenders = await Promise.all([invitation(), invitation()]);
      const challenges = await Promise.all(
        contenders.map((key) =>
          service.mutate(challengePath, {
            ...request,
            authorization: "Bearer " + key.apiKey,
            body: { address: bob.address },
          }),
        ),
      );
      const race = await Promise.all(
        contenders.map(async (key, i) =>
          service.mutate(verifyPath, {
            ...request,
            authorization: "Bearer " + key.apiKey,
            idempotencyKey: "race-wallet",
            body: {
              challengeId: challenges[i]!.body.challengeId,
              signature: await bob.signMessage({
                message: challenges[i]!.body.message as string,
              }),
            },
          }),
        ),
      );
      assert.equal(race.filter((r) => r.status === 200).length, 1);
      assert.equal(
        race.filter((r) => r.body.code === "WALLET_ALREADY_BOUND").length,
        1,
      );
      // Real, independently checked-out connections must serialize candidate revisions.
      const objectMap = new Map<string, Uint8Array>();
      const importer = evidenceAdmin(owner, {
        async putIfAbsent(bytes, hash) {
          objectMap.set(hash, bytes);
          return { uri: hash };
        },
        async read(uri) {
          return objectMap.get(uri)!;
        },
      });
      const source = await importer.allowSource(
        "ACME",
        "https://ir.example.test/replay",
        "Test fixture only",
      );
      const evidence = await importer.importBytes(
        {
          sourceId: source.sourceId,
          operatorId: invited.operatorId,
          publishedAt: null,
          accessPolicy: "PUBLIC",
          excerpt: null,
          reason: "PG concurrency fixture",
        },
        new Uint8Array([1, 2, 3]),
      );
      const preparation = createPreparationService(
        postgresPreparationStore(apiPool),
        identityCrypto,
      );
      const input = {
        templateId: "GM_LT_V1",
        entityId: "ACME",
        fiscalPeriod: "2025Q1",
        thresholdBps: 4000,
        evidenceIds: [evidence.evidenceId],
        thesis: "Replay only",
      };
      const prepRequest = {
        authorization: auth,
        idempotencyKey: "candidate",
        params: {},
        query: {},
        body: input,
        requestId: "pg-candidate",
      };
      const candidate = await preparation.handle("/v1/candidates", prepRequest);
      assert.equal(candidate.status, 201);
      const revisions = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          preparation.handle("/v1/candidates/:id/revisions", {
            ...prepRequest,
            params: { id: candidate.body.candidateId },
            idempotencyKey: "revision-" + i,
            body: { ...input, thesis: "writer-" + i, expectedRevision: 1 },
          }),
        ),
      );
      assert.equal(revisions.filter((r) => r.status === 200).length, 1);
      assert.equal(
        revisions.filter((r) => r.body.code === "REVISION_CONFLICT").length,
        7,
      );
      assert.equal(
        (await owner.query("SELECT * FROM discovery.candidate_revisions"))
          .rowCount,
        2,
      );
      const fixture = deploymentFixture();
      await registerVerifiedDeployment(
        owner,
        fixture.manifest,
        "test",
        fixture.client,
        fixture.abis,
        "Mock deployment; real PG locks",
      );
      const approver = await admin.invite({
        operatorName: "Approver",
        agentName: "Human admin",
        scopes: ["admin"],
        reason: "Test approval races",
      });
      const objects: ImmutableObjectStore = {
        async putIfAbsent(bytes, hash) {
          objectMap.set(hash, bytes.slice());
          return { uri: hash };
        },
        async read(uri) {
          return objectMap.get(uri)!;
        },
      };
      const approvals = createApprovalService({
        store: postgresApprovalStore(apiPool),
        crypto: identityCrypto,
        archive: createSpecArchive(objects),
        verifyEvidence: evidenceIntegrity(objects),
        publicOrigin: "https://blink.example",
        encodeCreation: encodeMarketCreation,
      });
      const candidates = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          preparation.handle("/v1/candidates", {
            ...prepRequest,
            idempotencyKey: `capacity-candidate-${i}`,
            body: { ...input, thresholdBps: 4000 + i },
          }),
        ),
      );
      const legacy = JSON.parse(
        await readFile("fixtures/replay/market-spec.json", "utf8"),
      );
      const now = Math.floor(Date.now() / 1000);
      const outcomes = await Promise.all(
        candidates.map((c, i) =>
          approvals
            .approve(String(c.body.candidateId), {
              authorization: "Bearer " + approver.apiKey,
              idempotencyKey: `capacity-${i}`,
              requestId: "capacity-race",
              body: {
                deploymentId: "test",
                expectedRevision: 1,
                budgetMicros: "2000000",
                reason: "REPLAY approval race",
                spec: {
                  ...legacy,
                  schemaVersion: "blink.market.v0.1.1",
                  entityId: "ACME",
                  fiscalPeriod: "2025Q1",
                  thresholdBps: 4000 + i,
                  sourceEvidenceIds: [evidence.evidenceId],
                  sourceAllowlist: ["https://ir.example.test/replay"],
                  closeAt: String(now + 3600),
                  proposalDeadline: String(now + 7200),
                  hardDeadline: String(now + 10800),
                  resolutionPolicy: {
                    hardDeadlineOutcome: "INVALID",
                    unfinalizedProposalAtHardDeadline: "INVALID",
                    invalidPayoutRule: "HALF_PER_SIDE_NOT_PURCHASE_REFUND",
                    authorityModel: "TEAM_OPERATED_WHITELISTED_ROLES",
                  },
                },
              },
            })
            .then((r) => r.status)
            .catch((error: unknown) => {
              assert.ok(
                error instanceof IdentityError &&
                  error.code === "MARKET_CAPACITY_CONFLICT",
              );
              return 409;
            }),
        ),
      );
      assert.equal(outcomes.filter((s) => s === 202).length, 1);
      assert.equal(outcomes.filter((s) => s === 409).length, 3);
      assert.equal(
        (await owner.query("SELECT * FROM markets.active_slots")).rowCount,
        1,
      );
      assert.equal(
        (await owner.query("SELECT * FROM markets.creation_intents")).rowCount,
        1,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT * FROM operations.outbox WHERE event_type='market.creation_requested'",
          )
        ).rowCount,
        1,
      );
      // Mock RPC, real independent PostgreSQL sessions racing the projection CAS.
      const persisted = await owner.query<{ payload: CreationIntent }>(
        "SELECT payload FROM markets.creation_intents",
      );
      const intent = persisted.rows[0]!.payload,
        rpc = creationRpc(intent);
      const tracking = postgresCreationTrackerStore(indexerPool),
        reader = creationReceiptReader(rpc.client);
      const snapshot = (await tracking.load(intent.creationIntentId))!;
      const observation = await reader.observe(snapshot, rpc.txHash);
      const cas = await Promise.allSettled([
        tracking.save(intent.creationIntentId, 0, observation),
        tracking.save(intent.creationIntentId, 0, observation),
      ]);
      assert.equal(cas.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = cas.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      assert.match(String(rejected.reason), /STALE_CREATION_OBSERVATION/);
      assert.equal(
        (await owner.query("SELECT * FROM chain.creation_observations"))
          .rowCount,
        1,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT * FROM operations.outbox WHERE event_type='market.creation_observed'",
          )
        ).rowCount,
        1,
      );
      const schedule = postgresCreationTrackingSchedule(indexerPool);
      const secondIntentId = randomUUID();
      const secondApprovalId = randomUUID();
      const secondCandidateId = String(candidates[1]!.body.candidateId);
      await owner.query(
        `INSERT INTO markets.approvals
           (id,candidate_id,revision,deployment_id,spec_hash,actor_key_id,budget_micros,reason)
         SELECT $1,$2,1,deployment_id,spec_hash,$3,budget_micros,'Isolated poll-schedule fixture'
         FROM markets.approvals WHERE id=$4`,
        [secondApprovalId, secondCandidateId, approver.keyId, intent.approvalId],
      );
      await owner.query(
        `INSERT INTO markets.creation_intents(id,approval_id,state,payload)
         VALUES($1,$2,'AWAITING_ADMIN_SIGNATURE',$3)`,
        [
          secondIntentId,
          secondApprovalId,
          {
            ...intent,
            creationIntentId: secondIntentId,
            approvalId: secondApprovalId,
          },
        ],
      );
      const secondStatus = CreationChainStatus.parse({
        ...observation,
        creationIntentId: secondIntentId,
        version: 1,
        observedAt: new Date().toISOString(),
      });
      await owner.query(
        `INSERT INTO chain.creation_projections
           (intent_id,deployment_id,version,state,market_id,payload)
         VALUES($1,'test',$2,$3,NULL,$4)`,
        [secondIntentId, secondStatus.version, "UNKNOWN", {
          ...secondStatus,
          state: "UNKNOWN",
          marketId: null,
          blockNumber: null,
          blockHash: null,
        }],
      );
      await owner.query(
        `INSERT INTO chain.creation_tracking_schedule(intent_id)
         VALUES($1)`,
        [secondIntentId],
      );
      // A disabled deployment and an untracked projection must never be claimed.
      await owner.query("UPDATE markets.deployments SET enabled=false WHERE id='test'");
      assert.equal(await schedule.claim("disabled-worker", 1000), null);
      await owner.query("UPDATE markets.deployments SET enabled=true WHERE id='test'");
      await owner.query(
        "UPDATE chain.creation_tracking_schedule SET next_run_at=clock_timestamp()+interval '1 hour' WHERE intent_id=$1",
        [secondIntentId],
      );
      const firstPayload = await owner.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM chain.creation_projections WHERE intent_id=$1",
        [intent.creationIntentId],
      );
      await owner.query(
        `UPDATE chain.creation_projections
         SET payload=jsonb_set(payload,'{txHash}','null'::jsonb)
         WHERE intent_id=$1`,
        [intent.creationIntentId],
      );
      await owner.query(
        "UPDATE chain.creation_tracking_schedule SET next_run_at=clock_timestamp()-interval '1 second' WHERE intent_id=$1",
        [secondIntentId],
      );
      assert.equal(await schedule.claim("untracked-worker", 1000), null);
      await owner.query(
        "UPDATE chain.creation_projections SET payload=$2 WHERE intent_id=$1",
        [intent.creationIntentId, firstPayload.rows[0]!.payload],
      );
      // Keep the second record behind the first so two independent PostgreSQL
      // sessions race for one due lease, then prove expiry, fencing and fairness.
      await owner.query(
        `UPDATE chain.creation_tracking_schedule
         SET next_run_at=clock_timestamp()-interval '2 seconds'
         WHERE intent_id=$1`,
        [intent.creationIntentId],
      );
      const competingClaims = await Promise.all([
        schedule.claim("indexer-a", 60_000),
        schedule.claim("indexer-b", 60_000),
      ]);
      assert.equal(competingClaims.filter(Boolean).length, 1);
      const oldLease = competingClaims.find(Boolean)!;
      await owner.query(
        `UPDATE chain.creation_tracking_schedule
         SET lease_until=clock_timestamp()-interval '1 second'
         WHERE intent_id=$1`,
        [oldLease.intentId],
      );
      const reclaimed = await schedule.claim("indexer-restarted", 60_000);
      assert.ok(reclaimed);
      assert.notEqual(reclaimed.leaseToken, oldLease.leaseToken);
      assert.equal(reclaimed.attempt, 0);
      assert.equal(await schedule.complete(oldLease, 1000), false);
      assert.equal(await schedule.fail(oldLease, "STALE_WORKER", 1000), false);
      const observationsBeforeStaleSave = (
        await owner.query("SELECT * FROM chain.creation_observations")
      ).rowCount;
      const outboxBeforeStaleSave = (
        await owner.query(
          "SELECT * FROM operations.outbox WHERE event_type='market.creation_observed'",
        )
      ).rowCount;
      await assert.rejects(
        tracking.save(intent.creationIntentId, 1, observation, oldLease),
        /CREATION_POLL_LEASE_LOST/,
      );
      assert.equal(
        (
          await owner.query<{ version: string }>(
            "SELECT version FROM chain.creation_projections WHERE intent_id=$1",
            [intent.creationIntentId],
          )
        ).rows[0]!.version,
        "1",
      );
      assert.equal(
        (await owner.query("SELECT * FROM chain.creation_observations")).rowCount,
        observationsBeforeStaleSave,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT * FROM operations.outbox WHERE event_type='market.creation_observed'",
          )
        ).rowCount,
        outboxBeforeStaleSave,
      );
      assert.equal(await schedule.fail(reclaimed, "RPC_UNAVAILABLE", 60_000), true);
      const failedRow = (
        await owner.query<{ attempt: number; last_error_code: string }>(
          "SELECT attempt,last_error_code FROM chain.creation_tracking_schedule WHERE intent_id=$1",
          [intent.creationIntentId],
        )
      ).rows[0]!;
      assert.equal(failedRow.attempt, 1);
      assert.equal(failedRow.last_error_code, "RPC_UNAVAILABLE");
      assert.equal((await schedule.health()).failing, 1);
      await owner.query(
        "UPDATE chain.creation_tracking_schedule SET next_run_at=clock_timestamp()-interval '1 second' WHERE intent_id=$1",
        [secondIntentId],
      );
      const fairClaim = await schedule.claim("indexer-fair", 60_000);
      assert.ok(fairClaim);
      assert.equal(fairClaim.intentId, secondIntentId);
      assert.equal(await schedule.complete(fairClaim, 60_000), true);
      assert.equal(
        (await schedule.health()).failing,
        1,
        "one item's failure remains visible after an unrelated successful poll",
      );
      await admin.revoke(invited.keyId, "Post-race revocation");
      await assert.rejects(
        service.mutate(challengePath, request),
        (error: unknown) =>
          error instanceof IdentityError && error.status === 401,
      );
    } finally {
      await Promise.all([
        owner.end(),
        adminPool.end(),
        apiPool.end(),
        indexerPool.end(),
      ]);
      if (created) await control.query(`DROP DATABASE "${name}"`);
      await control.end();
    }
  },
);
