import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import pg from "pg";

// Release the restored indexer lease before services reconnect. Requires the schema owner.
const DEPLOYMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export async function prepareRestoredDatabase(
  db: pg.Pool,
  deploymentId: string,
): Promise<{ leaseCleared: boolean }> {
  if (!DEPLOYMENT.test(deploymentId))
    throw new Error("RESTORE_PREPARE_INVALID_DEPLOYMENT_ID");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const lease = await client.query(
      "UPDATE chain.cursors SET lease_owner=NULL, lease_until=NULL WHERE deployment_id=$1 AND lease_owner IS NOT NULL",
      [deploymentId],
    );
    await client.query("COMMIT");
    return { leaseCleared: lease.rowCount === 1 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [deploymentId, ...rest] = process.argv.slice(2);
  const connectionString = process.env.RESTORE_ADMIN_DATABASE_URL;
  if (!deploymentId || rest.length || !connectionString) {
    console.error(
      "RESTORE_PREPARE_CONFIGURATION_REQUIRED: usage `pnpm restore:prepare <deploymentId>` with RESTORE_ADMIN_DATABASE_URL set to the restored database",
    );
    process.exitCode = 1;
  } else {
    const pool = new pg.Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    try {
      console.log(
        JSON.stringify(await prepareRestoredDatabase(pool, deploymentId)),
      );
    } catch (error) {
      console.error(
        error instanceof Error && error.message.startsWith("RESTORE_PREPARE_")
          ? error.message
          : "RESTORE_PREPARE_FAILED: check the login, the deployment id and that the dump was restored",
      );
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
