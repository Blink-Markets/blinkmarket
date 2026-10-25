import { createTestDatabase, inviteAgent } from "./database.js";
import { poolAs } from "./pool-as.js";
import { seedChain } from "./protocol-fixture.js";
export const DEPLOYMENT = "status-test";
export async function statusWorld() {
  const t = await createTestDatabase();
  const agents = {
    admin: await inviteAgent(t, { name: "admin", scopes: ["admin"] }),
    taker: await inviteAgent(t, { name: "taker", scopes: ["trade:quote"] }),
  };
  await seedChain(t.pool, { deploymentId: DEPLOYMENT });
  await t.db.query(
    `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at)
    VALUES($1,100,decode(repeat('11',32),'hex'),1000,100,blink.now())`,
    [DEPLOYMENT],
  );
  const apiPool = poolAs(t, "blink_api");
  const owner = async <T>(run: () => Promise<T>) => {
    await t.setRole(null);
    try {
      return await run();
    } finally {
      await t.setRole("blink_api");
    }
  };
  return { t, agents, apiPool, owner, close: () => t.close() };
}
