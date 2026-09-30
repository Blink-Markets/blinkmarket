import {
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { requireDeployment } from "@blink/schemas";

export async function verifyDeploymentOnChain(
  input: unknown,
  expectedId: string,
  client: PublicClient,
  abis: { BlinkMarket: Abi; BlinkTestUSD: Abi },
) {
  const manifest = requireDeployment(
    input,
    expectedId,
    await client.getChainId(),
  );
  const block = await client.getBlock();
  if (BigInt(manifest.deploymentBlock) > block.number)
    throw new Error("DEPLOYMENT_BLOCK_IN_FUTURE");
  // deploymentBlock is an inclusive, safe replay lower bound for BOTH contracts.
  // Earlier bounds (including genesis) are safe; a bound after either deployment is not.
  const start = BigInt(manifest.deploymentBlock);
  for (const name of ["BlinkTestUSD", "BlinkMarket"] as const) {
    if (
      keccak256(toBytes(JSON.stringify(abis[name]))) !==
      manifest.artifacts.abiHashes[name]
    )
      throw new Error("ABI_HASH_MISMATCH");
    const code = await client.getCode({
      address: manifest.contracts[name] as Address,
      blockNumber: block.number,
    });
    if (
      !code ||
      code === "0x" ||
      keccak256(code) !== manifest.artifacts.bytecodeHashes[name]
    )
      throw new Error("BYTECODE_HASH_MISMATCH");
    if (start > 0n) {
      const previousCode = await client.getCode({
        address: manifest.contracts[name] as Address,
        blockNumber: start - 1n,
      });
      if (previousCode && previousCode !== "0x")
        throw new Error("DEPLOYMENT_BLOCK_TOO_LATE: " + name);
    }
  }
  const read = async (name: "BlinkTestUSD" | "BlinkMarket", fn: string) =>
    client.readContract({
      address: manifest.contracts[name] as Address,
      abi: abis[name],
      functionName: fn,
      blockNumber: block.number,
    });
  const matchAddress = async (
    name: "BlinkTestUSD" | "BlinkMarket",
    fn: string,
    expected: string,
  ) => {
    const observed = await read(name, fn);
    if (
      typeof observed !== "string" ||
      observed.toLowerCase() !== expected.toLowerCase()
    )
      throw new Error("DEPLOYMENT_ROLE_OR_ASSET_MISMATCH: " + fn);
  };
  await matchAddress(
    "BlinkMarket",
    "collateral",
    manifest.contracts.BlinkTestUSD,
  );
  for (const role of [
    "maker",
    "admin",
    "resultProposer",
    "challenger",
    "arbiter",
  ] as const)
    await matchAddress("BlinkMarket", role, manifest.roles[role]);
  await matchAddress("BlinkTestUSD", "minter", manifest.roles.faucetMinter);
  if (
    (await read("BlinkTestUSD", "decimals")) !== 6 ||
    (await read("BlinkTestUSD", "symbol")) !== "bUSD" ||
    (await read("BlinkTestUSD", "name")) !== "Blink Test USD"
  )
    throw new Error("WRONG_ASSET");
  for (const [fn, value] of [
    ["MAX_FILL_SHARES", 100n],
    ["MAX_MARKET_PAIRS", 10000n],
    ["MAX_TAKER_SHARES", 500n],
  ] as const) {
    if ((await read("BlinkMarket", fn)) !== value)
      throw new Error("CAP_MISMATCH");
  }
  if (
    (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
  )
    throw new Error("REORG_DURING_DEPLOYMENT_CHECK");
  return { manifest, asOfBlockHash: block.hash };
}
