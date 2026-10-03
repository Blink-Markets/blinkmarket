import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { createPublicClient, http, type Abi } from "viem";
import { registerVerifiedDeployment } from "../packages/adapters/src/deployment-registry.js";

const [file, id, reason] = process.argv.slice(2);
const connectionString = process.env.DEPLOYMENT_ADMIN_DATABASE_URL,
  rpc = process.env.BASE_SEPOLIA_RPC_URL;
if (!file || !id || !reason || !connectionString || !rpc)
  throw new Error("DEPLOYMENT_REGISTRATION_CONFIGURATION_REQUIRED");
const pool = new pg.Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
try {
  const artifacts =
    process.env.CONTRACT_ARTIFACT_DIRECTORY ?? "contracts/artifacts";
  const [input, market, token] = await Promise.all([
    readFile(file, "utf8"),
    readFile(join(artifacts, "BlinkMarket.json"), "utf8"),
    readFile(join(artifacts, "BlinkTestUSD.json"), "utf8"),
  ]);
  const result = await registerVerifiedDeployment(
    pool,
    JSON.parse(input),
    id,
    createPublicClient({
      transport: http(rpc, { timeout: 10000, retryCount: 1 }),
    }),
    {
      BlinkMarket: JSON.parse(market).abi as Abi,
      BlinkTestUSD: JSON.parse(token).abi as Abi,
    },
    reason,
  );
  console.log(JSON.stringify(result));
} catch {
  console.error(
    "DEPLOYMENT_REGISTRATION_FAILED: check manifest, RPC, artifacts, permissions and registry identity",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
