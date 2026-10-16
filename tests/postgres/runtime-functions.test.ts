import { test } from "node:test";
import assert from "node:assert/strict";
import { withDatabase } from "../helpers/postgres-database.js";

test("real PostgreSQL: fresh migrations remove PUBLIC EXECUTE and preserve explicit clock grants", async () => {
  await withDatabase(async ({ owner, login }) => {
    const publicGrants =
      await owner.query(`SELECT n.nspname,p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname IN ('blink','operations','identity','evidence','discovery','markets','chain','budgets','forecasts','signing','trading','faucet','resolution','analytics')
      AND a.grantee=0 AND a.privilege_type='EXECUTE'`);
    assert.deepEqual(publicGrants.rows, []);
    for (const role of [
      "blink_api",
      "blink_worker",
      "blink_signer",
      "blink_indexer",
      "blink_trading_admin",
    ]) {
      const db = await login({ memberOf: [role] });
      assert.ok((await db.query("SELECT blink.now() AS now")).rows[0].now);
    }
    const ungranted = await login({ memberOf: ["blink_identity_admin"] });
    await owner.query("GRANT USAGE ON SCHEMA blink TO blink_identity_admin");
    await assert.rejects(
      ungranted.query("SELECT blink.now()"),
      /permission denied for function now/,
    );
  });
});
