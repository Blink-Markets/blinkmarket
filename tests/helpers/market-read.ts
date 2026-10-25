import { seedReadMarket } from "./protocol-index.ts";
import { buildApi } from "../../apps/api/src/server.js";
import { createMarketReadService } from "../../packages/application/src/market-read.js";
import { postgresMarketReadStore } from "../../packages/adapters/src/market-read-store.js";
import { postgresProtocolReader } from "../../packages/adapters/src/protocol-index-store.js";
import { createTestDatabase } from "./database.js";

export const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export const address = "0x" + "11".repeat(20);
export async function fixture() {
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
  // Spec bytes by hash; a hash that is absent has no stored bytes.
  const objects = new Map<string, Uint8Array>();
  const content = {
    async get(h: string) {
      const bytes = objects.get(h);
      return bytes
        ? { object: { hash: h, size: bytes.length, mediaType: "application/json" as const }, bytes }
        : null;
    },
  };
  const service = createMarketReadService({
    store: postgresMarketReadStore(t.pool),
    reader: postgresProtocolReader(t.pool, "d1"),
    content,
    deployment: async () => null,
  });
  const app = buildApi({ services: [service] });
  return {
    ...t,
    app,
    objects,
    async close() {
      await app.close();
      await t.close();
    },
  };
}
