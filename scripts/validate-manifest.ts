import { readFile } from "node:fs/promises";
import { requireDeployment } from "../packages/schemas/src/index.js";
const [path, deploymentId, chainId] = process.argv.slice(2);
if (!path || !deploymentId || !chainId)
  throw new Error(
    "Usage: pnpm manifest:validate <path> <expected-deployment-id> <observed-chain-id>",
  );
const manifest = requireDeployment(
  JSON.parse(await readFile(path, "utf8")),
  deploymentId,
  Number(chainId),
);
console.log({
  deploymentId: manifest.deploymentId,
  chainId: manifest.chainId,
  status: "shape-valid; verify on-chain bytecode and roles before enabling",
});
