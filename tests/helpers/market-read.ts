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
  for (let id = 1; id <= 5; id++)
    await t.db.query(
      `INSERT INTO chain.markets
    (deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
    VALUES ('d1',$1,decode($2,'hex'),'memory:spec','REPLAY',4102444800,4102445000,4102446000,120,10000,500,'OPEN',$1,decode($3,'hex'),decode($3,'hex'))`,
      [id, hash(id).slice(2), hash(10).slice(2)],
    );
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
