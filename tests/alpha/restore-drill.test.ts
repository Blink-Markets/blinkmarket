import { test } from "node:test";
import assert from "node:assert/strict";
import { runRestoreDrill } from "../../scripts/restore-drill.ts";
import { withDatabase, adminUrl } from "../helpers/postgres-database.js";
import {
  seedDeployment,
  seedChain,
  testManifest,
} from "../helpers/protocol-fixture.js";
import { databaseTraces, leakedTraces } from "../helpers/postgres-traces.js";

test(
  "infrastructure restore preserves rows, schema and grants, clears the dead lease and detects tampering",
  { timeout: 300_000 },
  async (t) => {
    const before = await databaseTraces();
    await withDatabase(async ({ owner }) => {
      const manifest = testManifest();
      await seedDeployment(owner, manifest);
      await seedChain(owner, { deploymentId: manifest.deploymentId });
      await owner.query(
        `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,synced_at,lease_owner,lease_until)
      VALUES($1,10,decode(repeat('11',32),'hex'),1000,10,clock_timestamp(),'dead-indexer',clock_timestamp()+interval '1 hour')`,
        [manifest.deploymentId],
      );
      const context = {
        owner,
        adminUrl: adminUrl!,
        deploymentId: manifest.deploymentId,
        signal: t.signal,
      };
      const report = await runRestoreDrill(context);
      assert.match(report.pgDumpVersion, /^pg_dump \(PostgreSQL\) 17\.6\b/);
      assert.ok(report.archiveBytes > 0);
      assert.equal(report.restoredEqualsDump, true);
      assert.equal(report.schemaIdentical, true);
      assert.equal(report.leaseCleared, true);
      for (const sql of [
        "UPDATE chain.markets SET max_pairs=max_pairs+1",
        "UPDATE chain.cursors SET head_number=head_number+1",
      ])
        await assert.rejects(
          runRestoreDrill(context, {
            afterRestore: async (db) => {
              await db.query(sql);
            },
          }),
          /RESTORE_NOT_EQUAL_TO_DUMP/,
        );
    });
    assert.deepEqual(await leakedTraces(before), []);
  },
);
