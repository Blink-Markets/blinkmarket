import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withDatabase } from "../helpers/postgres-database.js";
import { identityAdmin } from "../../packages/adapters/src/identity-admin.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresFaucetStore } from "../../packages/adapters/src/faucet-store.js";
import { createFaucetService } from "../../packages/application/src/faucet.js";
import { buildApi } from "../../apps/api/src/server.js";
import {
  seedDeployment,
  testManifest,
  testAccounts,
} from "../helpers/signer-fixture.js";

test(
  "real PostgreSQL: five concurrent claims for one address admit exactly one 202",
  { timeout: 30000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      const admin = identityAdmin(pool("blink_identity_admin"));
      const agent = await admin.invite({
        operatorName: "faucet race",
        agentName: "faucet race",
        scopes: ["faucet:claim"],
        reason: "isolated race fixture",
      });
      const second = await admin.issue(agent.agentId, {
        scopes: ["faucet:claim"],
        reason: "same wallet second key",
      });
      const challenge = randomUUID();
      await owner.query(
        `INSERT INTO identity.wallet_challenges(id,key_id,agent_id,address,chain_id,origin,nonce_hash,message,issued_at,expires_at,consumed_at)
      VALUES($1,$2,$3,decode($4,'hex'),84532,'https://fixture.invalid',decode(repeat('11',32),'hex'),'fixture',$5::timestamptz,$5::timestamptz+interval '5 minutes',$5::timestamptz)`,
        [
          challenge,
          agent.keyId,
          agent.agentId,
          testAccounts.taker.address.slice(2),
          new Date().toISOString(),
        ],
      );
      await owner.query(
        "INSERT INTO identity.wallet_bindings(agent_id,chain_id,address,challenge_id) VALUES($1,84532,decode($2,'hex'),$3)",
        [agent.agentId, testAccounts.taker.address.slice(2), challenge],
      );
      await owner.query(
        "INSERT INTO chain.takers VALUES($1,decode($2,'hex'),true,decode(repeat('11',32),'hex'))",
        [manifest.deploymentId, testAccounts.taker.address.slice(2)],
      );
      const api = pool("blink_api");
      const app = buildApi({
        services: [
          createFaucetService({
            store: postgresFaucetStore(api),
            crypto: identityCrypto,
            deploymentId: manifest.deploymentId,
          }),
        ],
      });
      try {
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            app.inject({
              method: "POST",
              url: "/v1/faucet/claims",
              headers: {
                authorization:
                  "Bearer " + (i % 2 ? second.apiKey : agent.apiKey),
                "idempotency-key": "race-" + i,
              },
              payload: { deploymentId: manifest.deploymentId },
            }),
          ),
        );
        assert.equal(
          results.filter((r) => r.statusCode === 202).length,
          1,
          results.map((r) => r.body).join("\n"),
        );
        assert.equal(
          results.filter(
            (r) => r.statusCode === 409 && r.json().code === "FAUCET_PENDING",
          ).length,
          4,
        );
        assert.equal(
          (await owner.query("SELECT id FROM faucet.claims")).rows.length,
          1,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT id FROM signing.economic_intents WHERE kind='MINT'",
            )
          ).rows.length,
          1,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT id FROM operations.jobs WHERE type='faucet.mint'",
            )
          ).rows.length,
          1,
        );
        await assert.rejects(
          api.query(
            "INSERT INTO signing.economic_intents(id,deployment_id,kind,role,dedupe_key,payload,payload_hash,created_by) VALUES($1,$2,'FINALIZE_TIMEOUT','keeper','hostile','{}',decode(repeat('11',32),'hex'),'api')",
            [randomUUID(), manifest.deploymentId],
          ),
          /MAKER_QUOTE and MINT/,
        );
        await assert.rejects(
          api.query("SELECT raw_transaction FROM signing.artifacts"),
          /permission denied/,
        );
      } finally {
        await app.close();
      }
    });
  },
);
