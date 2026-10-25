import { hostname } from "node:os";
import pg from "pg";
import { createPublicClient, http } from "viem";
import { loadProtocolDeployment } from "../packages/adapters/src/deployment-registry.js";
import { protocolLogReader } from "../packages/adapters/src/protocol-log-reader.js";
import {
  indexerConfig,
  indexerFetchWithTimeout,
} from "../apps/indexer/src/config.js";
import { assertBaseSepolia } from "../packages/application/src/chain-indexer.js";
import {
  assertChainIndexInstalled,
  postgresProtocolIndexStore,
} from "../packages/adapters/src/protocol-index-store.js";
import { assertIndexerRuntimeRole } from "../packages/adapters/src/runtime-role.js";
import { rebuildChainProjection } from "../packages/application/src/chain-indexer.js";

const args = process.argv.slice(2);
const verify = args.includes("--verify");
const [deploymentId, ...rest] = args.filter((arg) => arg !== "--verify");
const config = indexerConfig(process.env);
const connectionString = config.databaseUrl;
if (
  !deploymentId ||
  !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(deploymentId) ||
  rest.length ||
  !connectionString ||
  !config.rpcUrl
)
  throw new Error(
    "CHAIN_REBUILD_CONFIGURATION_REQUIRED: usage `pnpm chain:rebuild <deploymentId> [--verify]` with INDEXER_DATABASE_URL and BASE_SEPOLIA_RPC_URL set",
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
  const reader = protocolLogReader(
    createPublicClient({
      transport: http(config.rpcUrl!, {
        timeout: config.rpcTimeoutMs,
        retryCount: 0,
        fetchFn: indexerFetchWithTimeout(config.rpcTimeoutMs),
      }),
    }),
    await loadProtocolDeployment(pool, deploymentId),
  );
  assertBaseSepolia(await reader.chainId());
  const report = await rebuildChainProjection(
    postgresProtocolIndexStore(pool),
    deploymentId,
    {
      verify,
      reader,
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
    "PROJECTION_MISMATCH",
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
