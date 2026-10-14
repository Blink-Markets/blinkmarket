import { test } from "node:test";
import assert from "node:assert/strict";
import { faucetFixture } from "./helpers/faucet.js";
import { testAccounts } from "./helpers/signer-fixture.js";
import { inviteAgent } from "./helpers/database.js";

test("faucet queues exactly 1,000 bUSD, blocks pending claims and replays idempotently", async () => {
  const w = await faucetFixture();
  try {
    await w.t.setRole("blink_api");
    const first = await w.post("first");
    assert.equal(first.statusCode, 202, first.body);
    assert.equal(first.json().state, "QUEUED");
    assert.deepEqual((await w.post("first")).json(), first.json());
    const pending = await w.post("second");
    assert.equal(pending.statusCode, 409);
    assert.equal(pending.json().code, "FAUCET_PENDING");
    const { rows } = await w.t.pool.query(
      "SELECT payload FROM signing.economic_intents WHERE id=$1",
      [first.json().intentId],
    );
    assert.deepEqual(rows[0].payload, {
      to: testAccounts.taker.address.toLowerCase(),
      amount: "1000000000",
    });
  } finally {
    await w.close();
  }
});

test("faucet rolling window starts at receipt time: 23:59:59 denies for one second, 24h admits", async () => {
  const w = await faucetFixture();
  try {
    const first = await w.post("first");
    const origin = Math.floor(Date.now() / 1000) * 1000;
    const stamp = new Date(origin).toISOString();
    await w.t.db.exec(
      `CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT '${stamp}'::timestamptz + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds',true),''),'0')::double precision) $$`,
    );
    await w.t.db.query(
      "UPDATE faucet.claims SET state='SUCCEEDED',succeeded_at=$2 WHERE id=$1",
      [first.json().claimId, stamp],
    );
    await w.t.setRole("blink_api");
    await w.t.db.exec("SET blink.test_clock_offset_seconds='86399'");
    const denied = await w.post("early");
    assert.equal(denied.statusCode, 429, denied.body);
    assert.equal(denied.headers["retry-after"], "1");
    await w.t.db.exec("SET blink.test_clock_offset_seconds='86400'");
    assert.equal((await w.post("exact")).statusCode, 202);
    assert.deepEqual(
      (await w.post("first")).json(),
      first.json(),
      "stored result survives window expiry",
    );
  } finally {
    await w.close();
  }
});

test("different keys bound to the same wallet share the guard; authorization and deployment are enforced", async () => {
  const w = await faucetFixture();
  try {
    // One agent/wallet may have multiple invited keys (design case 11).
    const { identityAdmin } =
      await import("../packages/adapters/src/identity-admin.js");
    const second = await identityAdmin(w.t.pool).issue(w.agent.agentId, {
      scopes: ["faucet:claim"],
      reason: "second fixture key",
    });
    const unbound = await inviteAgent(w.t, {
      name: "unbound",
      scopes: ["faucet:claim"],
    });
    await w.t.setRole("blink_api");
    assert.equal(
      (await w.post("unbound", unbound.apiKey)).json().code,
      "WALLET_NOT_VERIFIED",
    );
    assert.equal(
      (
        await w.post("foreign", w.agent.apiKey, { deploymentId: "other" })
      ).json().code,
      "DEPLOYMENT_MISMATCH",
    );
    assert.equal((await w.post("first")).statusCode, 202);
    assert.equal(
      (await w.post("second", second.apiKey)).json().code,
      "FAUCET_PENDING",
    );
    assert.equal(
      (await w.post("first", second.apiKey)).json().code,
      "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await w.close();
  }
});

test("faucet refuses an address outside the indexed allowlist and hostile bodies", async () => {
  const w = await faucetFixture();
  try {
    await w.t.db.exec("UPDATE chain.takers SET allowed=false");
    await w.t.setRole("blink_api");
    assert.equal(
      (await w.post("not-allowed")).json().code,
      "FAUCET_NOT_ALLOWED",
    );
    assert.equal(
      (
        await w.post("calldata", w.agent.apiKey, {
          deploymentId: w.manifest.deploymentId,
          to: testAccounts.taker.address,
          amount: "1",
        })
      ).statusCode,
      400,
    );
    await assert.rejects(
      w.t.pool.query("UPDATE faucet.claims SET state='SUCCEEDED'"),
      /permission denied/,
    );
    await assert.rejects(
      w.t.pool.query("SELECT raw_transaction FROM signing.artifacts"),
      /permission denied/,
    );
  } finally {
    await w.close();
  }
});
