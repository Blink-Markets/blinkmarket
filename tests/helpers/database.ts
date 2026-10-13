import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { identityAdmin } from "../../packages/adapters/src/identity-admin.js";
import type { ApiScope } from "../../packages/schemas/src/index.js";

const roles = new Set([
  "blink_api",
  "blink_worker",
  "blink_indexer",
  "blink_signer",
  "blink_identity_admin",
  "blink_evidence_admin",
  "blink_deployment_admin",
]);

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

export async function createTestDatabase() {
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
  const connect = async () => {
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
  };
  const pool = {
    connect,
    async query(sql: string, params?: unknown[]) {
      const client = await connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
  } as unknown as Pool;
  return {
    db,
    pool,
    async setRole(role: string | null) {
      if (role === null) return void (await db.exec("RESET ROLE"));
      if (!roles.has(role)) throw new Error("UNKNOWN_TEST_ROLE: " + role);
      await db.exec(`SET ROLE ${role}`);
    },
    close: () => db.close(),
  };
}

// Runs a fixture write as the schema owner, then restores the role the test was using.
async function asOwner<T>(t: TestDatabase, run: () => Promise<T>) {
  const { rows } = await t.db.query<{
    current_user: string;
    session_user: string;
  }>("SELECT current_user, session_user");
  await t.db.exec("RESET ROLE");
  try {
    return await run();
  } finally {
    const { current_user: role, session_user: owner } = rows[0]!;
    if (role !== owner) await t.db.exec(`SET ROLE "${role}"`);
  }
}

export async function inviteAgent(
  t: TestDatabase,
  input: { name: string; scopes: ApiScope[] },
) {
  const invited = await asOwner(t, () =>
    identityAdmin(t.pool).invite({
      operatorName: "operator-" + input.name,
      agentName: input.name,
      scopes: input.scopes,
      reason: "test fixture",
    }),
  );
  return {
    apiKey: invited.apiKey,
    keyId: invited.keyId,
    agentId: invited.agentId,
    operatorId: invited.operatorId,
  };
}

// Direct owner insert for tests that are not about the challenge/verification flow.
export async function bindWallet(
  t: TestDatabase,
  agentId: string,
  address: string,
) {
  await asOwner(t, async () => {
    const key = await t.db.query<{ id: string }>(
      "SELECT id FROM identity.api_keys WHERE agent_id=$1 LIMIT 1",
      [agentId],
    );
    if (!key.rows[0]) throw new Error("TEST_AGENT_HAS_NO_KEY");
    const challengeId = randomUUID();
    await t.db.query(
      `INSERT INTO identity.wallet_challenges
      (id,key_id,agent_id,address,chain_id,origin,nonce_hash,message,issued_at,expires_at,consumed_at)
      VALUES ($1,$2,$3,decode($4,'hex'),84532,'https://blink.example',decode($5,'hex'),'test binding',
        $6::timestamptz,$6::timestamptz + interval '5 minutes',$6::timestamptz)`,
      [
        challengeId,
        key.rows[0].id,
        agentId,
        address.slice(2),
        randomBytes(32).toString("hex"),
        new Date().toISOString(),
      ],
    );
    await t.db.query(
      `INSERT INTO identity.wallet_bindings(agent_id,chain_id,address,challenge_id)
      VALUES ($1,84532,decode($2,'hex'),$3)`,
      [agentId, address.slice(2), challengeId],
    );
  });
}
