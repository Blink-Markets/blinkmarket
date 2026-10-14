import { createTestDatabase, inviteAgent, bindWallet } from "./database.js";
import {
  seedDeployment,
  testManifest,
  testAccounts,
} from "./signer-fixture.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresFaucetStore } from "../../packages/adapters/src/faucet-store.js";
import { createFaucetService } from "../../packages/application/src/faucet.js";
import { buildApi } from "../../apps/api/src/server.js";

export async function faucetFixture() {
  const t = await createTestDatabase();
  const manifest = testManifest();
  await seedDeployment(t.db, manifest);
  const agent = await inviteAgent(t, {
    name: "faucet",
    scopes: ["faucet:claim"],
  });
  await bindWallet(t, agent.agentId, testAccounts.taker.address);
  await t.db.query(
    "INSERT INTO chain.takers VALUES($1,decode($2,'hex'),true,decode(repeat('11',32),'hex'))",
    [manifest.deploymentId, testAccounts.taker.address.slice(2)],
  );
  const app = buildApi({
    services: [
      createFaucetService({
        store: postgresFaucetStore(t.pool),
        crypto: identityCrypto,
        deploymentId: manifest.deploymentId,
      }),
    ],
  });
  const post = (
    key: string,
    apiKey = agent.apiKey,
    body: unknown = { deploymentId: manifest.deploymentId },
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/faucet/claims",
      headers: { authorization: "Bearer " + apiKey, "idempotency-key": key },
      payload: body as never,
    });
  return {
    t,
    manifest,
    agent,
    app,
    post,
    async close() {
      await app.close();
      await t.close();
    },
  };
}
