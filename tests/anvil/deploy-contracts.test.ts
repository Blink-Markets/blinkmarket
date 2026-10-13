import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  getContractAddress,
  http,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
// @ts-expect-error Plain JS tool resolver has no declaration file.
import { foundryBinary } from "../../scripts/foundry.mjs";
import { DeploymentManifest } from "../../packages/schemas/src/index.js";
import { verifyDeploymentOnChain } from "../../packages/adapters/src/deployment-verifier.js";
import {
  deployContracts,
  planDeployment,
  readReleaseCommit,
  type RoleAddresses,
} from "../../packages/adapters/src/contract-deployer.js";

// Public Anvil fixture mnemonic, never funded outside a local node.
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (addressIndex: number) =>
  mnemonicToAccount(MNEMONIC, { addressIndex });
const deployer = account(0);
const roles: RoleAddresses = {
  admin: account(1).address,
  resultProposer: account(2).address,
  challenger: account(3).address,
  arbiter: account(4).address,
  maker: account(5).address,
  faucetMinter: account(6).address,
};
const deployerKey = bytesToHex(deployer.getHdKey().privateKey!);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const artifactsDir = new URL("../../contracts/artifacts/", import.meta.url);
const dependencies = {
  "@openzeppelin/contracts": "5.6.1",
  solc: "0.8.30",
  viem: "2.56.8",
};
const gitCommit = "1".repeat(40);

const artifact = async (name: string, dir = artifactsDir) =>
  JSON.parse(await readFile(new URL(name + ".json", dir), "utf8")) as {
    abi: Abi;
    abiHash: Hex;
    creationBytecodeHash: Hex;
  };
const abis = async () => ({
  BlinkMarket: (await artifact("BlinkMarket")).abi,
  BlinkTestUSD: (await artifact("BlinkTestUSD")).abi,
});

interface LocalNode {
  url: string;
  client: PublicClient;
  wallet: WalletClient;
}
// Private Anvil spawn helper; mirrors scripts/local-replay.ts.
async function withAnvil<T>(
  chainId: number,
  run: (node: LocalNode) => Promise<T>,
): Promise<T> {
  // Reserve an OS-selected loopback port; the test only ever connects to its own Anvil.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r, j) => probe.close((e) => (e ? j(e) : r())));
  const node = spawn(
    foundryBinary("anvil"),
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(chainId),
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let nodeError = "";
  node.stderr.on("data", (d) => {
    nodeError += String(d);
  });
  node.on("error", (e) => {
    nodeError = e.message;
  });
  const url = "http://127.0.0.1:" + port;
  const chain = defineChain({
    id: chainId,
    name: "Isolated local Anvil",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(url, { retryCount: 0 }),
    pollingInterval: 10,
  }) as PublicClient;
  const wallet = createWalletClient({
    account: deployer,
    chain,
    transport: http(url, { retryCount: 0 }),
  }) as WalletClient;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; ++i) {
      if (node.exitCode !== null || nodeError)
        throw new Error(nodeError || "Anvil exited");
      try {
        ready = (await client.getChainId()) === chainId;
      } catch {
        await delay(50);
      }
    }
    if (!ready) throw new Error("Local Anvil startup timeout");
    return await run({ url, client, wallet });
  } finally {
    if (node.pid && node.exitCode === null) {
      const exited = new Promise<void>((r) => node.once("exit", () => r()));
      node.kill("SIGTERM");
      const timer = setTimeout(() => node.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
  }
}

const sentNothing = async (client: PublicClient, blockBefore: bigint) => {
  assert.equal(
    await client.getTransactionCount({ address: deployer.address }),
    0,
  );
  assert.equal(await client.getBlockNumber(), blockBefore);
};
const request = (node: LocalNode, overrides: object = {}) => ({
  client: node.client,
  wallet: node.wallet,
  roles,
  deploymentId: "anvil-test",
  artifactsDir,
  gitCommit,
  dependencies,
  ...overrides,
});
const planRequest = (node: LocalNode, overrides: object = {}) => ({
  client: node.client,
  roles,
  deploymentId: "anvil-test",
  artifactsDir,
  deployer: deployer.address,
  ...overrides,
});

test("deploys on chain 84532, verifies the manifest, and does nothing else", async () => {
  await withAnvil(84532, async (node) => {
    const manifest = await deployContracts(request(node));
    DeploymentManifest.parse(manifest);
    assert.equal(manifest.tradingEnabled, false);
    assert.deepEqual(manifest.roles, roles);
    assert.equal(manifest.deploymentBlock, "1");
    assert.equal(manifest.artifacts.gitCommit, gitCommit);
    assert.deepEqual(manifest.artifacts.dependencies, dependencies);
    const independent = await verifyDeploymentOnChain(
      manifest,
      "anvil-test",
      node.client,
      await abis(),
    );
    assert.equal(independent.manifest.deploymentId, "anvil-test");
    for (const address of Object.values(manifest.contracts))
      assert.notEqual(
        await node.client.getCode({ address: address as Address }),
        undefined,
      );
    // Only the two deployments: no allowlisting, maker deposit or market creation.
    assert.equal(
      await node.client.getTransactionCount({ address: deployer.address }),
      2,
    );
    const read = (functionName: string) =>
      abis().then(({ BlinkMarket }) =>
        node.client.readContract({
          address: manifest.contracts.BlinkMarket as Address,
          abi: BlinkMarket,
          functionName,
        }),
      );
    assert.equal(await read("nextMarketId"), 1n);
    assert.equal(await read("makerFreeBalance"), 0n);
  });
});

test("a dry run sends nothing and predicts the constructor arguments", async () => {
  await withAnvil(84532, async (node) => {
    const blockBefore = await node.client.getBlockNumber();
    const plan = await planDeployment(planRequest(node));
    await sentNothing(node.client, blockBefore);
    const [token, market] = await Promise.all([
      artifact("BlinkTestUSD"),
      artifact("BlinkMarket"),
    ]);
    const predictedToken = getContractAddress({
      from: deployer.address,
      nonce: 0n,
    });
    assert.equal(plan.chainId, 84532);
    assert.equal(plan.deployer, deployer.address);
    assert.equal(
      plan.deployerBalanceWei,
      await node.client.getBalance({ address: deployer.address }),
    );
    assert.ok(plan.deployerBalanceWei > 0n);
    assert.deepEqual(plan.constructorArgs, {
      BlinkTestUSD: [roles.faucetMinter],
      BlinkMarket: [
        predictedToken,
        roles.maker,
        roles.admin,
        roles.resultProposer,
        roles.challenger,
        roles.arbiter,
      ],
    });
    assert.deepEqual(plan.abiHashes, {
      BlinkTestUSD: token.abiHash,
      BlinkMarket: market.abiHash,
    });
    assert.deepEqual(plan.bytecodeHashes, {
      BlinkTestUSD: token.creationBytecodeHash,
      BlinkMarket: market.creationBytecodeHash,
    });
    // The prediction holds: the real deployment lands at the planned token address.
    const manifest = await deployContracts(request(node));
    assert.equal(manifest.contracts.BlinkTestUSD, predictedToken);
    assert.deepEqual(manifest.artifacts.abiHashes, plan.abiHashes);
  });
});

for (const [chainId, code] of [
  [8453, "MAINNET_REFUSED"],
  [31337, "WRONG_CHAIN"],
] as const)
  test(`chain ${chainId} is refused as ${code} before any transaction`, async () => {
    await withAnvil(chainId, async (node) => {
      const blockBefore = await node.client.getBlockNumber();
      await assert.rejects(planDeployment(planRequest(node)), new RegExp(code));
      await assert.rejects(deployContracts(request(node)), new RegExp(code));
      await sentNothing(node.client, blockBefore);
    });
  });

const roleCases: [
  string,
  Partial<Record<keyof RoleAddresses, string>>,
  RegExp,
][] = [
  ["duplicate roles", { arbiter: roles.admin }, /ROLES_NOT_DISTINCT/],
  [
    "duplicate roles differing only in case",
    { arbiter: roles.admin.toLowerCase() },
    /ROLES_NOT_DISTINCT/,
  ],
  ["a zero-address role", { challenger: zeroAddress }, /INVALID_ROLES/],
  ["a malformed role", { challenger: "0x1234" }, /INVALID_ROLES/],
  ["the deployer as admin", { admin: deployer.address }, /DEPLOYER_HOLDS_ROLE/],
  [
    "the deployer as maker, in lowercase",
    { maker: deployer.address.toLowerCase() },
    /DEPLOYER_HOLDS_ROLE/,
  ],
];
for (const [name, overrides, pattern] of roleCases)
  test(`${name} is rejected before any transaction`, async () => {
    await withAnvil(84532, async (node) => {
      const blockBefore = await node.client.getBlockNumber();
      const bad = { roles: { ...roles, ...overrides } };
      await assert.rejects(planDeployment(planRequest(node, bad)), pattern);
      await assert.rejects(deployContracts(request(node, bad)), pattern);
      await sentNothing(node.client, blockBefore);
    });
  });

for (const [name, overrides, pattern] of [
  [
    "an invalid deployment id",
    { deploymentId: "not a valid id!" },
    /INVALID_DEPLOYMENT_ID/,
  ],
  ["a short git commit", { gitCommit: "abc" }, /INVALID_DEPLOYMENT_INPUT/],
  ["empty dependencies", { dependencies: {} }, /INVALID_DEPLOYMENT_INPUT/],
] as const)
  test(`${name} is rejected before any transaction`, async () => {
    await withAnvil(84532, async (node) => {
      const blockBefore = await node.client.getBlockNumber();
      await assert.rejects(deployContracts(request(node, overrides)), pattern);
      await sentNothing(node.client, blockBefore);
    });
  });

test("an artifact whose hashes do not match is rejected before any transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-artifacts-"));
  try {
    await cp(fileURLToPath(artifactsDir), dir, { recursive: true });
    const path = join(dir, "BlinkMarket.json");
    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.bytecode = tampered.bytecode + "00";
    await writeFile(path, JSON.stringify(tampered));
    await withAnvil(84532, async (node) => {
      const blockBefore = await node.client.getBlockNumber();
      await assert.rejects(
        deployContracts(
          request(node, { artifactsDir: new URL("file://" + dir + "/") }),
        ),
        /ARTIFACT_MISMATCH: BlinkMarket/,
      );
      await sentNothing(node.client, blockBefore);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed on-chain verification returns no manifest and names the deployed contracts", async () => {
  await withAnvil(84532, async (node) => {
    // The chain "reorgs" the head block between the verifier's two reads.
    const lying = {
      ...node.client,
      getBlock: async (args?: { blockNumber?: bigint }) => ({
        ...(await node.client.getBlock(args as never)),
        ...(args?.blockNumber === undefined
          ? {}
          : { hash: "0x" + "22".repeat(32) }),
      }),
    } as unknown as PublicClient;
    await assert.rejects(
      deployContracts(request(node, { client: lying })),
      /DEPLOYMENT_VERIFICATION_FAILED: REORG_DURING_DEPLOYMENT_CHECK.*BlinkTestUSD 0x[0-9a-fA-F]{40}.*BlinkMarket 0x[0-9a-fA-F]{40}/,
    );
  });
});

test("a failure after the first deployment names the contract already on chain", async () => {
  await withAnvil(84532, async (node) => {
    // BlinkMarket rejects a maker that has code, so its deployment fails after the token's.
    await node.client.request({
      method: "anvil_setCode" as never,
      params: [roles.maker, "0x00"] as never,
    });
    const predictedToken = getContractAddress({
      from: deployer.address,
      nonce: 0n,
    });
    await assert.rejects(
      deployContracts(request(node)),
      new RegExp("already deployed: BlinkTestUSD " + predictedToken),
    );
    assert.equal(
      await node.client.getTransactionCount({ address: deployer.address }),
      1,
    );
    assert.notEqual(
      await node.client.getCode({ address: predictedToken }),
      undefined,
    );
  });
});

test("readReleaseCommit returns HEAD and refuses a dirty tree unless allowed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-git-"));
  try {
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd: dir, encoding: "utf8" },
      ).trim();
    git("init", "--quiet");
    await writeFile(join(dir, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "--quiet", "-m", "first");
    const head = git("rev-parse", "HEAD");
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(readReleaseCommit(dir, false), head);
    await writeFile(join(dir, "untracked.txt"), "two\n");
    assert.throws(() => readReleaseCommit(dir, false), /DIRTY_TREE/);
    assert.equal(readReleaseCommit(dir, true), head);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// CLI level: scripts/deploy-contracts.ts against the test's own Anvil.
const cli = (env: Record<string, string | undefined>, args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("../../scripts/deploy-contracts.ts", import.meta.url),
      ),
      "--deployment-id",
      "anvil-cli",
      "--admin",
      roles.admin,
      "--result-proposer",
      roles.resultProposer,
      "--challenger",
      roles.challenger,
      "--arbiter",
      roles.arbiter,
      "--maker",
      roles.maker,
      "--faucet-minter",
      roles.faucetMinter,
      "--allow-dirty",
      ...args,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        DEPLOY_RPC_URL: undefined,
        DEPLOYER_PRIVATE_KEY: undefined,
        ...env,
      },
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  return { ...result, output: result.stdout + result.stderr };
};
const outPath = async () =>
  join(await mkdtemp(join(tmpdir(), "blink-manifest-")), "manifest.json");

test("CLI dry run prints the plan, never reads the key and writes nothing", async () => {
  await withAnvil(84532, async (node) => {
    const out = await outPath();
    try {
      const result = cli(
        { DEPLOY_RPC_URL: node.url, DEPLOYER_PRIVATE_KEY: "not-a-key" },
        ["--deployer", deployer.address, "--out", out],
      );
      assert.equal(result.status, 0, result.output);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.mode, "DRY_RUN");
      assert.equal(plan.chainId, 84532);
      assert.equal(plan.deployer, deployer.address);
      assert.match(plan.gitCommit, /^[0-9a-f]{40}$/);
      assert.equal(typeof plan.deployerBalanceWei, "string");
      assert.equal(plan.constructorArgs.BlinkTestUSD[0], roles.faucetMinter);
      assert.ok(!result.output.includes("not-a-key"));
      assert.ok(!existsSync(out));
      await sentNothing(node.client, 0n);
    } finally {
      await rm(dirname(out), { recursive: true, force: true });
    }
  });
});

test("CLI broadcast writes a verified manifest once and never prints the key", async () => {
  await withAnvil(84532, async (node) => {
    const out = await outPath();
    try {
      const env = {
        DEPLOY_RPC_URL: node.url,
        DEPLOYER_PRIVATE_KEY: deployerKey,
      };
      const result = cli(env, ["--broadcast", "--out", out]);
      assert.equal(result.status, 0, result.output);
      assert.ok(!result.output.includes(deployerKey.slice(2)));
      const manifest = DeploymentManifest.parse(
        JSON.parse(await readFile(out, "utf8")),
      );
      await verifyDeploymentOnChain(
        manifest,
        "anvil-cli",
        node.client,
        await abis(),
      );
      assert.equal(manifest.tradingEnabled, false);
      assert.equal(
        manifest.artifacts.gitCommit,
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf8",
        }).trim(),
      );
      const pkg = JSON.parse(await readFile(repoRoot + "package.json", "utf8"));
      assert.deepEqual(manifest.artifacts.dependencies, {
        "@openzeppelin/contracts":
          pkg.devDependencies["@openzeppelin/contracts"],
        solc: pkg.devDependencies.solc,
        viem: pkg.devDependencies.viem,
      });
      const before = await readFile(out, "utf8");
      const again = cli(env, ["--broadcast", "--out", out]);
      assert.notEqual(again.status, 0);
      assert.match(again.stderr, /OUTPUT_EXISTS/);
      assert.equal(await readFile(out, "utf8"), before);
      assert.equal(
        await node.client.getTransactionCount({ address: deployer.address }),
        2,
      );
    } finally {
      await rm(dirname(out), { recursive: true, force: true });
    }
  });
});

test("CLI refuses an existing output file before reading the key or sending", async () => {
  await withAnvil(84532, async (node) => {
    const out = await outPath();
    try {
      await writeFile(out, "keep me\n");
      const result = cli(
        { DEPLOY_RPC_URL: node.url, DEPLOYER_PRIVATE_KEY: deployerKey },
        ["--broadcast", "--out", out],
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /OUTPUT_EXISTS/);
      assert.ok(!result.output.includes(deployerKey.slice(2)));
      assert.equal(await readFile(out, "utf8"), "keep me\n");
      await sentNothing(node.client, 0n);
    } finally {
      await rm(dirname(out), { recursive: true, force: true });
    }
  });
});

test("CLI checks the chain before it reads the key", async () => {
  await withAnvil(8453, async (node) => {
    const out = await outPath();
    try {
      // The key is malformed on purpose: the chain error must win.
      const result = cli(
        { DEPLOY_RPC_URL: node.url, DEPLOYER_PRIVATE_KEY: "0x00" },
        ["--broadcast", "--out", out],
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /MAINNET_REFUSED/);
      assert.ok(!existsSync(out));
      await sentNothing(node.client, 0n);
    } finally {
      await rm(dirname(out), { recursive: true, force: true });
    }
  });
});

test("CLI rejects a --deployer that does not match the key", async () => {
  await withAnvil(84532, async (node) => {
    const out = await outPath();
    try {
      const result = cli(
        { DEPLOY_RPC_URL: node.url, DEPLOYER_PRIVATE_KEY: deployerKey },
        ["--broadcast", "--deployer", roles.maker, "--out", out],
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /DEPLOYER_MISMATCH/);
      await sentNothing(node.client, 0n);
    } finally {
      await rm(dirname(out), { recursive: true, force: true });
    }
  });
});
