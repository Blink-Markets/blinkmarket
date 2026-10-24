import { readFile } from "node:fs/promises";
import { parseProtocolDeployment } from "../packages/schemas/src/index.js";
const [path, deploymentId] = process.argv.slice(2);
if (!path || !deploymentId)
  throw new Error(
    "Usage: pnpm manifest:validate <path> <expected-deployment-id>",
  );
const parsed = parseProtocolDeployment(
  JSON.parse(await readFile(path, "utf8")),
);
if (!parsed.ok) throw new Error(parsed.reason);
if (parsed.manifest.deploymentId !== deploymentId)
  throw new Error("DEPLOYMENT_ID_MISMATCH");
console.log({
  deploymentId: parsed.manifest.deploymentId,
  chainId: parsed.manifest.chainId,
  generation: parsed.manifest.generation.index,
  status:
    "shape-valid; verify on-chain code and links with pnpm manifest:verify",
});
