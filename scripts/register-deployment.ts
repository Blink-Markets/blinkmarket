import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPublicClient, http } from "viem";
import { parseProtocolDeployment } from "../packages/schemas/src/index.js";
import { registerProtocolDeployment } from "../packages/adapters/src/deployment-registry.js";
import { verifyProtocolDeployment } from "../packages/adapters/src/deployment-verifier.js";

const [file, id] = process.argv.slice(2);
const connectionString = process.env.DEPLOYMENT_ADMIN_DATABASE_URL,
  rpc = process.env.BASE_SEPOLIA_RPC_URL;
if (!file || !id || !connectionString || !rpc)
  throw new Error("DEPLOYMENT_REGISTRATION_CONFIGURATION_REQUIRED");
const pool = new pg.Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
try {
  const parsed = parseProtocolDeployment(
    JSON.parse(await readFile(file, "utf8")),
  );
  if (!parsed.ok || parsed.manifest.deploymentId !== id)
    throw new Error("MANIFEST_INVALID");
  const report = await verifyProtocolDeployment(
    createPublicClient({
      transport: http(rpc, { timeout: 10000, retryCount: 1 }),
    }),
    parsed.manifest,
    {
      artifactsDir:
        process.env.CONTRACT_ARTIFACT_DIRECTORY ?? "contracts/artifacts",
    },
  );
  await registerProtocolDeployment(pool, parsed.manifest, report);
  console.log(
    JSON.stringify({ deploymentId: id, blockHash: report.blockHash }),
  );
} catch {
  console.error(
    "DEPLOYMENT_REGISTRATION_FAILED: check manifest, RPC, artifacts, permissions and registry identity",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
