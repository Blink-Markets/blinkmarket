import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes, type PublicClient, type Abi } from "viem";
import { verifyDeploymentOnChain } from "../packages/adapters/src/deployment-verifier.js";

test("deployment verification rejects wrong bytecode, roles, ABI and reorg", async () => {
  const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const code = "0x6000" as const;
  const roles = {
    admin: addr(1),
    resultProposer: addr(2),
    challenger: addr(3),
    arbiter: addr(4),
    maker: addr(5),
    faucetMinter: addr(6),
  };
  const hash = keccak256(toBytes("block"));
  const abiHash = keccak256(toBytes("[]"));
  const input = {
    status: "DEPLOYED",
    deploymentId: "test",
    chainId: 84532,
    deploymentBlock: "1",
    contracts: { BlinkMarket: addr(10), BlinkTestUSD: addr(11) },
    roles,
    artifacts: {
      abiHashes: { BlinkMarket: abiHash, BlinkTestUSD: abiHash },
      bytecodeHashes: {
        BlinkMarket: keccak256(code),
        BlinkTestUSD: keccak256(code),
      },
      compiler: "0.8.30",
      gitCommit: "1".repeat(40),
      dependencies: { openzeppelin: "5.6.1" },
    },
    parameters: {
      collateralDecimals: 6,
      quoteDefaultTtlSeconds: 30,
      quoteMaxTtlSeconds: 60,
      makerSpreadBps: 200,
      maxFillShares: "100",
      maxMarketPairs: "10000",
      maxTakerShares: "500",
    },
    tradingEnabled: false,
  };
  let wrongRole = false,
    wrongCode = false,
    reorg = false;
  const client = {
    async getChainId() {
      return 84532;
    },
    async getBlock(query?: unknown) {
      return {
        number: 10n,
        hash: reorg && query ? "0x" + "2".repeat(64) : hash,
      };
    },
    async getCode({ blockNumber }: { blockNumber: bigint }) {
      if (blockNumber < 1n) return "0x";
      return wrongCode ? "0x6001" : code;
    },
    async readContract({ functionName }: { functionName: string }) {
      const values: Record<string, unknown> = {
        ...roles,
        collateral: addr(11),
        minter: roles.faucetMinter,
        decimals: 6,
        symbol: "bUSD",
        name: "Blink Test USD",
        MAX_FILL_SHARES: 100n,
        MAX_MARKET_PAIRS: 10000n,
        MAX_TAKER_SHARES: 500n,
      };
      return wrongRole && functionName === "maker"
        ? addr(99)
        : values[functionName];
    },
  } as unknown as PublicClient;
  const abis = { BlinkMarket: [] as Abi, BlinkTestUSD: [] as Abi };
  assert.equal(
    (await verifyDeploymentOnChain(input, "test", client, abis)).asOfBlockHash,
    hash,
  );
  for (const deploymentBlock of ["0", "1"]) {
    await verifyDeploymentOnChain(
      { ...input, deploymentBlock },
      "test",
      client,
      abis,
    );
  }
  for (const deploymentBlock of ["2", "10"]) {
    await assert.rejects(
      verifyDeploymentOnChain(
        { ...input, deploymentBlock },
        "test",
        client,
        abis,
      ),
      /DEPLOYMENT_BLOCK_TOO_LATE/,
    );
  }
  await assert.rejects(
    verifyDeploymentOnChain(
      { ...input, deploymentBlock: "11" },
      "test",
      client,
      abis,
    ),
    /DEPLOYMENT_BLOCK_IN_FUTURE/,
  );
  // Staggered deployment: either contract existing before the bound is unsafe.
  for (const earlyContract of [
    input.contracts.BlinkMarket,
    input.contracts.BlinkTestUSD,
  ]) {
    const staggeredClient = {
      ...client,
      getCode: async ({
        address,
        blockNumber,
      }: {
        address: string;
        blockNumber: bigint;
      }) =>
        blockNumber >= (address === earlyContract ? 1n : 5n) ? code : "0x",
    } as unknown as PublicClient;
    await verifyDeploymentOnChain(input, "test", staggeredClient, abis);
    await assert.rejects(
      verifyDeploymentOnChain(
        { ...input, deploymentBlock: "5" },
        "test",
        staggeredClient,
        abis,
      ),
      /DEPLOYMENT_BLOCK_TOO_LATE/,
    );
  }
  const unavailableHistory = {
    ...client,
    getCode: async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber < 10n) throw new Error("historical state unavailable");
      return code;
    },
  } as unknown as PublicClient;
  await assert.rejects(
    verifyDeploymentOnChain(input, "test", unavailableHistory, abis),
    /historical state unavailable/,
  );
  wrongRole = true;
  await assert.rejects(
    verifyDeploymentOnChain(input, "test", client, abis),
    /ROLE_OR_ASSET/,
  );
  wrongRole = false;
  wrongCode = true;
  await assert.rejects(
    verifyDeploymentOnChain(input, "test", client, abis),
    /BYTECODE/,
  );
  wrongCode = false;
  reorg = true;
  await assert.rejects(
    verifyDeploymentOnChain(input, "test", client, abis),
    /REORG/,
  );
  reorg = false;
  input.artifacts.abiHashes.BlinkMarket = keccak256(toBytes("wrong"));
  await assert.rejects(
    verifyDeploymentOnChain(input, "test", client, abis),
    /ABI_HASH/,
  );
});
