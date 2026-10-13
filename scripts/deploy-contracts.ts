import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertDeployChain,
  deployContracts,
  planDeployment,
  readReleaseCommit,
  type RoleAddresses,
} from "../packages/adapters/src/contract-deployer.js";

// Dry run by default. Only --broadcast reads DEPLOYER_PRIVATE_KEY and sends transactions.
const usage =
  "Usage: DEPLOY_RPC_URL=<url> pnpm contracts:deploy --deployment-id <id> --admin <addr> --result-proposer <addr> --challenger <addr> --arbiter <addr> --maker <addr> --faucet-minter <addr> [--deployer <addr>] [--out <file>] [--allow-dirty] [--broadcast]";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const artifactsDir = new URL("../contracts/artifacts/", import.meta.url);
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

try {
  const { values } = parseArgs({
    options: {
      broadcast: { type: "boolean" },
      "allow-dirty": { type: "boolean" },
      out: { type: "string" },
      deployer: { type: "string" },
      "deployment-id": { type: "string" },
      admin: { type: "string" },
      "result-proposer": { type: "string" },
      challenger: { type: "string" },
      arbiter: { type: "string" },
      maker: { type: "string" },
      "faucet-minter": { type: "string" },
    },
  });
  const rpc = process.env["DEPLOY_RPC_URL"];
  const deploymentId = values["deployment-id"];
  const roles = {
    admin: values.admin,
    resultProposer: values["result-proposer"],
    challenger: values.challenger,
    arbiter: values.arbiter,
    maker: values.maker,
    faucetMinter: values["faucet-minter"],
  };
  if (!rpc || !deploymentId || Object.values(roles).some((v) => !v))
    throw new Error("DEPLOY_CONFIGURATION_REQUIRED\n" + usage);
  if (values.broadcast && !values.out) throw new Error("OUTPUT_REQUIRED");
  if (values.out) {
    if (await exists(values.out)) throw new Error("OUTPUT_EXISTS");
    if (
      !(await stat(dirname(values.out)).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      throw new Error("OUTPUT_DIRECTORY_MISSING");
  }
  const client = createPublicClient({
    transport: http(rpc, { timeout: 10_000, retryCount: 1 }),
  });
  // Chain first: nothing below reads a key against the wrong network.
  await assertDeployChain(client);
  const gitCommit = readReleaseCommit(repoRoot, values["allow-dirty"] === true);
  if (!values.broadcast) {
    if (!values.deployer)
      throw new Error("DEPLOYER_REQUIRED: dry run needs --deployer <addr>");
    const plan = await planDeployment({
      client,
      roles: roles as RoleAddresses,
      deploymentId,
      artifactsDir,
      deployer: values.deployer as Address,
    });
    console.log(json({ mode: "DRY_RUN", deploymentId, gitCommit, ...plan }));
  } else {
    const key = process.env["DEPLOYER_PRIVATE_KEY"];
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
      throw new Error(
        "DEPLOYER_KEY_INVALID: DEPLOYER_PRIVATE_KEY must be 0x + 64 hex",
      );
    const account = privateKeyToAccount(key as `0x${string}`);
    if (
      values.deployer &&
      values.deployer.toLowerCase() !== account.address.toLowerCase()
    )
      throw new Error("DEPLOYER_MISMATCH");
    const devDependencies = JSON.parse(
      await readFile(repoRoot + "package.json", "utf8"),
    ).devDependencies as Record<string, string>;
    const dependencies = Object.fromEntries(
      ["@openzeppelin/contracts", "solc", "viem"].map((name) => {
        const version = devDependencies[name];
        if (!version) throw new Error("DEPENDENCY_VERSION_MISSING: " + name);
        return [name, version];
      }),
    );
    const manifest = await deployContracts({
      client,
      wallet: createWalletClient({
        account,
        transport: http(rpc, { timeout: 10_000, retryCount: 1 }),
      }),
      roles: roles as RoleAddresses,
      deploymentId,
      artifactsDir,
      gitCommit,
      dependencies,
    });
    await writeFile(values.out!, json(manifest) + "\n", { flag: "wx" });
    console.log(
      json({
        mode: "BROADCAST",
        deploymentId,
        out: values.out,
        contracts: manifest.contracts,
        deploymentBlock: manifest.deploymentBlock,
        status: "verified; does not enable trading",
      }),
    );
  }
} catch (error) {
  // Only our own codes and viem's short messages: viem's long messages can embed the RPC URL.
  console.error(
    error instanceof Error
      ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
      : "DEPLOY_FAILED",
  );
  process.exitCode = 1;
}
