import pg from "pg";
import { createPublicClient, http } from "viem";
import { createCreationTracker } from "../packages/application/src/creation-tracker.js";
import { postgresCreationTrackerStore } from "../packages/adapters/src/creation-tracker-store.js";
import { creationReceiptReader } from "../packages/adapters/src/creation-receipt-reader.js";

const [intentId, txHash] = process.argv.slice(2);
const connectionString = process.env.INDEXER_DATABASE_URL,
  rpc = process.env.BASE_SEPOLIA_RPC_URL;
if (
  !intentId ||
  !/^[0-9a-f-]{36}$/i.test(intentId) ||
  !txHash ||
  !connectionString ||
  !rpc
)
  throw new Error("CREATION_RECONCILE_CONFIGURATION_REQUIRED");
const pool = new pg.Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
try {
  const role =
    await pool.query(`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
    AND pg_has_role(current_user,'blink_indexer','USAGE')
    AND NOT pg_has_role(current_user,'blink_api','USAGE')
    AND NOT pg_has_role(current_user,'blink_deployment_admin','USAGE')
    AND NOT pg_has_role(current_user,'blink_identity_admin','USAGE')
    AND NOT pg_has_role(current_user,'blink_evidence_admin','USAGE')
    AND NOT has_schema_privilege(current_user,'chain','CREATE') AS allowed FROM pg_roles WHERE rolname=current_user`);
  if (role.rows[0]?.allowed !== true)
    throw new Error("UNSAFE_INDEXER_DATABASE_ROLE");
  const tracker = createCreationTracker(
    postgresCreationTrackerStore(pool),
    creationReceiptReader(
      createPublicClient({
        transport: http(rpc, { timeout: 10000, retryCount: 1 }),
      }),
    ),
  );
  console.log(
    JSON.stringify(await tracker.reconcile(intentId.toLowerCase(), txHash)),
  );
} catch (error) {
  const known = new Set([
    "CREATION_INTENT_NOT_FOUND",
    "TRACKED_TRANSACTION_CONFLICT",
    "STALE_CREATION_OBSERVATION",
    "DEPLOYMENT_DISABLED",
    "UNSAFE_INDEXER_DATABASE_ROLE",
  ]);
  console.error(
    error instanceof Error && known.has(error.message)
      ? error.message
      : "CREATION_RECONCILE_FAILED: verify RPC, transaction, permissions and migrations; no transaction was sent",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
