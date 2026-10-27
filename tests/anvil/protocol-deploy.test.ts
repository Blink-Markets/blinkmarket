import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { protocolAbi } from "../../packages/adapters/src/protocol-abi.js";
import {
  deployProtocol,
  fromChain,
  paramsTuple,
  planProtocolDeployment,
  ProtocolDeployError,
  type DeploymentPlan,
} from "../../packages/adapters/src/protocol-deployer.js";
import { verifyProtocolDeployment } from "../../packages/adapters/src/deployment-verifier.js";
import {
  loadProtocolDeployment,
  registerProtocolDeployment,
} from "../../packages/adapters/src/deployment-registry.js";
import {
  presets,
  ProtocolDeployment,
} from "../../packages/schemas/src/index.js";
import { startAnvil, type Anvil } from "../helpers/anvil.js";
import { createTestDatabase } from "../helpers/database.js";

// Every chain here is a fresh local Anvil started at chain id 84532 and funded with Anvil's public
// development accounts. Nothing in this file can reach a public network.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const releaseCommit = "1".repeat(40);
let anvil: Anvil;
let client: PublicClient;
let treasury: Address;
let deployerAddress: Address;

before(async () => {
  anvil = await startAnvil({ chainId: 84532 });
  client = anvil.publicClient as PublicClient;
  treasury = anvil.accounts.maker.address;
  deployerAddress = anvil.accounts.admin.address;
});
after(async () => {
  await anvil.stop();
});

const wallet = () => anvil.wallet(anvil.accounts.admin);
const nonceOf = (address: Address) =>
  client.getTransactionCount({ address, blockTag: "pending" });
const planAt = async (
  extra: Partial<Parameters<typeof planProtocolDeployment>[0]> = {},
) =>
  planProtocolDeployment({
    deployer: deployerAddress,
    nonce: await nonceOf(deployerAddress),
    params: presets.alpha,
    treasury,
    ...extra,
  });
const meta = (deploymentId: string, sharedFrom?: ProtocolDeployment) => ({
  deploymentId,
  releaseCommit,
  ...(sharedFrom ? { sharedFrom } : {}),
});
const failedChecks = (report: { checks: { name: string; ok: boolean }[] }) =>
  report.checks.filter((c) => !c.ok).map((c) => c.name);

// CLI level: scripts/deploy-contracts.ts against a test Anvil.
const cliInvocation = (
  env: Record<string, string | undefined>,
  args: string[],
) =>
  [
    process.execPath,
    [
      "--import",
      "tsx",
      join(repoRoot, "scripts/deploy-contracts.ts"),
      "--params",
      "alpha",
      "--treasury",
      treasury,
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
    },
  ] as const;
const cli = (env: Record<string, string | undefined>, args: string[]) => {
  const [command, argv, options] = cliInvocation(env, args);
  const result = spawnSync(command, argv, { ...options, timeout: 120_000 });
  return { ...result, output: result.stdout + result.stderr };
};
// For tests that serve the RPC from this process: spawnSync would block the server.
const cliAsync = (env: Record<string, string | undefined>, args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const [command, argv, options] = cliInvocation(env, args);
      const child = spawn(command, argv, options);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
const deployerKey = () =>
  bytesToHex(anvil.accounts.admin.getHdKey().privateKey!);

test("dry run plans without a key", async () => {
  const head = await client.getBlockNumber();
  const result = cli(
    // A key in the environment is never read without --broadcast.
    { DEPLOY_RPC_URL: anvil.url, DEPLOYER_PRIVATE_KEY: deployerKey() },
    ["--deployment-id", "dry", "--deployer", deployerAddress],
  );
  assert.equal(result.status, 0, result.output);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.mode, "DRY_RUN");
  assert.deepEqual(printed.plan, JSON.parse(JSON.stringify(await planAt())));
  assert.equal(printed.plan.transactions.length, 8);
  assert.ok(!result.output.includes(deployerKey().slice(2)));
  assert.equal(await nonceOf(deployerAddress), 0);
  assert.equal(await client.getBlockNumber(), head);

  const noDeployer = cli({ DEPLOY_RPC_URL: anvil.url }, [
    "--deployment-id",
    "dry",
  ]);
  assert.notEqual(noDeployer.status, 0);
  assert.match(noDeployer.stderr, /DEPLOYER_REQUIRED/);
});

test("nonce drift aborts before the first transaction", async () => {
  const snapshot = await anvil.snapshot();
  try {
    const plan = await planAt();
    // Any transaction between plan and deploy moves every predicted address.
    await wallet().sendTransaction({ to: treasury, value: 1n });
    const sent = await nonceOf(deployerAddress);
    await assert.rejects(
      deployProtocol(wallet(), client, plan, meta("drift")),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDeployError);
        assert.match(error.message, /NONCE_DRIFT/);
        assert.deepEqual(error.deployed, {});
        return true;
      },
    );
    assert.equal(await nonceOf(deployerAddress), sent);
  } finally {
    await anvil.revert(snapshot);
  }
});

test("nonce drift after the shared contracts aborts before the first generation transaction and names them", async () => {
  const snapshot = await anvil.snapshot();
  try {
    const plan = await planAt();
    const real = wallet();
    let deploys = 0;
    const drifting = {
      ...real,
      async deployContract(args: Parameters<typeof real.deployContract>[0]) {
        const hash = await real.deployContract(args);
        // After the anchor (the fourth shared transaction) something else spends a nonce.
        if (++deploys === 4)
          await real.sendTransaction({ to: treasury, value: 1n });
        return hash;
      },
    } as typeof real;
    let caught: ProtocolDeployError | undefined;
    await assert.rejects(
      deployProtocol(drifting, client, plan, meta("drift-mid")),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDeployError);
        assert.match(error.message, /NONCE_DRIFT/);
        assert.match(error.message, /already deployed/);
        caught = error;
        assert.deepEqual(Object.keys(error.deployed).sort(), [
          "BlinkAnchor",
          "BlinkFaucet",
          "BlinkGovernor",
          "BlinkTestUSD",
          "BlinkToken",
          "FixedPriceSource",
        ]);
        return true;
      },
    );
    for (const [name, address] of Object.entries(caught!.deployed))
      assert.ok(await client.getCode({ address }), name + " has code");
    // Four shared contracts and the drifting transaction: no generation transaction was sent.
    assert.equal(await nonceOf(deployerAddress), 5);
  } finally {
    await anvil.revert(snapshot);
  }
});

let generation1: ProtocolDeployment;
let generation1Plan: DeploymentPlan;

test("deploys shared contracts and generation 1 with alpha params", async () => {
  generation1Plan = await planAt();
  generation1 = await deployProtocol(
    wallet(),
    client,
    generation1Plan,
    meta("gen-1"),
  );

  assert.deepEqual(ProtocolDeployment.parse(generation1), generation1);
  assert.equal(generation1.generation.index, 1);
  assert.equal(generation1.generation.previousRegistry, null);
  assert.equal(generation1.treasury, treasury);
  assert.equal(generation1.deployer, deployerAddress);
  // The plan's predictions are what was deployed.
  assert.equal(
    generation1.generation.registry,
    generation1Plan.generation.registry,
  );
  assert.deepEqual(generation1.shared, generation1Plan.shared);
  for (const tx of generation1Plan.transactions) {
    const record = generation1.contracts[tx.name]!;
    assert.equal(record.address, tx.address);
    assert.ok(
      (
        await client.getTransactionReceipt({
          hash: record.deployTx as `0x${string}`,
        })
      ).status === "success",
    );
  }
  assert.equal(await nonceOf(deployerAddress), 8);

  const report = await verifyProtocolDeployment(client, generation1);
  assert.deepEqual(failedChecks(report), []);
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((c) => c.name === "registry.params"));

  // registry.params() equals the preset in every field.
  const onChain = await client.readContract({
    address: generation1.generation.registry as Address,
    abi: protocolAbi.registry as Abi,
    functionName: "params",
  });
  assert.deepEqual(fromChain(paramsTuple, onChain), presets.alpha);
  assert.equal(
    Object.keys(presets.alpha).length,
    paramsTuple.components?.length,
  );
});

test("verification rejects replay bounds after deployment or above the head", async () => {
  const tooLate = await verifyProtocolDeployment(client, {
    ...generation1,
    startBlock: generation1.contracts.BlinkFaucet!.block + 1,
  });
  assert.equal(tooLate.ok, false);
  assert.match(
    tooLate.checks.find((check) => check.name === "startBlock")?.detail ?? "",
    /DEPLOYMENT_BLOCK_TOO_LATE: BlinkFaucet/,
  );

  const future = await verifyProtocolDeployment(client, {
    ...generation1,
    startBlock: Number((await client.getBlock()).number + 1n),
  });
  assert.equal(future.ok, false);
  assert.match(
    future.checks.find((check) => check.name === "startBlock")?.detail ?? "",
    /DEPLOYMENT_BLOCK_IN_FUTURE/,
  );
});

test("verification reports every kind of mismatch", async () => {
  const flip = (hash: string) =>
    (hash.slice(0, -1) + (hash.endsWith("0") ? "1" : "0")) as `0x${string}`;
  const sameShape = (change: (m: ProtocolDeployment) => ProtocolDeployment) =>
    verifyProtocolDeployment(client, change(structuredClone(generation1)));
  const cases: [
    string,
    (m: ProtocolDeployment) => ProtocolDeployment,
    string,
  ][] = [
    [
      "a changed param",
      (m) => ({ ...m, params: { ...m.params, feeBps: m.params.feeBps + 1 } }),
      "registry.params",
    ],
    [
      "a changed array param",
      (m) => ({ ...m, params: { ...m.params, quorumBps: [1, 1, 1, 1] } }),
      "registry.params",
    ],
    [
      "a changed uint256 param",
      (m) => ({ ...m, params: { ...m.params, registrationFee: "1" } }),
      "registry.params",
    ],
    [
      "a wrong treasury",
      (m) => ({ ...m, treasury: m.deployer }),
      "registry.addresses",
    ],
    [
      "a wrong runtime hash",
      (m) => ({
        ...m,
        contracts: {
          ...m.contracts,
          BlinkJurors: {
            ...m.contracts.BlinkJurors!,
            runtimeHash: flip(m.contracts.BlinkJurors!.runtimeHash),
          },
        },
      }),
      "code:BlinkJurors",
    ],
    [
      "a wrong ABI hash",
      (m) => ({
        ...m,
        contracts: {
          ...m.contracts,
          BlinkAnchor: {
            ...m.contracts.BlinkAnchor!,
            abiHash: flip(m.contracts.BlinkAnchor!.abiHash),
          },
        },
      }),
      "code:BlinkAnchor",
    ],
    [
      "a swapped markets and resolution",
      (m) => ({
        ...m,
        generation: {
          ...m.generation,
          markets: m.generation.resolution,
          resolution: m.generation.markets,
        },
      }),
      "registry.addresses",
    ],
    [
      "a wrong governor token",
      (m) => ({ ...m, shared: { ...m.shared, token: m.shared.busd } }),
      "governor",
    ],
    [
      "a wrong token price",
      (m) => ({ ...m, tokenPriceMicros: 2 }),
      "priceSource",
    ],
    [
      "a wrong generation index",
      (m) => ({ ...m, generation: { ...m.generation, index: 2 } }),
      "generation.index",
    ],
  ];
  for (const [label, change, expected] of cases) {
    const report = await sameShape(change);
    assert.equal(report.ok, false, label);
    assert.ok(
      failedChecks(report).includes(expected),
      label + ": " + failedChecks(report).join(","),
    );
  }
  // An address with no code is a failed code check, not a thrown error.
  const missing = await sameShape((m) => ({
    ...m,
    contracts: {
      ...m.contracts,
      BlinkAnchor: { ...m.contracts.BlinkAnchor!, address: treasury },
    },
    shared: { ...m.shared, anchor: treasury },
  }));
  assert.equal(missing.ok, false);
  assert.ok(failedChecks(missing).includes("code:BlinkAnchor"));
  assert.ok(failedChecks(missing).includes("anchor"));
});

test("verification rejects one patched immutable occurrence even when the manifest hash follows", async () => {
  // Every occurrence of an immutable is a separate PUSH32 in the runtime. Patching one that is
  // not the public getter's leaves the getter, and a hash taken from the patched code, intact.
  const artifact = JSON.parse(
    await readFile(
      join(repoRoot, "contracts/artifacts/BlinkMarkets.json"),
      "utf8",
    ),
  ) as {
    immutableReferences: Record<string, { start: number; length: number }[]>;
  };
  const occurrences = artifact.immutableReferences["BlinkMarkets.registry"]!;
  assert.ok(
    occurrences.length > 1,
    "the registry immutable is used repeatedly",
  );
  const address = generation1.generation.markets as Address;
  const original = hexToBytes((await client.getCode({ address }))!);
  for (const { start, length } of occurrences) {
    const snapshot = await anvil.snapshot();
    try {
      const patched = Uint8Array.from(original);
      patched[start + length - 1] = original[start + length - 1]! ^ 1;
      await client.request({
        method: "anvil_setCode" as never,
        params: [address, bytesToHex(patched)] as never,
      });
      const manifest = structuredClone(generation1);
      manifest.contracts.BlinkMarkets!.runtimeHash = keccak256(patched);
      const report = await verifyProtocolDeployment(client, manifest);
      assert.equal(report.ok, false, "occurrence at " + start);
      assert.ok(
        failedChecks(report).includes("code:BlinkMarkets"),
        "occurrence at " + start + ": " + failedChecks(report).join(","),
      );
    } finally {
      await anvil.revert(snapshot);
    }
  }
});

let generation2: ProtocolDeployment;

test("deploys generation 2 reusing shared contracts", async () => {
  const before = await nonceOf(deployerAddress);
  const plan = await planAt({
    shared: generation1.shared,
    previousRegistry: generation1.generation.registry as Address,
  });
  assert.equal(plan.transactions.length, 4);
  generation2 = await deployProtocol(
    wallet(),
    client,
    plan,
    meta("gen-2", generation1),
  );

  assert.equal(generation2.generation.index, 2);
  assert.equal(
    generation2.generation.previousRegistry,
    generation1.generation.registry,
  );
  assert.deepEqual(generation2.shared, generation1.shared);
  assert.notEqual(
    generation2.generation.registry,
    generation1.generation.registry,
  );
  // Only the four generation contracts were sent; the shared ones are the same records.
  assert.equal(await nonceOf(deployerAddress), before + 4);
  for (const name of [
    "BlinkFaucet",
    "BlinkTestUSD",
    "BlinkToken",
    "FixedPriceSource",
    "BlinkGovernor",
    "BlinkAnchor",
  ])
    assert.deepEqual(
      generation2.contracts[name],
      generation1.contracts[name],
      name,
    );
  assert.equal(generation2.startBlock, generation1.startBlock);
  const addresses = (await client.readContract({
    address: generation2.generation.registry as Address,
    abi: protocolAbi.registry as Abi,
    functionName: "addresses",
  })) as { previousRegistry: Address; token: Address };
  assert.equal(addresses.previousRegistry, generation1.generation.registry);
  assert.equal(addresses.token, generation1.shared.token);

  const report = await verifyProtocolDeployment(client, generation2);
  assert.deepEqual(failedChecks(report), []);

  // Generation 2 cannot be planned on other shared contracts than its predecessor's.
  const other = await planAt({
    shared: { ...generation1.shared, token: generation1.shared.busd },
    previousRegistry: generation1.generation.registry as Address,
  });
  const used = await nonceOf(deployerAddress);
  await assert.rejects(
    deployProtocol(wallet(), client, other, meta("gen-bad", generation1)),
    /SHARED_MISMATCH/,
  );
  assert.equal(await nonceOf(deployerAddress), used);
});

test("reusing shared contracts does not depend on the key order of the shared manifest", async () => {
  const snapshot = await anvil.snapshot();
  try {
    const plan = await planAt({
      shared: generation1.shared,
      previousRegistry: generation1.generation.registry as Address,
    });
    const reordered = {
      ...generation1,
      shared: Object.fromEntries(Object.entries(generation1.shared).reverse()),
    } as ProtocolDeployment;
    const manifest = await deployProtocol(
      wallet(),
      client,
      plan,
      meta("gen-reordered", reordered),
    );
    assert.equal(manifest.generation.index, 2);
  } finally {
    await anvil.revert(snapshot);
  }
});

test("register and load round-trip", async () => {
  const db = await createTestDatabase();
  try {
    const report1 = await verifyProtocolDeployment(client, generation1);
    const report2 = await verifyProtocolDeployment(client, generation2);
    await db.setRole("blink_deployment_admin");
    await registerProtocolDeployment(db.pool, generation1, report1);
    await registerProtocolDeployment(db.pool, generation2, report2);
    // The same manifest again is a no-op.
    await registerProtocolDeployment(db.pool, generation1, report1);

    for (const role of [
      "blink_api",
      "blink_worker",
      "blink_indexer",
      "blink_deployment_admin",
    ]) {
      await db.setRole(role);
      assert.deepEqual(
        await loadProtocolDeployment(db.pool, "gen-1"),
        generation1,
        role,
      );
      assert.deepEqual(
        await loadProtocolDeployment(db.pool, "gen-2"),
        generation2,
        role,
      );
    }
    await assert.rejects(
      loadProtocolDeployment(db.pool, "missing"),
      /DEPLOYMENT_NOT_REGISTERED/,
    );

    // Only the deployment admin writes, and a stored row never changes.
    await db.setRole("blink_api");
    await assert.rejects(
      registerProtocolDeployment(db.pool, generation1, report1),
      /permission denied/,
    );
    await db.setRole("blink_deployment_admin");
    const changed = { ...generation1, startBlock: 0 };
    await assert.rejects(
      registerProtocolDeployment(
        db.pool,
        changed,
        await verifyProtocolDeployment(client, changed),
      ),
      /DEPLOYMENT_REGISTRY_CONFLICT/,
    );
    await assert.rejects(
      db.db.exec("UPDATE markets.protocol_deployments SET manifest='{}'"),
    );
    await assert.rejects(
      db.db.exec("DELETE FROM markets.protocol_deployments"),
    );

    // A failed or foreign report is refused.
    const bad = await verifyProtocolDeployment(client, {
      ...generation1,
      deploymentId: "gen-3",
      treasury: generation1.deployer,
    });
    assert.equal(bad.ok, false);
    await assert.rejects(
      registerProtocolDeployment(
        db.pool,
        { ...generation1, deploymentId: "gen-3" },
        bad,
      ),
      /DEPLOYMENT_NOT_VERIFIED: .*registry.addresses/,
    );
    await assert.rejects(
      registerProtocolDeployment(
        db.pool,
        { ...generation1, deploymentId: "gen-3" },
        report1,
      ),
      /REPORT_FOR_OTHER_DEPLOYMENT/,
    );
    await db.setRole("blink_api");
    await assert.rejects(
      loadProtocolDeployment(db.pool, "gen-3"),
      /DEPLOYMENT_NOT_REGISTERED/,
    );
  } finally {
    await db.close();
  }
});

test("a verification report only registers the manifest it verified", async () => {
  const db = await createTestDatabase();
  try {
    await db.setRole("blink_deployment_admin");
    const verified = { ...generation1, deploymentId: "bound" };
    const report = await verifyProtocolDeployment(client, verified);
    assert.equal(report.ok, true);
    // The same id, never stored, with different content: the report does not cover it.
    const changed = { ...verified, treasury: verified.deployer };
    await assert.rejects(
      registerProtocolDeployment(db.pool, changed, report),
      /REPORT_FOR_OTHER_MANIFEST/,
    );
    await assert.rejects(
      loadProtocolDeployment(db.pool, "bound"),
      /DEPLOYMENT_NOT_REGISTERED/,
    );
    // Key order is not content.
    const reordered = Object.fromEntries(
      Object.entries(verified).reverse(),
    ) as ProtocolDeployment;
    await registerProtocolDeployment(db.pool, reordered, report);
    assert.deepEqual(await loadProtocolDeployment(db.pool, "bound"), verified);
  } finally {
    await db.close();
  }
});

test("the table itself rejects a manifest with missing keys", async () => {
  const db = await createTestDatabase();
  try {
    await db.setRole("blink_deployment_admin");
    for (const manifest of ["{}", '{"schema":"blink.deployment/2"}'])
      await assert.rejects(
        db.db.exec(
          "INSERT INTO markets.protocol_deployments(deployment_id,manifest,verified_at) VALUES ('x','" +
            manifest +
            "',now())",
        ),
        /check constraint/i,
      );
  } finally {
    await db.close();
  }
});

test("CLI broadcast deploys generation 1 then generation 2 and writes each manifest once", async () => {
  const node = await startAnvil({ chainId: 84532 });
  const dir = await mkdtemp(join(tmpdir(), "blink-deploy-"));
  try {
    const env = {
      DEPLOY_RPC_URL: node.url,
      DEPLOYER_PRIVATE_KEY: deployerKey(),
    };
    const out1 = join(dir, "gen-1.json");
    const first = cli(env, [
      "--deployment-id",
      "cli-1",
      "--broadcast",
      "--out",
      out1,
    ]);
    assert.equal(first.status, 0, first.output);
    assert.ok(!first.output.includes(deployerKey().slice(2)));
    const manifest1 = ProtocolDeployment.parse(
      JSON.parse(await readFile(out1, "utf8")),
    );
    assert.equal(manifest1.generation.index, 1);
    assert.equal(manifest1.releaseCommit, execGitHead());
    assert.deepEqual(
      failedChecks(
        await verifyProtocolDeployment(
          node.publicClient as PublicClient,
          manifest1,
        ),
      ),
      [],
    );

    // An existing --out is refused before anything is sent.
    const before = await node.publicClient.getTransactionCount({
      address: deployerAddress,
    });
    const again = cli(env, [
      "--deployment-id",
      "cli-1",
      "--broadcast",
      "--out",
      out1,
    ]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /OUTPUT_EXISTS/);
    assert.equal(
      await node.publicClient.getTransactionCount({ address: deployerAddress }),
      before,
    );

    const out2 = join(dir, "gen-2.json");
    const second = cli(env, [
      "--deployment-id",
      "cli-2",
      "--shared-from",
      out1,
      "--previous-registry",
      manifest1.generation.registry,
      "--broadcast",
      "--out",
      out2,
    ]);
    assert.equal(second.status, 0, second.output);
    const manifest2 = ProtocolDeployment.parse(
      JSON.parse(await readFile(out2, "utf8")),
    );
    assert.equal(manifest2.generation.index, 2);
    assert.deepEqual(manifest2.shared, manifest1.shared);
    assert.equal(
      await node.publicClient.getTransactionCount({ address: deployerAddress }),
      before + 4,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await node.stop();
  }
});

test("CLI keeps the manifest when verification throws after a successful deployment", async () => {
  const node = await startAnvil({ chainId: 84532 });
  const dir = await mkdtemp(join(tmpdir(), "blink-deploy-"));
  // Forwards every call to Anvil, except that once the eighth deployment transaction is sent the
  // head block can no longer be read: the first read of verification fails.
  let sent = 0;
  const proxy = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      const call = JSON.parse(body) as {
        id: number;
        method: string;
        params?: unknown[];
      };
      if (call.method === "eth_sendRawTransaction") sent++;
      if (sent >= 8 && call.method === "eth_getBlockByNumber") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32000, message: "injected head failure" },
          }),
        );
        return;
      }
      const upstream = await fetch(node.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      response.end(await upstream.text());
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = proxy.address() as { port: number };
    const out = join(dir, "kept.json");
    const result = await cliAsync(
      {
        DEPLOY_RPC_URL: "http://127.0.0.1:" + port,
        DEPLOYER_PRIVATE_KEY: deployerKey(),
      },
      ["--deployment-id", "kept", "--broadcast", "--out", out],
    );
    assert.equal(sent, 8, result.stderr);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DEPLOYMENT_VERIFICATION_ERROR/);
    const manifest = ProtocolDeployment.parse(
      JSON.parse(await readFile(out, "utf8")),
    );
    for (const [name, record] of Object.entries(manifest.contracts))
      assert.ok(
        await node.publicClient.getCode({ address: record.address as Address }),
        name + " is on chain and in the manifest",
      );
    assert.deepEqual(
      failedChecks(
        await verifyProtocolDeployment(
          node.publicClient as PublicClient,
          manifest,
        ),
      ),
      [],
    );
  } finally {
    proxy.close();
    await rm(dir, { recursive: true, force: true });
    await node.stop();
  }
});

test("CLI checks the chain before it reads the key, and refuses other chains", async () => {
  for (const [chainId, code] of [
    [8453, /MAINNET_REFUSED/],
    [1, /WRONG_CHAIN/],
  ] as const) {
    const node = await startAnvil({ chainId });
    try {
      // The key is malformed on purpose: the chain error must win.
      const result = cli(
        { DEPLOY_RPC_URL: node.url, DEPLOYER_PRIVATE_KEY: "0x00" },
        ["--deployment-id", "refused", "--broadcast"],
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, code);
      assert.equal(
        await node.publicClient.getTransactionCount({
          address: deployerAddress,
        }),
        0,
      );
    } finally {
      await node.stop();
    }
  }
});

test("CLI reports an invalid key with a fixed message and a deployer that does not match", async () => {
  const node = await startAnvil({ chainId: 84532 });
  try {
    const bad = cli(
      { DEPLOY_RPC_URL: node.url, DEPLOYER_PRIVATE_KEY: "0xdeadbeef" },
      ["--deployment-id", "bad-key", "--broadcast"],
    );
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /DEPLOYER_KEY_INVALID/);
    assert.ok(!bad.output.includes("deadbeef"));
    const mismatch = cli(
      { DEPLOY_RPC_URL: node.url, DEPLOYER_PRIVATE_KEY: deployerKey() },
      ["--deployment-id", "mismatch", "--broadcast", "--deployer", treasury],
    );
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /DEPLOYER_MISMATCH/);
    assert.equal(
      await node.publicClient.getTransactionCount({ address: deployerAddress }),
      0,
    );
  } finally {
    await node.stop();
  }
});

function execGitHead() {
  return spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.trim();
}
