import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import pg from "pg";

// The first thing to do to a database that was just restored from a backup, before any service
// connects to it (`pnpm restore:prepare <deploymentId>`; the restore drill runs this same function):
//   1. close the maker pool's quote gate. Only the reservation reconciler clears it, and it
//      refuses to while the chain cursor is stale, gated or lagging, so quoting stays closed until
//      the indexer has caught up and the reservations have been judged against the chain;
//   2. release the cursor lease the dead indexer held in the dump. Commits are fenced by the
//      lease token, so this cannot let two indexers write; it only spares the new one the wait.
// It needs a login that owns the schema (the one that restored the dump), never a service login.
const DEPLOYMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export async function prepareRestoredDatabase(
  db: pg.Pool,
  deploymentId: string,
): Promise<{ gateClosed: true; leaseCleared: boolean }> {
  if (!DEPLOYMENT.test(deploymentId))
    throw new Error("RESTORE_PREPARE_INVALID_DEPLOYMENT_ID");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO trading.maker_pools(deployment_id, gate_reason) VALUES($1,'OVERCOMMITTED')
      ON CONFLICT (deployment_id) DO UPDATE SET gate_reason='OVERCOMMITTED', version=trading.maker_pools.version+1`,
      [deploymentId],
    );
    const lease = await client.query(
      "UPDATE chain.cursors SET lease_owner=NULL, lease_until=NULL WHERE deployment_id=$1",
      [deploymentId],
    );
    await client.query("COMMIT");
    return { gateClosed: true, leaseCleared: lease.rowCount === 1 };
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
    const pool = new pg.Pool({ connectionString, max: 1 });
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
