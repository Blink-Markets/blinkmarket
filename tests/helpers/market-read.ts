import { seedReadMarket } from "./protocol-index.ts";
import { buildApi } from "../../apps/api/src/server.js";
import { createMarketReadService } from "../../packages/application/src/market-read.js";
import { postgresMarketReadStore } from "../../packages/adapters/src/market-read-store.js";
import { verifiedArchive } from "../../packages/adapters/src/content-store.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { authenticateIdentity } from "../../packages/application/src/identity.js";
import { createTestDatabase } from "./database.js";

export const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export const address = "0x" + "11".repeat(20);
export async function fixture(
  hooks?: Parameters<typeof createMarketReadService>[0]["hooks"],
) {
  const t = await createTestDatabase();
  await t.db.query(
    "INSERT INTO markets.deployments(id,manifest,market_address) VALUES ('d1','{}',decode($1,'hex'))",
    [address.slice(2)],
  );
  for (let id = 1; id <= 5; id++) await seedReadMarket(t.db, "d1", id);
  await t.db.query(
    `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,finalized_number,synced_at)
    VALUES ('d1',10,decode($1,'hex'),1000,10,3,blink.now())`,
    [hash(10).slice(2)],
  );
  const objects = new Map<string, Uint8Array>();
  const archive = verifiedArchive({
    async read(uri) {
      const bytes = objects.get(uri);
      if (!bytes) throw new Error("MISSING");
      return bytes;
    },
    async putIfAbsent(bytes, h) {
      objects.set(h, bytes);
      return { uri: h };
    },
  });
  const identityStore = postgresIdentityStore(t.pool);
  const service = createMarketReadService({
    store: postgresMarketReadStore(t.pool),
    archive,
    ...(hooks ? { hooks } : {}),
    identity: {
      authenticate: (authorization) =>
        identityStore.run(async (tx) => {
          const p = await authenticateIdentity(
            tx,
            identityCrypto,
            authorization,
          );
          return { ...p, wallet: await tx.wallet(p.agentId) };
        }),
    },
  });
  const app = buildApi({ services: [service] });
  return {
    ...t,
    app,
    archive,
    objects,
    async close() {
      await app.close();
      await t.close();
    },
  };
}
