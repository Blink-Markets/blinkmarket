import pg from "pg";
import { createPublicClient, http } from "viem";
import { createCreationTracker } from "../packages/application/src/creation-tracker.js";
import { postgresCreationTrackerStore } from "../packages/adapters/src/creation-tracker-store.js";
import { creationReceiptReader } from "../packages/adapters/src/creation-receipt-reader.js";
import {
  assertCreationTrackingMigrationsInstalled,
  assertCreationTrackingRuntimeRole,
} from "../packages/adapters/src/creation-tracking-schedule.js";

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
  await assertCreationTrackingRuntimeRole(pool);
  await assertCreationTrackingMigrationsInstalled(pool);
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
    "CREATION_TRACKING_BASE_MIGRATION_REQUIRED",
    "CREATION_TRACKING_SCHEDULE_MIGRATION_REQUIRED",
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
