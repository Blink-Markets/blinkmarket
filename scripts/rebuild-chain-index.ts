import { hostname } from "node:os";
import pg from "pg";
import {
  assertChainIndexInstalled,
  postgresChainIndexStore,
} from "../packages/adapters/src/chain-index-store.js";
import { assertIndexerRuntimeRole } from "../packages/adapters/src/runtime-role.js";
import { rebuildChainProjection } from "../packages/application/src/chain-indexer.js";

const args = process.argv.slice(2);
const verify = args.includes("--verify");
const [deploymentId, ...rest] = args.filter((arg) => arg !== "--verify");
const connectionString = process.env.INDEXER_DATABASE_URL;
if (
  !deploymentId ||
  !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(deploymentId) ||
  rest.length ||
  !connectionString
)
  throw new Error(
    "CHAIN_REBUILD_CONFIGURATION_REQUIRED: usage `pnpm chain:rebuild <deploymentId> [--verify]` with INDEXER_DATABASE_URL set",
  );
const pool = new pg.Pool({
  connectionString,
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 60000,
});
try {
  await assertIndexerRuntimeRole(pool);
  await assertChainIndexInstalled(pool);
  const report = await rebuildChainProjection(
    postgresChainIndexStore(pool),
    deploymentId,
    {
      verify,
      workerId: "rebuild:" + hostname().slice(0, 64) + ":" + process.pid,
    },
  );
  console.log(JSON.stringify(report));
  // The restore drill treats any difference found by --verify as a failure.
  if (verify && report.differences.length) process.exitCode = 1;
} catch (error) {
  const known = new Set([
    "CHAIN_CURSOR_NOT_FOUND",
    "CHAIN_INDEX_LEASE_HELD",
    "CHAIN_INDEX_MIGRATION_REQUIRED",
    "INCONSISTENT_EVENT",
    "UNSAFE_INDEXER_DATABASE_ROLE",
  ]);
  console.error(
    error instanceof Error && known.has(error.message)
      ? error.message
      : "CHAIN_REBUILD_FAILED: verify the database login, the deployment id and the migrations",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
