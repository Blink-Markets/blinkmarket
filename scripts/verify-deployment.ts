import { readFile } from "node:fs/promises";
import { createPublicClient, http, type Abi } from "viem";
import { verifyDeploymentOnChain } from "../packages/adapters/src/deployment-verifier.js";
const [path, id] = process.argv.slice(2);
const rpc = process.env["BASE_SEPOLIA_RPC_URL"];
if (!path || !id || !rpc)
  throw new Error(
    "Usage: BASE_SEPOLIA_RPC_URL=... pnpm manifest:verify <manifest> <expected-deployment-id>",
  );
const [input, m, t] = await Promise.all([
  readFile(path, "utf8"),
  readFile("contracts/artifacts/BlinkMarket.json", "utf8"),
  readFile("contracts/artifacts/BlinkTestUSD.json", "utf8"),
]);
const result = await verifyDeploymentOnChain(
  JSON.parse(input),
  id,
  createPublicClient({ transport: http(rpc) }),
  {
    BlinkMarket: JSON.parse(m).abi as Abi,
    BlinkTestUSD: JSON.parse(t).abi as Abi,
  },
);
console.log({
  deploymentId: result.manifest.deploymentId,
  asOfBlockHash: result.asOfBlockHash,
  status: "verified; does not enable trading",
});
