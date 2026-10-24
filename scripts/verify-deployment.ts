import { readFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { parseProtocolDeployment } from "../packages/schemas/src/index.js";
import { verifyProtocolDeployment } from "../packages/adapters/src/deployment-verifier.js";
const [path, id] = process.argv.slice(2);
const rpc = process.env["BASE_SEPOLIA_RPC_URL"];
if (!path || !id || !rpc)
  throw new Error(
    "Usage: BASE_SEPOLIA_RPC_URL=... pnpm manifest:verify <manifest> <expected-deployment-id>",
  );
const parsed = parseProtocolDeployment(
  JSON.parse(await readFile(path, "utf8")),
);
if (!parsed.ok) throw new Error(parsed.reason);
if (parsed.manifest.deploymentId !== id)
  throw new Error("DEPLOYMENT_ID_MISMATCH");
const report = await verifyProtocolDeployment(
  createPublicClient({ transport: http(rpc) }),
  parsed.manifest,
  {
    artifactsDir:
      process.env["CONTRACT_ARTIFACT_DIRECTORY"] ?? "contracts/artifacts",
  },
);
console.log(report);
if (!report.ok) process.exitCode = 1;
