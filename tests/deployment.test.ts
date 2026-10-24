import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes, type PublicClient, type Abi } from "viem";
import { getContractAddress } from "viem";
import { readFileSync } from "node:fs";
import { verifyDeploymentOnChain } from "../packages/adapters/src/deployment-verifier.js";
import { planProtocolDeployment } from "../packages/adapters/src/protocol-deployer.js";
import {
  parseProtocolDeployment,
  presets,
} from "../packages/schemas/src/index.js";

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

const DEPLOYER = "0x" + "d".repeat(40);
const TREASURY = "0x" + "e".repeat(40);
const planInput = {
  deployer: DEPLOYER as `0x${string}`,
  nonce: 7,
  params: presets.alpha,
  treasury: TREASURY as `0x${string}`,
};

test("a protocol plan lists eight transactions with consecutive nonces and predicted addresses", () => {
  const plan = planProtocolDeployment(planInput);
  assert.deepEqual(
    plan.transactions.map((t) => [t.name, t.phase, t.nonce]),
    [
      ["BlinkFaucet", "shared", 7],
      ["FixedPriceSource", "shared", 8],
      ["BlinkGovernor", "shared", 9],
      ["BlinkAnchor", "shared", 10],
      ["BlinkRegistry", "generation", 11],
      ["BlinkJurors", "generation", 12],
      ["BlinkMarkets", "generation", 13],
      ["BlinkResolution", "generation", 14],
    ],
  );
  for (const t of plan.transactions)
    assert.equal(
      t.address,
      getContractAddress({ from: plan.deployer, nonce: BigInt(t.nonce) }),
    );
  // BlinkFaucet creates bUSD then the platform token: its CREATE nonces 1 and 2.
  assert.equal(
    plan.shared.busd,
    getContractAddress({
      from: plan.shared.faucet as `0x${string}`,
      nonce: 1n,
    }),
  );
  assert.equal(
    plan.shared.token,
    getContractAddress({
      from: plan.shared.faucet as `0x${string}`,
      nonce: 2n,
    }),
  );
  assert.deepEqual(planProtocolDeployment(planInput), plan);
  for (const t of plan.transactions)
    assert.match(t.constructorArgsHash, /^0x[0-9a-f]{64}$/);
});

test("a plan that reuses shared contracts only lists the generation", () => {
  const first = planProtocolDeployment(planInput);
  const second = planProtocolDeployment({
    ...planInput,
    nonce: 20,
    shared: first.shared,
    previousRegistry: first.generation.registry,
  });
  assert.deepEqual(
    second.transactions.map((t) => t.nonce),
    [20, 21, 22, 23],
  );
  assert.deepEqual(second.shared, first.shared);
  assert.equal(second.previousRegistry, first.generation.registry);
  // The registry hash covers the previous registry; generation 1's does not.
  assert.notEqual(
    second.transactions[0]!.constructorArgsHash,
    first.transactions[4]!.constructorArgsHash,
  );
});

test("a plan refuses bad input before anything is listed", () => {
  const first = planProtocolDeployment(planInput);
  assert.throws(
    () => planProtocolDeployment({ ...planInput, nonce: -1 }),
    /INVALID_NONCE/,
  );
  assert.throws(
    () =>
      planProtocolDeployment({
        ...planInput,
        treasury: ("0x" + "0".repeat(40)) as `0x${string}`,
      }),
    /INVALID_ADDRESS/,
  );
  assert.throws(
    () =>
      planProtocolDeployment({
        ...planInput,
        deployer: "0x1234" as `0x${string}`,
      }),
    /INVALID_ADDRESS/,
  );
  assert.throws(
    () =>
      planProtocolDeployment({
        ...planInput,
        previousRegistry: first.generation.registry,
      }),
    /PREVIOUS_REGISTRY_REQUIRES_SHARED/,
  );
  assert.throws(() =>
    planProtocolDeployment({
      ...planInput,
      params: { ...presets.alpha, feeBps: 1, treasuryShareBps: 1 },
    }),
  );
});

test("the v2 template is not a deployable manifest", () => {
  const template = JSON.parse(
    readFileSync("deployments/base-sepolia/manifest.template.json", "utf8"),
  );
  assert.equal(template.schema, "blink.deployment/2");
  assert.equal(parseProtocolDeployment(template).ok, false);
});
