import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { identityFixture } from "../helpers/identity-fixture.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
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
    try {
      await control.query(`CREATE DATABASE "${name}"`);
      created = true;
      const migrationClient = await owner.connect();
      try {
        await migrate(migrationClient);
      } finally {
        migrationClient.release();
      }
      const admin = identityFixture(adminPool);
      const invitation = () =>
        admin.invite({
          operatorName: "Race test",
          agentName: "Race agent",
          scopes: ["forecast:write"],
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
      await admin.revoke(invited.keyId, "Post-race revocation");
      await assert.rejects(
        service.mutate(challengePath, request),
        (error: unknown) =>
          error instanceof IdentityError && error.status === 401,
      );
    } finally {
      await Promise.all([owner.end(), adminPool.end(), apiPool.end()]);
      if (created) await control.query(`DROP DATABASE "${name}"`);
      await control.end();
    }
  },
);
