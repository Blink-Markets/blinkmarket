import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { createTestDatabase, inviteAgent } from "./helpers/database.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import { postgresResolutionStore } from "../packages/adapters/src/resolution-store.js";
import { createResolutionService } from "../packages/application/src/resolution.js";
import { buildApi } from "../apps/api/src/server.js";
import { apiContracts } from "../packages/schemas/src/index.ts";

async function setup() {
  const t = await createTestDatabase();
  const reporter = await inviteAgent(t, {
    name: "reporter",
    scopes: ["report:write"],
  });
  const admin = await inviteAgent(t, { name: "auditor", scopes: ["admin"] });
  const source = randomUUID(),
    evidence = randomUUID();
  await t.db
    .exec(`INSERT INTO markets.deployments(id,manifest,market_address) VALUES('test','{}',decode(repeat('11',20),'hex'));
 INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
 VALUES('test',1,decode(repeat('22',32),'hex'),'fixture','REPLAY',floor(extract(epoch from blink.now()))+7200,9999999999,9999999999,120,100,100,'OPEN',1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'));`);
  await t.db.query(
    "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES($1,'fixture','https://fixture.invalid/report')",
    [source],
  );
  await t.db.query(
    "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy) VALUES($1,$2,$3,decode(repeat('55',32),'hex'),'fixture','PRIVATE')",
    [evidence, source, reporter.operatorId],
  );
  const store = postgresResolutionStore(t.pool);
  const app = buildApi({
    services: [createResolutionService({ store, crypto: identityCrypto })],
  });
  const body = {
    outcome: "YES",
    evidenceIds: [evidence],
    reason: "Reviewed official result",
  };
  const post = (key: string, agent = reporter, payload = body, market = "1") =>
    app.inject({
      method: "POST",
      url: `/v1/markets/${market}/resolution-reports?deploymentId=test`,
      headers: {
        authorization: "Bearer " + agent.apiKey,
        "idempotency-key": key,
      },
      payload,
    });
  await t.setRole("blink_api");
  return {
    t,
    app,
    store,
    reporter,
    admin,
    body,
    post,
    source,
    evidence,
    async close() {
      await app.close();
      await t.close();
    },
  };
}
async function approveMarket(s: Awaited<ReturnType<typeof setup>>) {
  await s.t.setRole(null);
  const candidate = randomUUID();
  await s.t.db.exec("BEGIN");
  await s.t.db.query(
    "INSERT INTO discovery.candidates(id,operator_id,current_revision) VALUES($1,$2,1)",
    [candidate, s.reporter.operatorId],
  );
  await s.t.db.query(
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
  await s.t.db.exec(
    "INSERT INTO markets.specs(hash,object_uri,public_uri) VALUES(decode(repeat('22',32),'hex'),'fixture','fixture')",
  );
  await s.t.db.query(
    "INSERT INTO markets.approvals(id,candidate_id,revision,deployment_id,spec_hash,actor_key_id,budget_micros,reason) VALUES($1,$2,1,'test',decode(repeat('22',32),'hex'),$3,1,'fixture')",
    [randomUUID(), candidate, s.admin.keyId],
  );
  await s.t.db.exec("COMMIT");
}
test("reports enforce visibility and scope, replay idempotently, and triage appends audited events", async () => {
  const s = await setup();
  try {
    const result = await s.post("first");
    assert.equal(result.statusCode, 202, result.body);
    assert.deepEqual((await s.post("first")).json(), result.json());
    assert.equal(
      (await s.post("first", s.reporter, { ...s.body, outcome: "NO" })).json()
        .code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(
      (await s.post("unknown", s.reporter, s.body, "2")).statusCode,
      404,
    );
    const stranger = await inviteAgent(s.t, {
      name: "stranger",
      scopes: ["report:write"],
    });
    assert.equal((await s.post("private", stranger)).statusCode, 409);
    const publicEvidence = randomUUID();
    await s.t.setRole(null);
    await s.t.db.query(
      "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy) VALUES($1,$2,$3,decode(repeat('56',32),'hex'),'public','PUBLIC')",
      [publicEvidence, s.source, s.reporter.operatorId],
    );
    await s.t.setRole("blink_api");
    assert.equal(
      (
        await s.post("public", stranger, {
          ...s.body,
          evidenceIds: [publicEvidence],
        })
      ).statusCode,
      202,
    );
    assert.equal((await s.post("permission", s.admin)).statusCode, 403);
    const url = "/v1/admin/resolution-reports";
    assert.equal(
      (
        await s.app.inject({
          url: url + "?deploymentId=test",
          headers: { authorization: "Bearer " + s.reporter.apiKey },
        })
      ).statusCode,
      403,
    );
    const triage = (key: string, state: string) =>
      s.app.inject({
        method: "POST",
        url: url + "/" + result.json().reportId + "/triage",
        headers: {
          authorization: "Bearer " + s.admin.apiKey,
          "idempotency-key": key,
        },
        payload: { state, reason: "Human reviewed" },
      });
    for (const state of ["TRIAGED", "DISMISSED", "ACTIONED"]) {
      const r = await triage(state, state);
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual((await triage(state, state)).json(), r.json());
    }
    const list = await s.app.inject({
      url: url + "?deploymentId=test&state=ACTIONED",
      headers: { authorization: "Bearer " + s.admin.apiKey },
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().items.length, 1);
    assert.equal(list.json().items[0].state, "ACTIONED");
    apiContracts
      .find((c) => c.method === "GET" && c.path === url)!
      .response.parse(list.json());
    assert.equal(
      (await s.t.db.query("SELECT * FROM resolution.report_events")).rows
        .length,
      5,
    );
    const audits = (
      await s.t.db.query<{ action: string; reason: string }>(
        "SELECT action,reason FROM operations.audit_log WHERE action LIKE 'resolution.%'",
      )
    ).rows;
    assert.equal(audits.length, 5);
    for (const audit of audits)
      assert.equal(
        audit.reason,
        audit.action === "resolution.report_received"
          ? "Resolution report received; advisory only, no chain action"
          : "Resolution report triage appended",
      );
    await assert.rejects(
      s.t.db.exec("UPDATE resolution.reports SET reason=reason"),
      /permission denied/,
    );
    assert.equal(
      (await s.t.db.query<{ state: string }>("SELECT state FROM chain.markets"))
        .rows[0]!.state,
      "OPEN",
    );
  } finally {
    await s.close();
  }
});

test("deadline alerts use DB time and emit each LIVE/REPLAY threshold once", async () => {
  const { createResolutionAlertHandler } =
    await import("../packages/application/src/resolution.js");
  const { postgresResolutionJobsStore } =
    await import("../packages/adapters/src/resolution-store.js");
  const s = await setup();
  try {
    await s.t.setRole(null);
    await s.t.db
      .exec(`CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT to_timestamp(1000000 + COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds',true),''),'0')::integer) $$;
 UPDATE chain.markets SET state='PROPOSED',proposed_at=999880,hard_deadline=1000000,close_at=999000;`);
    const handler = createResolutionAlertHandler(
      postgresResolutionJobsStore(s.t.pool),
    );
    const ctx = {
      job: {
        id: "fixture",
        payload: {},
        type: "resolution.alerts" as const,
        attempt: 1,
        maxAttempts: 3,
        leaseToken: "1",
        workerId: "test",
      },
      signal: new AbortController().signal,
    };
    for (const mode of ["REPLAY", "LIVE"]) {
      await s.t.setRole(null);
      await s.t.db.query(
        "UPDATE chain.markets SET mode=$1,challenge_seconds=$2,proposed_at=$3",
        [
          mode,
          mode === "LIVE" ? 86400 : 120,
          mode === "LIVE" ? 913600 : 999880,
        ],
      );
      await s.t.setRole("blink_worker");
      for (const threshold of mode === "LIVE"
        ? [86400, 3600, 600]
        : [60, 30, 10]) {
        await s.t.db.query(
          "SELECT set_config('blink.test_clock_offset_seconds',$1,false)",
          [String(-threshold)],
        );
        await handler(ctx);
        await handler(ctx);
      }
    }
    assert.equal(
      (await s.t.db.query("SELECT * FROM resolution.alerts_sent")).rows.length,
      12,
    );
    assert.equal(
      (
        await s.t.db.query(
          "SELECT * FROM operations.outbox WHERE event_type='alert.deadline'",
        )
      ).rows.length,
      12,
    );
    await s.t.db.exec("SET blink.test_clock_offset_seconds='1'");
    await handler(ctx);
    assert.equal(
      (await s.t.db.query("SELECT * FROM resolution.alerts_sent")).rows.length,
      12,
    );
  } finally {
    await s.close();
  }
});

test("parser job requires approval, close and entity evidence; saves strict-threshold suggestions and audits ambiguity once", async () => {
  const { createResolutionParseHandler } =
    await import("../packages/application/src/resolution.js");
  const { postgresResolutionJobsStore } =
    await import("../packages/adapters/src/resolution-store.js");
  const s = await setup();
  try {
    await approveMarket(s);
    const text = "GAAP gross margin 61.25%";
    const handler = createResolutionParseHandler(
      postgresResolutionJobsStore(s.t.pool),
      async () => text,
    );
    const ctx = {
      job: {
        id: "fixture",
        payload: {},
        type: "resolution.parse" as const,
        attempt: 1,
        maxAttempts: 3,
        leaseToken: "1",
        workerId: "test",
      },
      signal: new AbortController().signal,
    };
    await s.t.setRole("blink_worker");
    await handler(ctx);
    assert.equal(
      (
        await s.t.db.query<{ outcome: string; value_bps: number }>(
          "SELECT * FROM resolution.suggestions",
        )
      ).rows.length,
      0,
    );
    await s.t.setRole(null);
    await s.t.db.exec(
      "UPDATE chain.markets SET close_at=floor(extract(epoch from blink.now()))-60",
    );
    // These records must not be parsed: another entity, or observed before close.
    const otherSource = randomUUID();
    await s.t.db.query(
      "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES($1,'other','https://fixture.invalid/other')",
      [otherSource],
    );
    await s.t.db.query(
      "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy,observed_at) VALUES($1,$2,$3,decode(repeat('77',32),'hex'),'other','PUBLIC',blink.now()),($4,$5,$3,decode(repeat('88',32),'hex'),'old','PUBLIC',blink.now()-interval '1 day')",
      [
        randomUUID(),
        otherSource,
        s.reporter.operatorId,
        randomUUID(),
        s.source,
      ],
    );
    // A closed projection without a matching approval is also ignored.
    await s.t.db.exec(
      "UPDATE chain.markets SET spec_hash=decode(repeat('99',32),'hex')",
    );
    await s.t.setRole("blink_worker");
    await handler(ctx);
    assert.equal(
      (await s.t.db.query("SELECT * FROM resolution.suggestions")).rows.length,
      0,
    );
    await s.t.setRole(null);
    await s.t.db.exec(
      "UPDATE chain.markets SET spec_hash=decode(repeat('22',32),'hex')",
    );
    await s.t.setRole("blink_worker");
    await handler(ctx);
    await handler(ctx);
    const rows = (
      await s.t.db.query<{ outcome: string; value_bps: number }>(
        "SELECT * FROM resolution.suggestions",
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "NO");
    assert.equal(rows[0]!.value_bps, 6125);
    await s.t.setRole(null);
    for (const [uri, source] of [
      ["ambiguous", s.source],
      ["yes", s.source],
    ] as const)
      await s.t.db.query(
        "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy) VALUES($1,$2,$3,decode(repeat('66',32),'hex'),$4,'PRIVATE')",
        [randomUUID(), source, s.reporter.operatorId, uri],
      );
    const mixed = createResolutionParseHandler(
      postgresResolutionJobsStore(s.t.pool),
      async (uri) =>
        uri === "yes"
          ? "GAAP gross margin 61.24%"
          : "GAAP gross margin 61.255%",
    );
    await s.t.setRole("blink_worker");
    await mixed(ctx);
    await mixed(ctx);
    assert.equal(
      (
        await s.t.db.query(
          "SELECT * FROM resolution.suggestions WHERE outcome='YES'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await s.t.db.query(
          "SELECT * FROM operations.audit_log WHERE action='resolution.manual_required'",
        )
      ).rows.length,
      1,
    );
    await assert.rejects(
      s.t.db.exec("INSERT INTO resolution.reports DEFAULT VALUES"),
      /permission denied/,
    );
  } finally {
    await s.close();
  }
});

test("draft command encodes unsigned calls for manifest roles and warns about timing", async () => {
  const { resolutionDraftCommand } =
    await import("../scripts/resolution-draft.js");
  const { decodeFunctionData } = await import("viem");
  const { blinkMarketAbi } =
    await import("../packages/adapters/src/blink-abi.js");
  const s = await setup();
  try {
    const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
    const hash = "0x" + "11".repeat(32);
    const manifest = {
      status: "DEPLOYED",
      deploymentId: "test",
      chainId: 84532,
      deploymentBlock: "1",
      contracts: { BlinkMarket: addr(17), BlinkTestUSD: addr(18) },
      roles: {
        admin: addr(1),
        resultProposer: addr(2),
        challenger: addr(3),
        arbiter: addr(4),
        maker: addr(5),
        faucetMinter: addr(6),
      },
      artifacts: {
        abiHashes: { BlinkMarket: hash, BlinkTestUSD: hash },
        bytecodeHashes: { BlinkMarket: hash, BlinkTestUSD: hash },
        compiler: "0.8.30",
        gitCommit: "1".repeat(40),
        dependencies: { openzeppelin: "5.6.1" },
      },
      parameters: {
        collateralDecimals: 6,
        quoteDefaultTtlSeconds: 30,
        quoteMaxTtlSeconds: 60,
        makerSpreadBps: 200,
        maxFillShares: "100",
        maxMarketPairs: "10000",
        maxTakerShares: "500",
      },
      tradingEnabled: false,
    };
    await s.t.setRole(null);
    await s.t.db.query(
      "UPDATE markets.deployments SET manifest=$1,market_address=decode($2,'hex')",
      [manifest, addr(17).slice(2)],
    );
    await s.t.setRole("blink_api");
    for (const [action, fn, role] of [
      ["propose", "proposeOutcome", addr(2)],
      ["challenge", "challengeOutcome", addr(3)],
      ["arbitrate", "arbitrate", addr(4)],
    ] as const) {
      const args = [
        "--deployment",
        "test",
        "--market",
        "1",
        "--action",
        action,
        "--outcome",
        "NO",
        "--evidence-hash",
        hash,
      ];
      const draft = await resolutionDraftCommand(args, s.t.pool);
      assert.equal(draft.chainId, 84532);
      assert.equal(draft.to, addr(17));
      assert.equal(draft.requiredSender, role);
      assert.equal(draft.value, "0");
      const decoded = decodeFunctionData({
        abi: blinkMarketAbi,
        data: draft.data,
      });
      assert.equal(decoded.functionName, fn);
      assert.deepEqual(
        decoded.args,
        action === "challenge" ? [1n, hash] : [1n, 1, hash],
      );
      if (action === "propose")
        assert.ok(draft.warnings.includes("PROPOSE_BEFORE_CLOSE"));
      else assert.ok(draft.warnings.includes("INVALID_STATE"));
    }
    await s.t.setRole(null);
    await s.t.db.query("UPDATE markets.deployments SET manifest=$1", [
      { ...manifest, chainId: 8453 },
    ]);
    await s.t.setRole("blink_api");
    await assert.rejects(
      resolutionDraftCommand(
        [
          "--deployment",
          "test",
          "--market",
          "1",
          "--action",
          "propose",
          "--outcome",
          "YES",
          "--evidence-hash",
          hash,
        ],
        s.t.pool,
      ),
      /MAINNET_REFUSED/,
    );
    assert.equal(
      (await s.t.db.query("SELECT * FROM operations.outbox")).rows.length,
      0,
    );
  } finally {
    await s.close();
  }
});

const scanContext = (signal = new AbortController().signal) => ({
  job: {
    id: "fixture",
    payload: {},
    type: "resolution.parse" as const,
    attempt: 1,
    maxAttempts: 3,
    leaseToken: "1",
    workerId: "test",
  },
  signal,
});

test("one unreadable evidence object cannot block other records, is audited once and recovers after repair", async () => {
  const { createResolutionParseHandler } =
    await import("../packages/application/src/resolution.js");
  const { postgresResolutionJobsStore, resolutionEvidenceReader } =
    await import("../packages/adapters/src/resolution-store.js");
  const { fileObjectStore } =
    await import("../packages/adapters/src/file-object-store.js");
  const directory = await mkdtemp(join(tmpdir(), "blink-resolution-"));
  const s = await setup();
  try {
    await approveMarket(s);
    await s.t.db.exec(
      "UPDATE chain.markets SET close_at=floor(extract(epoch from blink.now()))-60",
    );
    const objects = fileObjectStore(directory);
    const bytes = (text: string) => new TextEncoder().encode(text);
    const record = async (
      text: string,
      options: { store?: boolean; recordHash?: string } = {},
    ) => {
      const hash = keccak256(bytes(text));
      if (options.store ?? true) await objects.putIfAbsent(bytes(text), hash);
      const id = randomUUID();
      await s.t.db.query(
        "INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,access_policy,observed_at) VALUES($1,$2,$3,decode($4,'hex'),$5,'PRIVATE',blink.now())",
        [
          id,
          s.source,
          s.reporter.operatorId,
          (options.recordHash ?? hash).slice(2),
          "local-object:" + hash,
        ],
      );
      return { id, hash };
    };
    const valid = await record("GAAP gross margin 61.00%");
    const ambiguous = await record("GAAP gross margin 61.255%");
    const missing = await record("GAAP gross margin 60%", { store: false });
    const corrupt = await record("GAAP gross margin 62%");
    await rm(join(directory, corrupt.hash + ".bin"));
    await writeFile(join(directory, corrupt.hash + ".bin"), "tampered");
    // The stored object is intact but is not the bytes this record claims.
    const mismatched = await record("GAAP gross margin 63%", {
      recordHash: keccak256(bytes("something else")),
    });
    const read = resolutionEvidenceReader(objects);
    // The record created by setup() has no stored object; give it readable text.
    const handler = createResolutionParseHandler(
      postgresResolutionJobsStore(s.t.pool),
      async (uri, hash) =>
        uri === "fixture" ? "GAAP gross margin 70%" : read(uri, hash),
    );
    const unreadable = async () =>
      (
        await s.t.db.query<{ resource: string; reason: string }>(
          "SELECT resource,reason FROM operations.audit_log WHERE action='resolution.evidence_unreadable' ORDER BY resource",
        )
      ).rows.map((r) => [JSON.parse(r.resource)[0], r.reason]);
    const expected = [
      [missing.id, "EVIDENCE_OBJECT_MISSING"],
      [corrupt.id, "EVIDENCE_HASH_MISMATCH"],
      [mismatched.id, "EVIDENCE_HASH_MISMATCH"],
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const sortedUnreadable = async () =>
      (await unreadable()).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );

    await s.t.setRole("blink_worker");
    await handler(scanContext());
    await handler(scanContext());
    const suggestions = async () =>
      (
        await s.t.db.query<{ evidence_id: string; outcome: string }>(
          "SELECT evidence_id,outcome FROM resolution.suggestions",
        )
      ).rows;
    assert.deepEqual(
      (await suggestions()).map((r) => r.evidence_id).sort(),
      [valid.id, s.evidence].sort(),
    );
    assert.equal(
      (await suggestions()).find((r) => r.evidence_id === valid.id)!.outcome,
      "YES",
    );
    const manualRequired = async () =>
      (
        await s.t.db.query<{ resource: string }>(
          "SELECT resource FROM operations.audit_log WHERE action='resolution.manual_required'",
        )
      ).rows.map((r) => JSON.parse(r.resource)[2]);
    assert.deepEqual(await manualRequired(), [ambiguous.id]);
    assert.deepEqual(await sortedUnreadable(), expected);

    // Repair the missing and the tampered objects; a later scan picks them up.
    await objects.putIfAbsent(bytes("GAAP gross margin 60%"), missing.hash);
    await rm(join(directory, corrupt.hash + ".bin"));
    await writeFile(
      join(directory, corrupt.hash + ".bin"),
      bytes("GAAP gross margin 62%"),
    );
    await handler(scanContext());
    const after = await suggestions();
    assert.equal(after.length, 4);
    assert.equal(after.find((r) => r.evidence_id === missing.id)!.outcome, "YES");
    assert.equal(after.find((r) => r.evidence_id === corrupt.id)!.outcome, "NO");
    // The still-mismatched record adds no duplicate audit and nothing new for repaired ones.
    assert.deepEqual(await sortedUnreadable(), expected);
    assert.deepEqual(await manualRequired(), [ambiguous.id]);
  } finally {
    await s.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation and unexpected read errors still fail the parse job without partial writes", async () => {
  const { createResolutionParseHandler } =
    await import("../packages/application/src/resolution.js");
  const { postgresResolutionJobsStore, EvidenceUnreadableError } =
    await import("../packages/adapters/src/resolution-store.js");
  const s = await setup();
  try {
    await approveMarket(s);
    await s.t.db.exec(
      "UPDATE chain.markets SET close_at=floor(extract(epoch from blink.now()))-60",
    );
    await s.t.setRole("blink_worker");
    const store = postgresResolutionJobsStore(s.t.pool);
    const controller = new AbortController();
    await assert.rejects(
      createResolutionParseHandler(store, async () => {
        controller.abort();
        throw new EvidenceUnreadableError("EVIDENCE_OBJECT_MISSING");
      })(scanContext(controller.signal)),
      { name: "AbortError" },
    );
    await assert.rejects(
      createResolutionParseHandler(store, async () => {
        throw new Error("EIO");
      })(scanContext()),
      /EIO/,
    );
    assert.equal(
      (await s.t.db.query("SELECT * FROM operations.audit_log WHERE action LIKE 'resolution.%'"))
        .rows.length,
      0,
    );
    assert.equal(
      (await s.t.db.query("SELECT * FROM resolution.suggestions")).rows.length,
      0,
    );
  } finally {
    await s.close();
  }
});

test("resolution evidence reader verifies stored bytes against record hash", async () => {
  const { resolutionEvidenceReader } =
    await import("../packages/adapters/src/resolution-store.js");
  const { keccak256 } = await import("viem");
  const bytes = new TextEncoder().encode("GAAP gross margin 61%");
  const read = resolutionEvidenceReader({
    read: async () => bytes,
    putIfAbsent: async () => {
      throw new Error("read only");
    },
  });
  assert.equal(
    await read("fixture", keccak256(bytes)),
    "GAAP gross margin 61%",
  );
  await assert.rejects(
    read("fixture", "0x" + "00".repeat(32)),
    /EVIDENCE_HASH_MISMATCH/,
  );
});

test("binary evidence has no parseable text and cannot fail the whole parse scan", async () => {
  const { resolutionEvidenceReader } =
    await import("../packages/adapters/src/resolution-store.js");
  const { keccak256 } = await import("viem");
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00]);
  const read = resolutionEvidenceReader({
    read: async () => bytes,
    putIfAbsent: async () => {
      throw new Error("read only");
    },
  });
  assert.equal(await read("fixture", keccak256(bytes)), "");
});
