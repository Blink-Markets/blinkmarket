import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import {
  migrate,
  migrationDirectory,
} from "../packages/adapters/src/migrations.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import {
  postgresIdentityStore,
  assertIdentityRuntimeRole,
} from "../packages/adapters/src/identity-store.js";
import { createBlinkClient } from "../packages/client/src/index.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import type { ProtocolAccount } from "../packages/schemas/src/index.js";
import { buildApi } from "../apps/api/src/server.js";
import { apiConfig } from "../apps/api/src/config.js";
import { fakeProtocolReader } from "./helpers/protocol-reader.js";
import { fakeSignatureVerifier } from "./helpers/signature-verifier.js";

// Public, unfunded deterministic test keys. No external RPC is used.
const alice = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const bob = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
// A fake ERC-1271 wallet: alice owns it, so her signature is accepted for this address.
const contractWallet = "0x00000000000000000000000000000000000c0de1";
const origin = "https://blink.example";
const challengePath = "/v1/auth/wallet-challenges";
const verifyPath = "/v1/auth/wallet-verifications";
const SELF_SERVE_SCOPES = [
  "forecast:write",
  "rfq:write",
  "content:write",
  "suggestion:claim",
];

const registered = (address: string) =>
  ({ address, registered: true, roles: {}, credit: {} }) as ProtocolAccount;

async function migratedDatabase(directory?: URL) {
  const db = new PGlite();
  const connection = {
    async query(sql: string, params?: unknown[]) {
      if (params) return db.query<Record<string, unknown>>(sql, params);
      const result = await db.exec(sql);
      return { rows: (result.at(-1)?.rows as Record<string, unknown>[]) ?? [] };
    },
  };
  await migrate(connection, directory);
  return { db, connection };
}

async function setup(
  options: {
    limits?: NonNullable<
      NonNullable<Parameters<typeof buildApi>[0]>["walletChallengeLimits"]
    >;
  } = {},
) {
  const { db } = await migratedDatabase();
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
  await db.exec("SET ROLE blink_api");
  const reader = fakeProtocolReader({
    accounts: [
      registered(alice.address),
      registered(bob.address),
      registered(contractWallet),
    ],
  });
  const verifier = fakeSignatureVerifier({
    contractWallets: { [contractWallet]: alice.address },
  });
  const store = postgresIdentityStore(pool);
  const service = createIdentityService(store, identityCrypto, origin, {
    verifier,
    reader,
  });
  const app = buildApi({
    identity: service,
    ...(options.limits ? { walletChallengeLimits: options.limits } : {}),
  });
  app.log.level = "silent";
  const post = (path: string, body: unknown) =>
    app.inject({ method: "POST", url: path, payload: body as object });
  const challenge = (address: string, action = "issue", keyId?: string) =>
    post(challengePath, { address, action, ...(keyId ? { keyId } : {}) });
  type Signer = { signMessage(a: { message: string }): Promise<`0x${string}`> };
  // One full proof: challenge, signature by `signer`, verification. Returns the verification.
  async function prove(
    signer: Signer,
    address: string,
    action = "issue",
    keyId?: string,
  ) {
    const response = await challenge(address, action, keyId);
    assert.equal(response.statusCode, 201, response.body);
    const c = response.json();
    const signature = await signer.signMessage({ message: c.message });
    return post(verifyPath, { challengeId: c.challengeId, signature });
  }
  const owner = async <T>(work: () => Promise<T>) => {
    await db.exec("RESET ROLE");
    try {
      return await work();
    } finally {
      await db.exec("SET ROLE blink_api");
    }
  };
  const count = async (table: string, where = "true") =>
    Number(
      (
        await owner(() =>
          db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
          ),
        )
      ).rows[0]!.n,
    );
  return {
    db,
    reader,
    verifier,
    store,
    service,
    app,
    post,
    challenge,
    prove,
    owner,
    count,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test("challenge needs no key", async () => {
  const s = await setup();
  try {
    const response = await s.challenge(alice.address);
    assert.equal(response.statusCode, 201, response.body);
    const c = response.json();
    assert.match(
      c.message,
      /does not authorize trading, token approvals, or withdrawals/,
    );
    for (const line of [
      `Origin: ${origin}`,
      "Chain ID: 84532",
      `Address: ${alice.address.toLowerCase()}`,
      "Action: issue",
    ])
      assert.ok(c.message.includes(line), line);
    assert.ok(!c.message.includes("Key ID"));
    const ttl =
      new Date(c.expiresAt).getTime() -
      Date.parse(/Issued At: (.+)/.exec(c.message)![1]!);
    assert.equal(ttl, 300_000);
    // A revoke challenge names the key; issue and revoke each refuse the other's shape.
    const keyId = "11111111-1111-4111-8111-111111111111";
    const revoke = await s.challenge(alice.address, "revoke", keyId);
    assert.equal(revoke.statusCode, 201, revoke.body);
    assert.ok(revoke.json().message.includes(`Key ID: ${keyId}`));
    assert.equal((await s.challenge(alice.address, "revoke")).statusCode, 400);
    assert.equal(
      (await s.challenge(alice.address, "issue", keyId)).statusCode,
      400,
    );
    assert.equal(
      (
        await s.post(challengePath, {
          address: alice.address,
          action: "issue",
          chainId: 1,
        })
      ).statusCode,
      400,
    );
    // Nothing exists yet for a wallet that only asked for a challenge.
    assert.equal(await s.count("identity.api_keys"), 0);
    assert.equal(await s.count("identity.agents"), 0);
  } finally {
    await s.close();
  }
});

test("issue requires on-chain registration", async () => {
  const s = await setup();
  try {
    s.reader.set({ accounts: [] });
    const response = await s.prove(alice, alice.address);
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "NOT_REGISTERED");
    assert.equal(await s.count("identity.api_keys"), 0);
    assert.equal(await s.count("identity.agents"), 0);
    // A known but unregistered account is refused the same way.
    s.reader.set({
      accounts: [{ ...registered(alice.address), registered: false }],
    });
    assert.equal(
      (await s.prove(alice, alice.address)).json().code,
      "NOT_REGISTERED",
    );
    assert.equal(await s.count("identity.api_keys"), 0);
  } finally {
    await s.close();
  }
});

test("issue refuses when index is stale", async () => {
  const s = await setup();
  try {
    s.reader.set({
      health: { headBlock: 10, indexedBlock: 1, lagSeconds: 99, stale: true },
    });
    const stale = await s.prove(alice, alice.address);
    assert.equal(stale.statusCode, 503);
    assert.equal(stale.json().code, "INDEX_STALE");
    // A reader that cannot answer is treated as a stale index, never as "registered".
    s.reader.set({ health: undefined as never });
    const broken = await s.prove(alice, alice.address);
    assert.equal(broken.statusCode, 503);
    assert.equal(broken.json().code, "INDEX_STALE");
    assert.equal(await s.count("identity.api_keys"), 0);
    // The challenge was not consumed by the refusals, so a healthy index still serves it.
    s.reader.set({
      health: { headBlock: 10, indexedBlock: 10, lagSeconds: 0, stale: false },
    });
    assert.equal((await s.prove(alice, alice.address)).statusCode, 200);
  } finally {
    await s.close();
  }
});

test("challenge is single use", async () => {
  const s = await setup();
  try {
    const c = (await s.challenge(alice.address)).json();
    const signature = await alice.signMessage({ message: c.message });
    const payload = { challengeId: c.challengeId, signature };
    assert.equal((await s.post(verifyPath, payload)).statusCode, 200);
    const again = await s.post(verifyPath, payload);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().code, "WALLET_CHALLENGE_USED");
    assert.equal(await s.count("identity.api_keys"), 1);
    assert.equal(
      (
        await s.post(verifyPath, {
          challengeId: "22222222-2222-4222-8222-222222222222",
          signature,
        })
      ).statusCode,
      404,
    );
  } finally {
    await s.close();
  }
});

test("expired challenge rejected", async () => {
  const s = await setup();
  try {
    const c = (await s.challenge(alice.address)).json();
    const signature = await alice.signMessage({ message: c.message });
    await s.owner(() =>
      s.db.query(
        "UPDATE identity.wallet_challenges SET issued_at=issued_at-interval '6 minutes',expires_at=expires_at-interval '6 minutes' WHERE id=$1",
        [c.challengeId],
      ),
    );
    const response = await s.post(verifyPath, {
      challengeId: c.challengeId,
      signature,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "WALLET_CHALLENGE_EXPIRED");
    assert.equal(await s.count("identity.api_keys"), 0);
  } finally {
    await s.close();
  }
});

test("signature from another address rejected", async () => {
  const s = await setup();
  try {
    const c = (await s.challenge(alice.address)).json();
    const bad = await bob.signMessage({ message: c.message });
    const invalid = await s.post(verifyPath, {
      challengeId: c.challengeId,
      signature: bad,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, "INVALID_WALLET_SIGNATURE");
    // A signature over a different origin does not satisfy the stored message.
    const wrongDomain = await alice.signMessage({
      message: c.message.replace(origin, "https://evil.example"),
    });
    assert.equal(
      (
        await s.post(verifyPath, {
          challengeId: c.challengeId,
          signature: wrongDomain,
        })
      ).json().code,
      "INVALID_WALLET_SIGNATURE",
    );
    // A challenge issued under another origin is refused outright.
    const otherOrigin = createIdentityService(
      s.store,
      identityCrypto,
      "https://other.example",
      { verifier: s.verifier, reader: s.reader },
    );
    await assert.rejects(
      otherOrigin.mutate("/v1/auth/wallet-verifications", {
        body: {
          challengeId: c.challengeId,
          signature: await alice.signMessage({ message: c.message }),
        },
        requestId: "test",
      }),
      { status: 400, code: "INVALID_WALLET_SIGNATURE" },
    );
    assert.equal(await s.count("identity.api_keys"), 0);
    assert.equal(await s.count("identity.wallet_bindings"), 0);
  } finally {
    await s.close();
  }
});

test("contract wallet proof accepted", async () => {
  const s = await setup();
  try {
    const response = await s.prove(alice, contractWallet);
    assert.equal(response.statusCode, 200, response.body);
    const { apiKey } = response.json();
    const principal = await s.service.authenticate("Bearer " + apiKey);
    assert.equal(principal.address, contractWallet);
    // The owner's signature is not accepted for a wallet owned by someone else.
    assert.equal(
      (await s.prove(bob, contractWallet)).json().code,
      "INVALID_WALLET_SIGNATURE",
    );
  } finally {
    await s.close();
  }
});

test("signature check outage fails closed", async () => {
  const s = await setup();
  try {
    s.verifier.setUnavailable(true);
    const response = await s.prove(alice, alice.address);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "SIGNATURE_CHECK_UNAVAILABLE");
    assert.equal(response.json().retryable, true);
    assert.equal(await s.count("identity.api_keys"), 0);
    assert.equal(await s.count("identity.agents"), 0);
    s.verifier.setUnavailable(false);
    assert.equal((await s.prove(alice, alice.address)).statusCode, 200);
  } finally {
    await s.close();
  }
});

test("issued key carries the four scopes, hides its secret and expires or revokes", async () => {
  const s = await setup();
  try {
    const response = await s.prove(alice, alice.address);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    const { apiKey, keyId, expiresAt } = response.json();
    const secret = apiKey.split(".")[1]!;
    assert.equal(apiKey, `blink_${keyId}.${secret}`);
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, String(days));
    const principal = await s.service.authenticate("Bearer " + apiKey);
    assert.deepEqual(
      { ...principal, operatorId: undefined, agentId: undefined },
      {
        keyId,
        operatorId: undefined,
        agentId: undefined,
        address: alice.address.toLowerCase(),
        scopes: SELF_SERVE_SCOPES,
      },
    );
    await assert.rejects(s.service.authenticate("Bearer " + apiKey, "admin"), {
      status: 403,
    });
    await assert.rejects(
      s.service.authenticate(
        "Bearer " + apiKey.slice(0, -1) + (apiKey.endsWith("0") ? "1" : "0"),
      ),
      { status: 401 },
    );
    // The secret exists only in the response: the database holds its hash.
    const dump = JSON.stringify(
      await s.owner(async () => [
        (await s.db.query("SELECT row_to_json(t) FROM identity.api_keys t"))
          .rows,
        (await s.db.query("SELECT row_to_json(t) FROM operations.audit_log t"))
          .rows,
        (
          await s.db.query(
            "SELECT row_to_json(t) FROM identity.wallet_challenges t",
          )
        ).rows,
      ]),
    );
    assert.ok(!dump.includes(secret));
    const { rows } = await s.owner(() =>
      s.db.query<{ h: string }>(
        "SELECT encode(secret_hash,'hex') AS h FROM identity.api_keys WHERE id=$1",
        [keyId],
      ),
    );
    assert.equal(rows[0]!.h, identityCrypto.hash(secret));
    assert.equal(
      await s.count("operations.audit_log", "action='identity.key_issued'"),
      1,
    );
    // Expiry is enforced on every request.
    await s.owner(() =>
      s.db.query(
        "UPDATE identity.api_keys SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [keyId],
      ),
    );
    await assert.rejects(s.service.authenticate("Bearer " + apiKey), {
      status: 401,
    });
  } finally {
    await s.close();
  }
});

test("sixth active key refused", async () => {
  const s = await setup();
  try {
    const keys: { apiKey: string; keyId: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await s.prove(alice, alice.address);
      assert.equal(response.statusCode, 200, response.body);
      keys.push(response.json());
    }
    const sixth = await s.prove(alice, alice.address);
    assert.equal(sixth.statusCode, 409);
    assert.equal(sixth.json().code, "KEY_LIMIT_REACHED");
    assert.equal(await s.count("identity.api_keys"), 5);
    // Revoking one frees a slot; the refused challenge stayed unconsumed but a fresh one works too.
    const revoked = await s.prove(
      alice,
      alice.address,
      "revoke",
      keys[0]!.keyId,
    );
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal((await s.prove(alice, alice.address)).statusCode, 200);
    // Expired keys do not count as active.
    assert.equal(
      (await s.prove(alice, alice.address)).json().code,
      "KEY_LIMIT_REACHED",
    );
  } finally {
    await s.close();
  }
});

test("revoke only own key", async () => {
  const s = await setup();
  try {
    const a = (await s.prove(alice, alice.address)).json();
    const b = (await s.prove(bob, bob.address)).json();
    // Alice cannot revoke Bob's key, even with a valid signature of her own.
    const theft = await s.prove(alice, alice.address, "revoke", b.keyId);
    assert.equal(theft.statusCode, 404);
    assert.equal(theft.json().code, "NOT_FOUND");
    assert.equal(
      (await s.service.authenticate("Bearer " + b.apiKey)).keyId,
      b.keyId,
    );
    // Bob's signature does not revoke Alice's key by naming Bob's address either.
    const crossed = await s.challenge(alice.address, "revoke", a.keyId);
    const c = crossed.json();
    const wrongSigner = await s.post(verifyPath, {
      challengeId: c.challengeId,
      signature: await bob.signMessage({ message: c.message }),
    });
    assert.equal(wrongSigner.json().code, "INVALID_WALLET_SIGNATURE");
    await s.service.authenticate("Bearer " + a.apiKey);
    // The owner revokes her own key; it stops working at once.
    const own = await s.prove(alice, alice.address, "revoke", a.keyId);
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.json().keyId, a.keyId);
    await assert.rejects(s.service.authenticate("Bearer " + a.apiKey), {
      status: 401,
    });
    // An address that was never registered with us has nothing to revoke.
    const stranger = privateKeyToAccount(`0x${"3".padStart(64, "0")}`);
    assert.equal(
      (await s.prove(stranger, stranger.address, "revoke", b.keyId)).statusCode,
      404,
    );
    assert.equal(
      (await s.service.authenticate("Bearer " + b.apiKey)).keyId,
      b.keyId,
    );
  } finally {
    await s.close();
  }
});

test("revoke works without registration or a fresh index", async () => {
  const s = await setup();
  try {
    const a = (await s.prove(alice, alice.address)).json();
    s.reader.set({
      accounts: [],
      health: { headBlock: 10, indexedBlock: 1, lagSeconds: 99, stale: true },
    });
    assert.equal(
      (await s.prove(alice, alice.address, "revoke", a.keyId)).statusCode,
      200,
    );
  } finally {
    await s.close();
  }
});

test("same address keeps one agent across keys", async () => {
  const s = await setup();
  try {
    const first = (await s.prove(alice, alice.address)).json();
    const second = (await s.prove(alice, alice.address.toLowerCase())).json();
    assert.notEqual(first.keyId, second.keyId);
    const a = await s.service.authenticate("Bearer " + first.apiKey);
    const b = await s.service.authenticate("Bearer " + second.apiKey);
    assert.equal(a.agentId, b.agentId);
    assert.equal(a.operatorId, b.operatorId);
    assert.equal(await s.count("identity.agents"), 1);
    assert.equal(await s.count("identity.operators"), 1);
    assert.equal(await s.count("identity.wallet_bindings"), 1);
    // A different address is a different agent.
    const other = await s.service.authenticate(
      "Bearer " + (await s.prove(bob, bob.address)).json().apiKey,
    );
    assert.notEqual(other.agentId, a.agentId);
    assert.equal(await s.count("identity.agents"), 2);
  } finally {
    await s.close();
  }
});

test("rate limit per address", async () => {
  const bucket = (capacity: number) => ({
    capacity,
    refillPerSecond: capacity / 3600,
    now: () => 0,
  });
  const s = await setup({
    limits: { perIp: bucket(100), perAddress: bucket(2) },
  });
  try {
    assert.equal((await s.challenge(alice.address)).statusCode, 201);
    assert.equal((await s.challenge(alice.address)).statusCode, 201);
    const limited = await s.challenge(alice.address.toLowerCase());
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "RATE_LIMITED");
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    // The allowance is per address.
    assert.equal((await s.challenge(bob.address)).statusCode, 201);
  } finally {
    await s.close();
  }
  const byIp = await setup({
    limits: { perIp: bucket(2), perAddress: bucket(100) },
  });
  try {
    assert.equal((await byIp.challenge(alice.address)).statusCode, 201);
    assert.equal((await byIp.challenge(bob.address)).statusCode, 201);
    assert.equal((await byIp.challenge(contractWallet)).statusCode, 429);
  } finally {
    await byIp.close();
  }
});

test("pending challenges per address are capped at five", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal((await s.challenge(alice.address)).statusCode, 201);
    assert.equal((await s.challenge(alice.address)).statusCode, 429);
  } finally {
    await s.close();
  }
});

test("runtime role cannot write credentials; the invite role and invite keys are gone", async () => {
  const s = await setup();
  try {
    const keyId = (await s.prove(alice, alice.address)).json().keyId as string;
    for (const sql of [
      "INSERT INTO identity.api_keys(id,operator_id,agent_id,secret_hash,scopes,expires_at) SELECT gen_random_uuid(),operator_id,agent_id,secret_hash,scopes,expires_at FROM identity.api_keys",
      "UPDATE identity.api_keys SET scopes=ARRAY['admin']",
      "UPDATE identity.api_keys SET revoked_at=NULL",
      "INSERT INTO identity.operators(id,name) VALUES (gen_random_uuid(),'x')",
      "INSERT INTO identity.wallet_bindings(agent_id,chain_id,address,challenge_id) SELECT agent_id,84532,address,challenge_id FROM identity.wallet_bindings",
      "UPDATE identity.wallet_challenges SET consumed_at=NULL",
      "DELETE FROM identity.wallet_bindings",
    ])
      await assert.rejects(s.db.query(sql), /permission denied/, sql);
    for (const role of ["blink_worker", "blink_indexer"]) {
      await s.db.exec(`RESET ROLE; SET ROLE ${role}`);
      await assert.rejects(
        s.db.query(
          "SELECT * FROM identity.revoke_self_serve_key(gen_random_uuid(),'x')",
        ),
        /permission denied/,
      );
      await s.db.exec("RESET ROLE");
      await s.db.exec("SET ROLE blink_api");
    }
    const roles = await s.owner(() =>
      s.db.query("SELECT 1 FROM pg_roles WHERE rolname='blink_identity_admin'"),
    );
    assert.equal(roles.rows.length, 0);
    const publicGrants = await s.owner(() =>
      s.db.query(`SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname='identity' AND a.grantee=0 AND a.privilege_type='EXECUTE'`),
    );
    assert.deepEqual(publicGrants.rows, []);
    const audits = JSON.stringify(
      (await s.db.query("SELECT * FROM operations.audit_log")).rows,
    );
    assert.ok(audits.includes(keyId));
    const connection = {
      query: (sql: string, params?: unknown[]) => s.db.query(sql, params),
    } as unknown as Parameters<typeof assertIdentityRuntimeRole>[0];
    // The owner with SET ROLE is refused; real login acceptance is tested in PostgreSQL.
    await assert.rejects(
      assertIdentityRuntimeRole(connection),
      /UNSAFE_API_DATABASE_ROLE/,
    );
  } finally {
    await s.close();
  }
});

test("migration 0028 revokes every active invite key", async () => {
  const before = await mkdtemp(join(tmpdir(), "blink-migrations-"));
  try {
    for (const name of await readdir(migrationDirectory))
      if (!name.startsWith("0028_"))
        await cp(new URL(name, migrationDirectory), join(before, name));
    const { db, connection } = await migratedDatabase(
      pathToFileURL(before + "/"),
    );
    await db.exec(`
      INSERT INTO identity.operators(id,name) VALUES ('00000000-0000-4000-8000-000000000001','op');
      INSERT INTO identity.agents(id,operator_id,name) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','agent');
      INSERT INTO identity.api_keys(id,operator_id,agent_id,secret_hash,scopes,expires_at)
      VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',
        decode(repeat('ab',32),'hex'),ARRAY['admin'],clock_timestamp()+interval '1 day');
    `);
    await migrate(connection);
    const { rows } = await db.query<{ revoked: boolean }>(
      "SELECT revoked_at IS NOT NULL AS revoked FROM identity.api_keys",
    );
    assert.deepEqual(rows, [{ revoked: true }]);
    await db.close();
  } finally {
    await rm(before, { recursive: true, force: true });
  }
});

test("configuration fails closed and origin cannot be caller-controlled", () => {
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

test("a service built without wallet proof refuses to serve it", async () => {
  const s = await setup();
  try {
    const bare = createIdentityService(s.store, identityCrypto, origin);
    await assert.rejects(
      bare.mutate("/v1/auth/wallet-challenges", {
        body: { address: alice.address, action: "issue" },
        requestId: "test",
      }),
      /WALLET_PROOF_NOT_CONFIGURED/,
    );
  } finally {
    await s.close();
  }
});

test("public client proves a wallet and receives a key without a private signing endpoint", async (t) => {
  const s = await setup();
  try {
    t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
      assert.equal(url.origin, origin);
      assert.equal(init.redirect, "error");
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        undefined,
      );
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
    const client = createBlinkClient(origin);
    const challenge = await client.createWalletChallenge(
      { address: alice.address, action: "issue" },
      "client-challenge",
    );
    // The client does not auto-sign: the caller inspects the fixed message and signs locally.
    const signature = await alice.signMessage({ message: challenge.message });
    const result = await client.verifyWallet(
      { challengeId: challenge.challengeId, signature },
      "client-verify",
    );
    assert.ok("apiKey" in result && result.apiKey.startsWith("blink_"));
  } finally {
    await s.close();
  }
});
