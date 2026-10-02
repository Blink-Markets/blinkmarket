import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { migrate } from "../packages/adapters/src/migrations.js";
import { identityAdmin } from "../packages/adapters/src/identity-admin.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import {
  postgresIdentityStore,
  assertIdentityRuntimeRole,
} from "../packages/adapters/src/identity-store.js";
import { createBlinkClient } from "../packages/client/src/index.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import { buildApi } from "../apps/api/src/server.js";
import { apiConfig } from "../apps/api/src/config.js";

// Public, unfunded deterministic test keys. No external RPC is used.
const alice = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const bob = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const origin = "https://blink.example";
const challengePath = "/v1/auth/wallet-challenges";
const verifyPath = "/v1/auth/wallet-verifications";

async function setup() {
  const db = new PGlite();
  await migrate({
    async query(sql, params) {
      if (params) return db.query<Record<string, unknown>>(sql, params);
      const result = await db.exec(sql);
      return { rows: (result.at(-1)?.rows as Record<string, unknown>[]) ?? [] };
    },
  });
  // PGlite is one session, so emulate pool checkout serialization, not DB lock concurrency.
  let previous = Promise.resolve();
  const pool = {
    async connect() {
      const ready = previous;
      let release!: () => void;
      previous = new Promise<void>((resolve) => {
        release = resolve;
      });
      await ready;
      return {
        query: (sql: string, params?: unknown[]) => db.query(sql, params),
        release,
      };
    },
  } as unknown as Pool;
  const admin = identityAdmin(pool);
  await db.exec("SET ROLE blink_identity_admin");
  const invited = await admin.invite({
    operatorName: "Researcher",
    agentName: "Agent A",
    scopes: ["trade:quote", "candidate:write"],
    reason: "Local identity test",
  });
  const rotated = await admin.issue(invited.agentId, {
    scopes: ["report:write"],
    reason: "Independent key",
  });
  const other = await admin.invite({
    operatorName: "Other researcher",
    agentName: "Agent B",
    scopes: ["trade:quote"],
    reason: "Ownership test",
  });
  await db.exec("SET ROLE blink_api");
  const store = postgresIdentityStore(pool);
  const service = createIdentityService(store, identityCrypto, origin);
  const app = buildApi({ identity: service });
  const post = (
    path: string,
    body: unknown,
    key = "request-1",
    apiKey: string | null = invited.apiKey,
  ) =>
    app.inject({
      method: "POST",
      url: path,
      headers: {
        ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
        "idempotency-key": key,
      },
      payload: body as object,
    });
  return {
    db,
    admin,
    invited,
    rotated,
    other,
    store,
    service,
    app,
    post,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test("M2 identity: invite hashes secrets; role grants prevent API credential changes", async () => {
  const s = await setup();
  try {
    const { rows } = await s.db.query<{ secret_hash: string }>(
      "SELECT encode(secret_hash,'hex') AS secret_hash FROM identity.api_keys WHERE id=$1",
      [s.invited.keyId],
    );
    assert.equal(
      rows[0]!.secret_hash,
      identityCrypto.hash(s.invited.apiKey.split(".")[1]!),
    );
    const dump = JSON.stringify(
      (
        await s.db.query(
          "SELECT row_to_json(k) AS row FROM identity.api_keys k",
        )
      ).rows,
    );
    assert.ok(!dump.includes(s.invited.apiKey.split(".")[1]!));
    await assert.rejects(
      s.admin.invite({
        operatorName: "x",
        agentName: "x",
        scopes: ["admin"],
        reason: "forbidden",
      }),
      /permission denied/,
    );
    await assert.rejects(
      s.db.query(
        "UPDATE identity.api_keys SET scopes=ARRAY['admin'] WHERE id=$1",
        [s.invited.keyId],
      ),
      /permission denied/,
    );
    await assert.rejects(
      s.admin.revoke(s.invited.keyId, "forbidden"),
      /permission denied/,
    );
    for (const role of ["blink_worker", "blink_indexer", "blink_signer"]) {
      await s.db.exec(`SET ROLE ${role}`);
      await assert.rejects(
        s.db.query("SELECT * FROM identity.api_keys"),
        /permission denied/,
      );
    }
    await s.db.exec("SET ROLE blink_api");
    const audits = JSON.stringify(
      (await s.db.query("SELECT * FROM operations.audit_log")).rows,
    );
    assert.ok(!audits.includes(s.invited.apiKey));
    const connection = {
      query: (sql: string) => s.db.query(sql),
    } as unknown as Parameters<typeof assertIdentityRuntimeRole>[0];
    await assertIdentityRuntimeRole(connection);
    await s.db.exec("RESET ROLE");
    await assert.rejects(
      assertIdentityRuntimeRole(connection),
      /UNSAFE_API_DATABASE_ROLE/,
    );
    await s.db.exec("SET ROLE blink_identity_admin");
    await assert.rejects(
      assertIdentityRuntimeRole(connection),
      /UNSAFE_API_DATABASE_ROLE/,
    );
  } finally {
    await s.close();
  }
});

test("M2 identity: challenge, EOA binding and idempotent replay are atomic and never enable trading", async () => {
  const s = await setup();
  try {
    const response = await s.post(challengePath, { address: alice.address });
    assert.equal(response.statusCode, 201, response.body);
    const c = response.json();
    assert.match(
      c.message,
      /does not authorize trading, token approvals, or withdrawals/,
    );
    assert.ok(
      c.message.includes(origin) &&
        c.message.includes(s.invited.keyId) &&
        c.message.includes(s.invited.agentId),
    );
    assert.match(c.message, /Chain ID: 84532/);
    assert.deepEqual(
      (
        await s.post(challengePath, { address: alice.address.toLowerCase() })
      ).json(),
      c,
    );
    assert.equal(
      (await s.post(challengePath, { address: bob.address })).statusCode,
      409,
    );
    const signature = await alice.signMessage({ message: c.message });
    const payload = { challengeId: c.challengeId, signature };
    const verified = await s.post(verifyPath, payload, "verify");
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal(verified.json().wallet, alice.address.toLowerCase());
    assert.deepEqual(
      (await s.post(verifyPath, payload, "verify")).json(),
      verified.json(),
    );
    assert.equal(
      (await s.post(verifyPath, payload, "verify-new-key")).json().code,
      "WALLET_CHALLENGE_USED",
    );
    assert.equal(
      (
        await s.post(challengePath, { address: bob.address }, "new-wallet")
      ).json().code,
      "WALLET_ALREADY_BOUND",
    );
    assert.equal(
      (await s.db.query("SELECT * FROM identity.wallet_bindings")).rows.length,
      1,
    );
    assert.equal(
      (
        await s.db.query(
          "SELECT * FROM operations.audit_log WHERE action='identity.wallet_bound'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (await s.app.inject("/v1/config")).json().tradingEnabled,
      false,
    );
    assert.equal((await s.app.inject("/health/ready")).statusCode, 503);
    const openapi = (await s.app.inject("/openapi.json")).json();
    assert.equal(openapi.paths[challengePath].post["x-status"], "enabled");
    assert.equal(openapi.paths["/v1/rfqs"].post["x-status"], "not-implemented");
    await assert.rejects(
      s.db.query("DELETE FROM identity.wallet_bindings"),
      /permission denied/,
    );
  } finally {
    await s.close();
  }
});

test("M2 identity: wrong signatures, domain, challenge owner and key cannot bind", async () => {
  const s = await setup();
  try {
    const c = (await s.post(challengePath, { address: alice.address })).json();
    const bad = await bob.signMessage({ message: c.message });
    const invalid = await s.post(
      verifyPath,
      { challengeId: c.challengeId, signature: bad },
      "bad-signature",
    );
    assert.equal(invalid.json().code, "INVALID_WALLET_SIGNATURE");
    const wrongDomain = await alice.signMessage({
      message: c.message.replace(origin, "https://evil.example"),
    });
    assert.equal(
      (
        await s.post(
          verifyPath,
          { challengeId: c.challengeId, signature: wrongDomain },
          "bad-domain",
        )
      ).statusCode,
      400,
    );
    const signature = await alice.signMessage({ message: c.message });
    const payload = { challengeId: c.challengeId, signature };
    assert.equal(
      (await s.post(verifyPath, payload, "cross-key", s.rotated.apiKey))
        .statusCode,
      404,
    );
    assert.equal(
      (await s.post(verifyPath, payload, "cross-agent", s.other.apiKey))
        .statusCode,
      404,
    );
    assert.equal(
      (await s.post(verifyPath, payload, "bad-signature")).json().code,
      "IDEMPOTENCY_CONFLICT",
    );
    const otherService = createIdentityService(
      s.store,
      identityCrypto,
      "https://other.example",
    );
    const wrongOrigin = await otherService.mutate(verifyPath, {
      body: payload,
      authorization: "Bearer " + s.invited.apiKey,
      idempotencyKey: "server-origin",
      requestId: "test",
    });
    assert.equal(wrongOrigin.status, 400);
    assert.equal(
      (await s.db.query("SELECT * FROM identity.wallet_bindings")).rows.length,
      0,
    );
    assert.equal(
      (await s.post(verifyPath, payload, "valid-after-errors")).statusCode,
      200,
    );
    // Same wallet cannot be claimed by a different agent, even with a valid signature.
    const otherChallenge = (
      await s.post(
        challengePath,
        { address: alice.address },
        "other",
        s.other.apiKey,
      )
    ).json();
    const otherSignature = await alice.signMessage({
      message: otherChallenge.message,
    });
    assert.equal(
      (
        await s.post(
          verifyPath,
          {
            challengeId: otherChallenge.challengeId,
            signature: otherSignature,
          },
          "other-verify",
          s.other.apiKey,
        )
      ).json().code,
      "WALLET_ALREADY_BOUND",
    );
  } finally {
    await s.close();
  }
});

test("M2 identity: auth/scope/expiry/revocation are checked again on cached requests", async () => {
  const s = await setup();
  try {
    assert.equal(
      (await s.post(challengePath, { address: alice.address }, "missing", null))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await s.post(
          challengePath,
          { address: alice.address },
          "forged",
          s.invited.apiKey.slice(0, -1) +
            (s.invited.apiKey.endsWith("0") ? "1" : "0"),
        )
      ).statusCode,
      401,
    );
    const rfq = {
      deploymentId: "test",
      marketId: "1",
      side: "YES",
      quantity: "1",
      maxCostMicros: "1000000",
    };
    assert.equal(
      (await s.post("/v1/rfqs", rfq, "scope", s.rotated.apiKey)).statusCode,
      403,
    );
    assert.equal((await s.post("/v1/rfqs", rfq, "authorized")).statusCode, 501);
    const c = (await s.post(challengePath, { address: alice.address })).json();
    const signature = await alice.signMessage({ message: c.message });
    await s.db.exec("RESET ROLE");
    await s.db.query(
      "UPDATE identity.wallet_challenges SET issued_at=issued_at-interval '6 minutes',expires_at=expires_at-interval '6 minutes' WHERE id=$1",
      [c.challengeId],
    );
    await s.db.exec("SET ROLE blink_api");
    assert.equal(
      (
        await s.post(
          verifyPath,
          { challengeId: c.challengeId, signature },
          "expired",
        )
      ).json().code,
      "WALLET_CHALLENGE_EXPIRED",
    );
    await s.db.exec("SET ROLE blink_identity_admin");
    assert.deepEqual(await s.admin.revoke(s.invited.keyId, "Revoke test key"), {
      revoked: true,
    });
    await s.db.exec("SET ROLE blink_api");
    assert.equal(
      (await s.post(challengePath, { address: alice.address })).statusCode,
      401,
    );
    await s.db.exec("RESET ROLE");
    await s.db.query(
      "UPDATE identity.api_keys SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [s.rotated.keyId],
    );
    await s.db.exec("SET ROLE blink_api");
    assert.equal(
      (
        await s.post(
          challengePath,
          { address: alice.address },
          "expired-key",
          s.rotated.apiKey,
        )
      ).statusCode,
      401,
    );
  } finally {
    await s.close();
  }
});

test("M2 identity: limits, malformed input, repeated writes and rollback", async () => {
  const s = await setup();
  try {
    assert.equal(
      (await s.post(challengePath, { address: alice.address, chainId: 1 }))
        .statusCode,
      400,
    );
    const writes = await Promise.all(
      Array.from({ length: 8 }, () =>
        s.post(challengePath, { address: alice.address }, "concurrent"),
      ),
    );
    assert.ok(writes.every((r) => r.statusCode === 201));
    assert.ok(
      writes.every(
        (r) => r.json().challengeId === writes[0]!.json().challengeId,
      ),
    );
    assert.equal(
      (await s.db.query("SELECT * FROM identity.wallet_challenges")).rows
        .length,
      1,
    );
    for (let i = 0; i < 4; i++)
      assert.equal(
        (await s.post(challengePath, { address: alice.address }, `limit-${i}`))
          .statusCode,
        201,
      );
    assert.equal(
      (
        await s.post(
          challengePath,
          { address: alice.address },
          "limit-exceeded",
        )
      ).statusCode,
      429,
    );
    // Force an audit failure: challenge and idempotency writes must both roll back.
    await s.db.exec(
      "RESET ROLE; REVOKE INSERT ON operations.audit_log FROM blink_api; SET ROLE blink_api",
    );
    assert.equal(
      (
        await s.post(
          challengePath,
          { address: bob.address },
          "rollback",
          s.other.apiKey,
        )
      ).statusCode,
      500,
    );
    assert.equal(
      (
        await s.db.query(
          "SELECT * FROM identity.wallet_challenges WHERE key_id=$1",
          [s.other.keyId],
        )
      ).rows.length,
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
      (
        await s.post(
          challengePath,
          { address: bob.address },
          "rollback",
          s.other.apiKey,
        )
      ).statusCode,
      201,
    );
  } finally {
    await s.close();
  }
});

test("M2 identity: configuration fails closed and origin cannot be caller-controlled", () => {
  assert.equal(apiConfig({}).mode, "scaffold");
  assert.throws(
    () => apiConfig({ BLINK_API_MODE: "identity" }),
    /CONFIGURATION/,
  );
  assert.throws(() => apiConfig({ BLINK_API_MODE: "typo" }), /MODE/);
  assert.throws(() => apiConfig({ API_PORT: "0" }), /PORT/);
  for (const value of [
    "http://example.com",
    "https://example.com/path",
    "https://user:secret@example.com",
    "https://example.com/",
  ]) {
    assert.throws(
      () =>
        createIdentityService(
          {
            run: async () => {
              throw new Error("unused");
            },
          },
          identityCrypto,
          value,
        ),
      /ORIGIN/,
    );
  }
});

test("M2 identity: public client can bind an invited wallet without a private signing endpoint", async (t) => {
  const s = await setup();
  try {
    t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
      assert.equal(url.origin, origin);
      assert.equal(init.redirect, "error");
      const response = await s.app.inject({
        method: "POST",
        url: url.pathname,
        headers: init.headers as Record<string, string>,
        payload: String(init.body),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createBlinkClient(origin, s.invited.apiKey);
    const challenge = await client.createWalletChallenge(
      { address: alice.address },
      "client-challenge",
    );
    // The client does not auto-sign: the caller inspects the fixed message and signs locally.
    const signature = await alice.signMessage({ message: challenge.message });
    const result = await client.verifyWallet(
      { challengeId: challenge.challengeId, signature },
      "client-verify",
    );
    assert.equal(result.wallet, alice.address.toLowerCase());
  } finally {
    await s.close();
  }
});
