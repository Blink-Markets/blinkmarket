import { test } from "node:test";
import assert from "node:assert/strict";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../packages/adapters/src/identity-store.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import {
  bindWallet,
  createTestDatabase,
  inviteAgent,
} from "./helpers/database.js";

test("test database helpers: role switching, invited agents and direct wallet bindings", async () => {
  const t = await createTestDatabase();
  try {
    const identity = createIdentityService(
      postgresIdentityStore(t.pool),
      identityCrypto,
      "https://blink.example",
    );
    await assert.rejects(t.setRole("postgres"), /UNKNOWN_TEST_ROLE/);
    await t.setRole("blink_api");
    // Fixtures are written as the owner, and the test's role is restored afterwards.
    const agent = await inviteAgent(t, {
      name: "forecaster",
      scopes: ["forecast:write"],
    });
    assert.equal(
      (await t.db.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u,
      "blink_api",
    );
    assert.equal(
      (await identity.authenticate("Bearer " + agent.apiKey, "forecast:write"))
        .agentId,
      agent.agentId,
    );
    await assert.rejects(
      identity.authenticate("Bearer " + agent.apiKey, "admin"),
      { status: 403 },
    );
    const address = "0x" + "ab".repeat(20);
    await bindWallet(t, agent.agentId, address);
    assert.equal(
      await postgresIdentityStore(t.pool).run((tx) => tx.wallet(agent.agentId)),
      address,
    );
    await t.setRole(null);
    assert.equal(
      (
        await t.db.query<{ u: string }>(
          "SELECT current_user = session_user AS u",
        )
      ).rows[0]!.u,
      true,
    );
  } finally {
    await t.close();
  }
});
