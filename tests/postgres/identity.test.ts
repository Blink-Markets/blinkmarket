import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
import {
  createIdentityService,
  IdentityError,
} from "../../packages/application/src/identity.js";
import type { ProtocolAccount } from "../../packages/schemas/src/index.js";
import { fakeProtocolReader } from "../helpers/protocol-reader.js";
import { fakeSignatureVerifier } from "../helpers/signature-verifier.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "TEST_POSTGRES_ADMIN_URL_REQUIRED: dedicated local/CI PostgreSQL with CREATEDB and CREATEROLE privileges",
  );

const challengePath = "/v1/auth/wallet-challenges";
const verifyPath = "/v1/auth/wallet-verifications";

test(
  "real PostgreSQL: concurrent verifications of one challenge issue exactly one key",
  { timeout: 60000 },
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
    const apiPool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      options: "-c role=blink_api",
      max: 10,
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
      // Public deterministic test keys, never funded and never sent to any RPC.
      const wallet = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
      const bob = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
      const accounts = [wallet, bob].map(
        (a) =>
          ({
            address: a.address,
            registered: true,
            roles: {},
            credit: {},
          }) as ProtocolAccount,
      );
      const service = createIdentityService(
        postgresIdentityStore(apiPool),
        identityCrypto,
        "https://blink.example",
        {
          verifier: fakeSignatureVerifier(),
          reader: fakeProtocolReader({ accounts }),
        },
      );
      const count = async (table: string, where = "true") =>
        Number(
          (
            await owner.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
            )
          ).rows[0]!.n,
        );
      // A refusal arrives as an IdentityError; anything else is a failure of the test.
      const attempt = async (work: Promise<{ status: number }>) =>
        work.then(
          (r) => ({ status: r.status, code: "OK" }),
          (error: unknown) => {
            assert.ok(error instanceof IdentityError, String(error));
            return { status: error.status, code: error.code };
          },
        );
      const challenge = async (signer: typeof wallet) => {
        const c = (
          await service.mutate(challengePath, {
            body: { address: signer.address, action: "issue" },
            requestId: "pg-test",
          })
        ).body;
        return {
          challengeId: c.challengeId as string,
          signature: await signer.signMessage({ message: c.message as string }),
        };
      };
      const verify = (body: { challengeId: string; signature: string }) =>
        service.mutate(verifyPath, { body, requestId: "pg-test" });

      // One challenge, eight simultaneous verifications: one key, seven "used".
      const single = await challenge(wallet);
      const raced = await Promise.all(
        Array.from({ length: 8 }, () => attempt(verify(single))),
      );
      assert.equal(raced.filter((r) => r.code === "OK").length, 1);
      assert.equal(
        raced.filter((r) => r.code === "WALLET_CHALLENGE_USED").length,
        7,
      );
      assert.equal(await count("identity.api_keys"), 1);
      assert.equal(await count("identity.agents"), 1);
      assert.equal(await count("identity.wallet_bindings"), 1);
      assert.equal(
        await count("operations.audit_log", "action='identity.key_issued'"),
        1,
      );

      // Four more keys for the same address, issued at once, share the agent.
      const four = await Promise.all(
        Array.from({ length: 4 }, () => challenge(wallet)),
      );
      const fourResults = await Promise.all(
        four.map((c) => attempt(verify(c))),
      );
      assert.deepEqual(
        fourResults.map((r) => r.code),
        ["OK", "OK", "OK", "OK"],
      );
      assert.equal(await count("identity.api_keys"), 5);
      assert.equal(await count("identity.agents"), 1);
      const sixth = await attempt(verify(await challenge(wallet)));
      assert.deepEqual(sixth, { status: 409, code: "KEY_LIMIT_REACHED" });

      // A new address racing three keys at once still gets exactly one agent.
      const trio = await Promise.all(
        Array.from({ length: 3 }, () => challenge(bob)),
      );
      const trioResults = await Promise.all(
        trio.map((c) => attempt(verify(c))),
      );
      assert.equal(trioResults.filter((r) => r.code === "OK").length, 3);
      assert.equal(
        await count(
          "identity.wallet_bindings",
          "address=decode('" + bob.address.slice(2).toLowerCase() + "','hex')",
        ),
        1,
      );
      assert.equal(await count("identity.agents"), 2);
      assert.equal(await count("identity.operators"), 2);

      // Two keys left for bob, then five at once: exactly two more fit.
      const limit = await Promise.all(
        Array.from({ length: 5 }, () => challenge(bob)),
      );
      const limitResults = await Promise.all(
        limit.map((c) => attempt(verify(c))),
      );
      assert.equal(limitResults.filter((r) => r.code === "OK").length, 2);
      assert.equal(
        limitResults.filter((r) => r.code === "KEY_LIMIT_REACHED").length,
        3,
      );

      // The runtime role cannot mint credentials itself; only the SQL functions can.
      await assert.rejects(
        apiPool.query(
          `INSERT INTO identity.api_keys(id,operator_id,agent_id,secret_hash,scopes,expires_at)
          SELECT gen_random_uuid(),operator_id,agent_id,secret_hash,scopes,expires_at FROM identity.api_keys LIMIT 1`,
        ),
        /permission denied/,
      );
      await assert.rejects(
        apiPool.query("UPDATE identity.api_keys SET scopes=ARRAY['admin']"),
        /permission denied/,
      );
    } finally {
      await Promise.all([owner.end(), apiPool.end()]);
      if (created) await control.query(`DROP DATABASE "${name}"`);
      await control.end();
    }
  },
);
