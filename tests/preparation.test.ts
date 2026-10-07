import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi, keccak256 } from "viem";
import type { ImmutableObjectStore } from "../packages/ports/src/index.js";
import { createApprovalService } from "../packages/application/src/approval.js";
import { postgresApprovalStore } from "../packages/adapters/src/approval-store.js";
import { registerVerifiedDeployment } from "../packages/adapters/src/deployment-registry.js";
import { createSpecArchive } from "../packages/adapters/src/spec-archive.js";
import { evidenceIntegrity } from "../packages/adapters/src/evidence-integrity.js";
import { encodeMarketCreation } from "../packages/adapters/src/creation-calldata.js";
import { deploymentFixture } from "./helpers/deployment-fixture.js";
import { creationRpc, hashOf } from "./helpers/creation-rpc.js";
import { createCreationTracker } from "../packages/application/src/creation-tracker.js";
import { creationReceiptReader } from "../packages/adapters/src/creation-receipt-reader.js";
import { postgresCreationTrackerStore } from "../packages/adapters/src/creation-tracker-store.js";
import type { CreationIntent } from "../packages/ports/src/index.js";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { migrate } from "../packages/adapters/src/migrations.js";
import { identityAdmin } from "../packages/adapters/src/identity-admin.js";
import { evidenceAdmin } from "../packages/adapters/src/evidence-admin.js";
import { postgresIdentityStore } from "../packages/adapters/src/identity-store.js";
import { postgresPreparationStore } from "../packages/adapters/src/preparation-store.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import { createPreparationService } from "../packages/application/src/preparation.js";
import { buildApi } from "../apps/api/src/server.js";
import {
  apiContracts,
  EvidenceMetadata,
} from "../packages/schemas/src/index.js";

test("M2 creation tracker: durable observations, read-only API, CAS, rollback and reorg withdrawal", async () => {
  const s = await setup(true);
  try {
    const candidateId = (
      await s.post("/v1/candidates", s.input, "create")
    ).json().candidateId;
    const approved = await s.post(
      `/v1/admin/candidates/${candidateId}/approve`,
      await approvalInput(s),
      "approve",
      3,
    );
    assert.equal(approved.statusCode, 202, approved.body);
    const id = approved.json().creationIntentId;
    const intent = (
      await s.get(`/v1/admin/creation-intents/${id}`, 3)
    ).json() as CreationIntent;
    const path = `/v1/admin/creation-intents/${id}/chain-status`;
    assert.equal((await s.get(path)).statusCode, 401);
    assert.equal((await s.get(path, 0)).statusCode, 403);
    assert.equal((await s.get(path, 3)).json().state, "NOT_TRACKED");
    const rpc = creationRpc(intent),
      store = postgresCreationTrackerStore(s.pool),
      reader = creationReceiptReader(rpc.client);
    const tracker = createCreationTracker(store, reader);
    await assert.rejects(
      tracker.reconcile(id, rpc.txHash),
      /permission denied/,
    );
    await s.db.exec("SET ROLE blink_indexer");
    const included = await tracker.reconcile(id, rpc.txHash);
    assert.equal(included.state, "INCLUDED");
    assert.equal(included.marketId, "9007199254740993");
    const snapshot = (await store.load(id))!;
    rpc.state.head = 21n;
    const observation = await reader.observe(snapshot, rpc.txHash);
    const confirmed = await store.save(
      id,
      snapshot.status.version,
      observation,
    );
    assert.equal(confirmed.state, "CONFIRMED");
    await assert.rejects(
      store.save(id, snapshot.status.version, observation),
      /STALE_CREATION_OBSERVATION/,
    );
    assert.equal(
      (await s.db.query("SELECT * FROM chain.creation_observations")).rows
        .length,
      2,
    );
    await assert.rejects(
      tracker.reconcile(id, hashOf("different tx")),
      /TRACKED_TRANSACTION_CONFLICT/,
    );
    rpc.canonical.set(10n, hashOf("orphaned block"));
    rpc.state.receipt = null;
    rpc.state.tx = null;
    const reorg = await tracker.reconcile(id, rpc.txHash);
    assert.equal(reorg.state, "REORGED");
    assert.equal(reorg.marketId, null);
    assert.equal(
      (
        await s.db.query<{ market_id: string | null }>(
          "SELECT market_id FROM chain.creation_projections",
        )
      ).rows[0]!.market_id,
      null,
    );
    // Immutable observations retain the previously confirmed market ID and old fork hash.
    assert.equal(
      (
        await s.db.query<{ state: string }>(
          "SELECT payload->>'state' AS state FROM chain.creation_observations ORDER BY version",
        )
      ).rows[1]!.state,
      "CONFIRMED",
    );
    Object.assign(rpc.state, rpc.mine(22n, 99n));
    rpc.state.head = 33n;
    await s.db.exec(
      "RESET ROLE; REVOKE INSERT ON operations.audit_log FROM blink_indexer; SET ROLE blink_indexer",
    );
    await assert.rejects(
      tracker.reconcile(id, rpc.txHash),
      /permission denied/,
    );
    assert.equal((await store.load(id))!.status.version, 3);
    assert.equal(
      (await s.db.query("SELECT * FROM chain.creation_observations")).rows
        .length,
      3,
    );
    await s.db.exec(
      "RESET ROLE; GRANT INSERT ON operations.audit_log TO blink_indexer; SET ROLE blink_indexer",
    );
    assert.equal((await tracker.reconcile(id, rpc.txHash)).marketId, "99");
    rpc.state.fail = true;
    await assert.rejects(tracker.reconcile(id, rpc.txHash), /RPC unavailable/);
    assert.equal((await store.load(id))!.status.version, 4);
    await s.db.exec("SET ROLE blink_api");
    const response = await s.get(path, 3);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().state, "CONFIRMED");
    assert.equal(response.json().marketId, "99");
    assert.equal(
      (await s.db.query("SELECT * FROM markets.active_slots")).rows.length,
      1,
    );
    // Candidate history is approval history, not a mutable chain projection.
    assert.equal(
      (await s.get(`/v1/candidates/${candidateId}`, 0)).json().candidate.state,
      "DEPLOY_PENDING",
    );
    await s.db.exec("RESET ROLE");
    await assert.rejects(
      s.db.query("DELETE FROM chain.creation_observations"),
      /append-only/,
    );
  } finally {
    await s.close();
  }
});

async function setup(approval = false) {
  const db = new PGlite();
  await migrate({
    async query(sql, params) {
      if (params) return db.query<Record<string, unknown>>(sql, params);
      return {
        rows:
          ((await db.exec(sql)).at(-1)?.rows as Record<string, unknown>[]) ??
          [],
      };
    },
  });
  // One PGlite session: serialize checkout. This is NOT a multi-connection lock test.
  let previous = Promise.resolve();
  const pool = {
    async connect() {
      const ready = previous;
      let release!: () => void;
      previous = new Promise<void>((r) => {
        release = r;
      });
      await ready;
      return {
        query: (sql: string, params?: unknown[]) => db.query(sql, params),
        release,
      };
    },
  } as unknown as Pool;
  await db.exec("SET ROLE blink_identity_admin");
  const admin = identityAdmin(pool);
  const users = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      admin.invite({
        operatorName: `operator-${i}`,
        agentName: `agent-${i}`,
        scopes: i === 3 ? ["admin"] : ["candidate:write"],
        reason: "test fixture",
      }),
    ),
  );
  const objects = new Map<string, Uint8Array>();
  const objectStore: ImmutableObjectStore = {
    async putIfAbsent(bytes, hash) {
      objects.set(hash, bytes.slice());
      return { uri: hash };
    },
    async read(uri) {
      return objects.get(uri)!;
    },
  };
  const importer = evidenceAdmin(pool, objectStore);
  await db.exec("SET ROLE blink_evidence_admin");
  const { sourceId } = await importer.allowSource(
    "ACME",
    "https://ir.example.test/quarter",
    "Reviewed replay fixture only",
  );
  const evidence = await Promise.all(
    ["PUBLIC", "EXCERPT", "PRIVATE"].map((accessPolicy) =>
      importer.importBytes(
        {
          sourceId,
          operatorId: users[0]!.operatorId,
          publishedAt: null,
          accessPolicy,
          excerpt: accessPolicy === "EXCERPT" ? "Reviewed excerpt" : null,
          reason: "test",
        },
        new TextEncoder().encode("Original statement " + accessPolicy),
      ),
    ),
  );
  if (approval) {
    await db.exec("SET ROLE blink_deployment_admin");
    const fixture = deploymentFixture();
    await registerVerifiedDeployment(
      pool,
      fixture.manifest,
      "test",
      fixture.client,
      fixture.abis,
      "Mock RPC fixture only",
    );
  }
  await db.exec("SET ROLE blink_api");
  const archive = createSpecArchive(objectStore);
  let freezeHook = async () => {};
  const approvalService = createApprovalService({
    store: postgresApprovalStore(pool),
    crypto: identityCrypto,
    archive: {
      read: archive.read,
      async freeze(spec, now) {
        const result = await archive.freeze(spec, now);
        await freezeHook();
        return result;
      },
    },
    publicOrigin: "https://blink.example",
    verifyEvidence: evidenceIntegrity(objectStore),
    encodeCreation: encodeMarketCreation,
  });
  const app = buildApi({
    ...(approval ? { approval: approvalService } : {}),
    identity: createIdentityService(
      postgresIdentityStore(pool),
      identityCrypto,
      "https://blink.example",
    ),
    preparation: createPreparationService(
      postgresPreparationStore(pool),
      identityCrypto,
    ),
  });
  const input = {
    templateId: "GM_LT_V1",
    entityId: "ACME",
    fiscalPeriod: "2025Q1",
    thresholdBps: 4000,
    evidenceIds: [evidence[0]!.evidenceId],
    thesis: "Replay candidate",
  };
  const post = (path: string, body: unknown, key: string, user = 0) =>
    app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: "Bearer " + users[user]!.apiKey,
        "idempotency-key": key,
      },
      payload: body as object,
    });
  const get = (path: string, user?: number) =>
    app.inject({
      method: "GET",
      url: path,
      headers:
        user === undefined
          ? {}
          : { authorization: "Bearer " + users[user]!.apiKey },
    });
  return {
    db,
    objects,
    approvalService,
    setFreezeHook(hook: () => Promise<void>) {
      freezeHook = hook;
    },
    pool,
    importer,
    sourceId,
    users,
    evidence,
    app,
    input,
    post,
    get,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

async function approvalInput(
  s: Awaited<ReturnType<typeof setup>>,
  threshold = 4000,
) {
  const legacy = JSON.parse(
    await readFile("fixtures/replay/market-spec.json", "utf8"),
  );
  const now = Math.floor(Date.now() / 1000);
  return {
    deploymentId: "test",
    expectedRevision: 1,
    budgetMicros: "2000000",
    reason: "Reviewed REPLAY market",
    spec: {
      ...legacy,
      schemaVersion: "blink.market.v0.1.1",
      entityId: s.input.entityId,
      fiscalPeriod: s.input.fiscalPeriod,
      thresholdBps: threshold,
      sourceEvidenceIds: s.input.evidenceIds,
      sourceAllowlist: ["https://ir.example.test/quarter"],
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
  };
}

test("M2 approval: atomic approval, exact public bytes and unsigned admin calldata", async () => {
  const s = await setup(true);
  try {
    const id = (await s.post("/v1/candidates", s.input, "create")).json()
      .candidateId;
    const path = `/v1/admin/candidates/${id}/approve`,
      input = await approvalInput(s);
    assert.equal((await s.post(path, input, "denied", 0)).statusCode, 403);
    const approved = await s.post(path, input, "approve", 3);
    assert.equal(approved.statusCode, 202, approved.body);
    const body = approved.json();
    assert.deepEqual((await s.post(path, input, "approve", 3)).json(), body);
    assert.equal(
      (await s.post(path, { ...input, reason: "Changed" }, "approve", 3)).json()
        .code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(
      (await s.post(path, input, "different-key", 3)).statusCode,
      409,
    );
    const intentPath = `/v1/admin/creation-intents/${body.creationIntentId}`;
    assert.equal((await s.get(intentPath)).statusCode, 401);
    assert.equal((await s.get(intentPath, 0)).statusCode, 403);
    const response = await s.get(intentPath, 3);
    assert.equal(response.statusCode, 200, response.body);
    const intent = response.json();
    assert.equal(intent.state, "AWAITING_ADMIN_SIGNATURE");
    assert.equal(intent.value, "0");
    assert.equal(
      intent.requiredSender,
      deploymentFixture().manifest.roles.admin,
    );
    assert.ok(!("marketId" in intent) && !("txHash" in intent));
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "function createMarket(bytes32,string,uint8,uint64,uint64,uint64,uint32,uint64,uint64) returns (uint256)",
      ]),
      data: intent.calldata,
    });
    assert.deepEqual(decoded.args, [
      body.specHash,
      intent.specUri,
      1,
      BigInt(input.spec.closeAt),
      BigInt(input.spec.proposalDeadline),
      BigInt(input.spec.hardDeadline),
      120,
      10000n,
      500n,
    ]);
    const specResponse = await s.get(new URL(intent.specUri).pathname);
    assert.equal(specResponse.statusCode, 200, specResponse.body);
    assert.equal(
      keccak256(new TextEncoder().encode(specResponse.body)),
      body.specHash,
    );
    assert.equal(
      (await s.get(`/v1/candidates/${id}`, 0)).json().candidate.state,
      "DEPLOY_PENDING",
    );
    assert.equal(
      (
        await s.post(
          `/v1/candidates/${id}/revisions`,
          { ...s.input, expectedRevision: 2 },
          "edit-after",
        )
      ).json().code,
      "CANDIDATE_LOCKED",
    );
    for (const table of ["approvals", "creation_intents", "active_slots"])
      assert.equal(
        (await s.db.query(`SELECT * FROM markets.${table}`)).rows.length,
        1,
      );
    assert.equal(
      (
        await s.db.query(
          "SELECT * FROM operations.outbox WHERE event_type='market.creation_requested'",
        )
      ).rows.length,
      1,
    );
    // A completed response survives disabled/stale deployment policy, but never revoked authentication.
    await s.db.exec(
      "SET ROLE blink_deployment_admin; UPDATE markets.deployments SET enabled=false; SET ROLE blink_api",
    );
    assert.deepEqual((await s.post(path, input, "approve", 3)).json(), body);
    await s.db.exec("SET ROLE blink_identity_admin");
    await identityAdmin(s.pool).revoke(s.users[3]!.keyId, "test");
    await s.db.exec("SET ROLE blink_api");
    assert.equal((await s.post(path, input, "approve", 3)).statusCode, 401);
  } finally {
    await s.close();
  }
});

test("M2 approval: different candidates and thresholds compete for one company-period slot", async () => {
  const s = await setup(true);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        (
          await s.post(
            "/v1/candidates",
            { ...s.input, thresholdBps: 4000 + i },
            `create-${i}`,
            i % 3,
          )
        ).json().candidateId,
      );
    const requests = await Promise.all(
      ids.map((_, i) => approvalInput(s, 4000 + i)),
    );
    const results = await Promise.all(
      ids.map((id, i) =>
        s.post(
          `/v1/admin/candidates/${id}/approve`,
          requests[i],
          `approve-${i}`,
          3,
        ),
      ),
    );
    assert.equal(
      results.filter((r) => r.statusCode === 202).length,
      1,
      results.map((r) => r.body).join("\n"),
    );
    assert.equal(
      results.filter((r) => r.json().code === "MARKET_CAPACITY_CONFLICT")
        .length,
      3,
    );
    assert.equal(
      (await s.db.query("SELECT * FROM markets.creation_intents")).rows.length,
      1,
    );
    assert.equal(
      (
        await s.db.query(
          "SELECT * FROM operations.outbox WHERE event_type='market.creation_requested'",
        )
      ).rows.length,
      1,
    );
  } finally {
    await s.close();
  }
});

test("M2 approval: archive-time policy change and audit failure cannot leave partial intents", async () => {
  const s = await setup(true);
  try {
    const id = (await s.post("/v1/candidates", s.input, "create")).json()
      .candidateId;
    const path = `/v1/admin/candidates/${id}/approve`,
      input = await approvalInput(s);
    s.setFreezeHook(async () => {
      await s.db.exec(
        "SET ROLE blink_evidence_admin; UPDATE evidence.sources SET enabled=false; SET ROLE blink_api",
      );
    });
    assert.equal(
      (await s.post(path, input, "source-change", 3)).json().code,
      "EVIDENCE_NOT_ALLOWED",
    );
    s.setFreezeHook(async () => {});
    await s.db.exec(
      "SET ROLE blink_evidence_admin; UPDATE evidence.sources SET enabled=true; RESET ROLE; REVOKE INSERT ON operations.audit_log FROM blink_api; SET ROLE blink_api",
    );
    const failed = await s.post(path, input, "rollback", 3);
    assert.equal(failed.statusCode, 500, failed.body);
    for (const table of [
      "approvals",
      "specs",
      "creation_intents",
      "active_slots",
    ])
      assert.equal(
        (await s.db.query(`SELECT * FROM markets.${table}`)).rows.length,
        0,
      );
    assert.equal(
      (await s.db.query("SELECT * FROM operations.outbox")).rows.length,
      0,
    );
    assert.equal(
      (await s.get(`/v1/candidates/${id}`, 0)).json().candidate.revision,
      1,
    );
    await s.db.exec(
      "RESET ROLE; GRANT INSERT ON operations.audit_log TO blink_api; SET ROLE blink_api",
    );
    assert.equal((await s.post(path, input, "rollback", 3)).statusCode, 202);
  } finally {
    await s.close();
  }
});

test("M2 approval: unverified deployment and corrupt evidence fail closed; runtime cannot register deployments", async () => {
  const s = await setup(true);
  try {
    const fixture = deploymentFixture();
    await assert.rejects(
      registerVerifiedDeployment(
        s.pool,
        fixture.manifest,
        "test",
        fixture.client,
        fixture.abis,
        "forbidden",
      ),
      /permission denied/,
    );
    const id = (await s.post("/v1/candidates", s.input, "create")).json()
      .candidateId;
    const path = `/v1/admin/candidates/${id}/approve`,
      input = await approvalInput(s);
    assert.equal(
      (
        await s.post(path, { ...input, deploymentId: "missing" }, "missing", 3)
      ).json().code,
      "DEPLOYMENT_NOT_VERIFIED",
    );
    s.objects.set(s.evidence[0]!.contentHash, new Uint8Array([0]));
    assert.equal((await s.post(path, input, "corrupt", 3)).statusCode, 500);
    assert.equal(
      (await s.db.query("SELECT * FROM markets.approvals")).rows.length,
      0,
    );
  } finally {
    await s.close();
  }
});

test("M2 approval: revision, deployment or key changes during archive IO prevent commit", async () => {
  for (const change of ["revision", "deployment", "key"] as const) {
    const s = await setup(true);
    try {
      const id = (await s.post("/v1/candidates", s.input, "create")).json()
        .candidateId;
      s.setFreezeHook(async () => {
        if (change === "revision") {
          const result = await s.post(
            `/v1/candidates/${id}/revisions`,
            { ...s.input, expectedRevision: 1, thesis: "Edited during IO" },
            "edit",
          );
          assert.equal(result.statusCode, 200, result.body);
        } else if (change === "deployment") {
          await s.db.exec(
            "SET ROLE blink_deployment_admin; UPDATE markets.deployments SET enabled=false; SET ROLE blink_api",
          );
        } else {
          await s.db.exec("SET ROLE blink_identity_admin");
          await identityAdmin(s.pool).revoke(
            s.users[3]!.keyId,
            "Revoked during IO",
          );
          await s.db.exec("SET ROLE blink_api");
        }
      });
      const response = await s.post(
        `/v1/admin/candidates/${id}/approve`,
        await approvalInput(s),
        "approval",
        3,
      );
      assert.equal(
        response.json().code,
        change === "revision"
          ? "REVISION_CONFLICT"
          : change === "deployment"
            ? "DEPLOYMENT_NOT_VERIFIED"
            : "UNAUTHORIZED",
        response.body,
      );
      assert.equal(
        (await s.db.query("SELECT * FROM markets.creation_intents")).rows
          .length,
        0,
      );
      assert.equal(
        (await s.db.query("SELECT * FROM operations.outbox")).rows.length,
        0,
      );
    } finally {
      await s.close();
    }
  }
});

test("M2 preparation: evidence privacy, source allowlist and immutable records", async () => {
  const s = await setup();
  try {
    for (const i of [0, 1]) {
      const response = await s.get("/v1/evidence/" + s.evidence[i]!.evidenceId);
      assert.equal(response.statusCode, 200, response.body);
      EvidenceMetadata.parse(response.json());
      assert.ok(
        !response.body.includes("object_uri") &&
          !response.body.includes("operatorId"),
      );
    }
    const privatePath = "/v1/evidence/" + s.evidence[2]!.evidenceId;
    assert.equal((await s.get(privatePath)).statusCode, 404);
    assert.equal((await s.get(privatePath, 1)).statusCode, 404);
    assert.equal((await s.get(privatePath, 0)).statusCode, 200);
    assert.equal((await s.get(privatePath, 3)).statusCode, 200);
    assert.equal(
      (
        await s.post(
          "/v1/candidates",
          { ...s.input, evidenceIds: [s.evidence[2]!.evidenceId] },
          "private",
          1,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await s.post(
          "/v1/candidates",
          { ...s.input, entityId: "OTHER" },
          "entity",
        )
      ).json().code,
      "EVIDENCE_NOT_ALLOWED",
    );
    await assert.rejects(
      s.importer.allowSource("ACME", "https://evil.test/", "forbidden"),
      /permission denied/,
    );
    await s.db.exec("SET ROLE blink_evidence_admin");
    await assert.rejects(
      s.importer.allowSource("ACME", "http://evil.test", "bad"),
      /INVALID_SOURCE/,
    );
    await assert.rejects(
      s.importer.importBytes(
        {
          sourceId: s.sourceId,
          operatorId: s.users[0]!.operatorId,
          publishedAt: null,
          accessPolicy: "EXCERPT",
          excerpt: null,
          reason: "bad",
        },
        new Uint8Array([1]),
      ),
      /EXCERPT/,
    );
    await s.db.query("UPDATE evidence.sources SET enabled=false WHERE id=$1", [
      s.sourceId,
    ]);
    await s.db.exec("SET ROLE blink_api");
    assert.equal(
      (await s.post("/v1/candidates", s.input, "disabled")).json().code,
      "EVIDENCE_NOT_ALLOWED",
    );
    await s.db.exec("RESET ROLE");
    await assert.rejects(
      s.db.query("UPDATE evidence.records SET excerpt='tampered'"),
      /append-only/,
    );
  } finally {
    await s.close();
  }
});

test("M2 preparation: idempotency, ownership, immutable revisions and rejection", async () => {
  const s = await setup();
  try {
    const created = await s.post("/v1/candidates", s.input, "create");
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().candidateId,
      path = "/v1/candidates/" + id;
    assert.deepEqual(
      (await s.post("/v1/candidates", s.input, "create")).json(),
      created.json(),
    );
    assert.equal(
      (
        await s.post(
          "/v1/candidates",
          { ...s.input, thesis: "different" },
          "create",
        )
      ).statusCode,
      409,
    );
    assert.equal((await s.get(path)).statusCode, 404);
    assert.equal((await s.get(path, 1)).statusCode, 404);
    assert.equal((await s.get(path, 3)).statusCode, 200);
    assert.equal(
      (
        await s.post(
          path + "/revisions",
          { ...s.input, expectedRevision: 1 },
          "foreign",
          1,
        )
      ).statusCode,
      404,
    );
    const writes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        s.post(
          path + "/revisions",
          { ...s.input, thesis: `revision-${i}`, expectedRevision: 1 },
          `r-${i}`,
        ),
      ),
    );
    assert.equal(writes.filter((r) => r.statusCode === 200).length, 1);
    assert.equal(writes.filter((r) => r.statusCode === 409).length, 7);
    const reject = "/v1/admin/candidates/" + id + "/reject";
    const reason = {
      expectedRevision: 2,
      reasonCode: "INSUFFICIENT_EVIDENCE",
      reason: "Add the official statement",
    };
    assert.equal((await s.post(reject, reason, "deny", 0)).statusCode, 403);
    const rejected = await s.post(reject, reason, "reject", 3);
    assert.equal(rejected.json().state, "REJECTED", rejected.body);
    assert.equal(rejected.json().revision, 3);
    assert.equal(
      (
        await s.post(
          path + "/revisions",
          { ...s.input, expectedRevision: 3 },
          "resubmit",
        )
      ).statusCode,
      200,
    );
    const history = (await s.get(path, 0)).json();
    apiContracts
      .find((c) => c.path === "/v1/candidates/:id")!
      .response.parse(history);
    assert.deepEqual(
      history.revisions.map((r: { revision: number }) => r.revision),
      [1, 2, 3, 4],
    );
    assert.equal(history.revisions[0].thesis, s.input.thesis);
    await s.db.exec("RESET ROLE");
    await assert.rejects(
      s.db.query("DELETE FROM discovery.candidate_revisions"),
      /append-only/,
    );
    assert.equal((await s.get("/v1/config")).json().tradingEnabled, false);
    const openapi = (await s.get("/openapi.json")).json();
    assert.equal(openapi.paths["/v1/candidates"].post["x-status"], "enabled");
    assert.equal(
      openapi.paths["/v1/admin/candidates/{id}/approve"].post["x-status"],
      "not-implemented",
    );
  } finally {
    await s.close();
  }
});

test("M2 preparation: failed audit rolls back candidate, revision and idempotency", async () => {
  const s = await setup();
  try {
    await s.db.exec(
      "RESET ROLE; REVOKE INSERT ON operations.audit_log FROM blink_api; SET ROLE blink_api",
    );
    assert.equal(
      (await s.post("/v1/candidates", s.input, "rollback")).statusCode,
      500,
    );
    assert.equal(
      (await s.db.query("SELECT * FROM discovery.candidates")).rows.length,
      0,
    );
    assert.equal(
      (
        await s.db.query(
          "SELECT * FROM operations.idempotency_records WHERE key='rollback'",
        )
      ).rows.length,
      0,
    );
    await s.db.exec(
      "RESET ROLE; GRANT INSERT ON operations.audit_log TO blink_api; SET ROLE blink_api",
    );
    assert.equal(
      (await s.post("/v1/candidates", s.input, "rollback")).statusCode,
      201,
    );
    await s.db.exec("SET ROLE blink_identity_admin");
    await identityAdmin(s.pool).revoke(s.users[0]!.keyId, "test revocation");
    await s.db.exec("SET ROLE blink_api");
    assert.equal(
      (await s.post("/v1/candidates", s.input, "rollback")).statusCode,
      401,
    );
  } finally {
    await s.close();
  }
});

test("M2 preparation: seeded multi-user random revisions preserve ownership and monotonic versions", async () => {
  const s = await setup();
  try {
    const ids: string[] = [];
    for (let owner = 0; owner < 3; owner++)
      ids.push(
        (await s.post("/v1/candidates", s.input, "initial", owner)).json()
          .candidateId,
      );
    const revisions = [1, 1, 1];
    let seed = 0xb11a;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 90; i++) {
      const owner = random(3),
        actor = random(3),
        stale = random(4) === 0;
      const expected = stale ? revisions[owner]! + 1 : revisions[owner]!;
      const response = await s.post(
        `/v1/candidates/${ids[owner]}/revisions`,
        { ...s.input, thesis: `step-${i}`, expectedRevision: expected },
        `random-${i}`,
        actor,
      );
      assert.equal(
        response.statusCode,
        owner !== actor ? 404 : stale ? 409 : 200,
        response.body,
      );
      if (response.statusCode === 200) revisions[owner]!++;
    }
    for (let owner = 0; owner < 3; owner++) {
      const history = (
        await s.get("/v1/candidates/" + ids[owner], owner)
      ).json();
      assert.equal(history.candidate.revision, revisions[owner]);
      assert.deepEqual(
        history.revisions.map((r: { revision: number }) => r.revision),
        Array.from({ length: revisions[owner]! }, (_, i) => i + 1),
      );
    }
  } finally {
    await s.close();
  }
});
