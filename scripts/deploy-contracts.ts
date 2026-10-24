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
  presets,
  parseProtocolDeployment,
  type ProtocolDeployment,
} from "../packages/schemas/src/index.js";
import {
  assertProtocolDeployChain,
  deployProtocol,
  planProtocolDeployment,
  readReleaseCommit,
} from "../packages/adapters/src/protocol-deployer.js";
import { verifyProtocolDeployment } from "../packages/adapters/src/deployment-verifier.js";

// Dry run by default. Only --broadcast reads DEPLOYER_PRIVATE_KEY and sends transactions, and
// only on Anvil (31337) or Base Sepolia (84532): assertProtocolDeployChain refuses every other chain.
const usage =
  "Usage: DEPLOY_RPC_URL=<url> pnpm contracts:deploy -- --params alpha|base-sepolia --treasury <addr> --deployment-id <id> [--shared-from <manifest>] [--previous-registry <addr>] [--deployer <addr>] [--out <file>] [--allow-dirty] [--broadcast]";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const paramsByName = {
  alpha: presets.alpha,
  "base-sepolia": presets.baseSepolia,
} as const;
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
// Fixed message on any failure: the library's own errors can echo the key's value.
function deployerAccount(key: string | undefined) {
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) {
    try {
      return privateKeyToAccount(key as `0x${string}`);
    } catch {
      // Out of the curve's range: fall through to the fixed error below.
    }
  }
  throw new Error(
    "DEPLOYER_KEY_INVALID: DEPLOYER_PRIVATE_KEY must be 0x + 64 hex and a valid secp256k1 key",
  );
}
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

try {
  const { values } = parseArgs({
    // `pnpm contracts:deploy -- --flag` may forward the bare separator.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      broadcast: { type: "boolean" },
      "allow-dirty": { type: "boolean" },
      out: { type: "string" },
      deployer: { type: "string" },
      params: { type: "string" },
      treasury: { type: "string" },
      "deployment-id": { type: "string" },
      "shared-from": { type: "string" },
      "previous-registry": { type: "string" },
    },
  });
  const rpc = process.env["DEPLOY_RPC_URL"];
  const deploymentId = values["deployment-id"];
  const paramsName = values.params as keyof typeof paramsByName | undefined;
  if (!rpc || !deploymentId || !values.treasury || !paramsName)
    throw new Error("DEPLOY_CONFIGURATION_REQUIRED\n" + usage);
  if (!Object.hasOwn(paramsByName, paramsName))
    throw new Error("UNKNOWN_PARAMS: use alpha or base-sepolia");
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
  let sharedFrom: ProtocolDeployment | undefined;
  if (values["shared-from"]) {
    const parsed = parseProtocolDeployment(
      JSON.parse(await readFile(values["shared-from"], "utf8")),
    );
    if (!parsed.ok)
      throw new Error("SHARED_MANIFEST_INVALID: " + parsed.reason);
    sharedFrom = parsed.manifest;
  }
  const client = createPublicClient({
    transport: http(rpc, { timeout: 10_000, retryCount: 1 }),
  });
  // Chain first: nothing below reads a key against the wrong network.
  await assertProtocolDeployChain(client);
  const releaseCommit = readReleaseCommit(
    repoRoot,
    values["allow-dirty"] === true,
  );
  const account = values.broadcast
    ? deployerAccount(process.env["DEPLOYER_PRIVATE_KEY"])
    : undefined;
  if (
    account &&
    values.deployer &&
    values.deployer.toLowerCase() !== account.address.toLowerCase()
  )
    throw new Error("DEPLOYER_MISMATCH");
  const deployer = (account?.address ?? values.deployer) as Address | undefined;
  if (!deployer)
    throw new Error("DEPLOYER_REQUIRED: dry run needs --deployer <addr>");
  const plan = planProtocolDeployment({
    deployer,
    nonce: await client.getTransactionCount({
      address: deployer,
      blockTag: "pending",
    }),
    params: paramsByName[paramsName],
    treasury: values.treasury as Address,
    ...(values["previous-registry"]
      ? { previousRegistry: values["previous-registry"] as Address }
      : {}),
    ...(sharedFrom ? { shared: sharedFrom.shared } : {}),
  });
  if (!account) {
    console.log(json({ mode: "DRY_RUN", deploymentId, releaseCommit, plan }));
  } else {
    const manifest = await deployProtocol(
      createWalletClient({
        account,
        // No retry: a repeated send could mask a transaction that was already accepted.
        transport: http(rpc, { timeout: 10_000, retryCount: 0 }),
      }),
      client,
      plan,
      { deploymentId, releaseCommit, ...(sharedFrom ? { sharedFrom } : {}) },
    );
    if (values.out) {
      try {
        await writeFile(values.out, json(manifest) + "\n", { flag: "wx" });
      } catch {
        // The contracts are on chain: never lose their addresses.
        console.log(json(manifest));
        throw new Error(
          "MANIFEST_WRITE_FAILED: the manifest is printed on stdout; save it before doing anything else",
        );
      }
    } else console.log(json(manifest));
    // Only now: the manifest is saved, so a verification error cannot lose the deployed addresses.
    let report;
    try {
      report = await verifyProtocolDeployment(client, manifest);
    } catch (error) {
      throw new Error(
        "DEPLOYMENT_VERIFICATION_ERROR: " +
          (error instanceof Error
            ? ((error as { shortMessage?: string }).shortMessage ??
              error.message)
            : "unknown error") +
          " (the deployment is on chain and the manifest is saved; verify it with pnpm manifest:verify)",
      );
    }
    if (!report.ok)
      throw new Error(
        "DEPLOYMENT_VERIFICATION_FAILED: " +
          report.checks
            .filter((c) => !c.ok)
            .map((c) => c.name + (c.detail ? " (" + c.detail + ")" : ""))
            .join("; "),
      );
    console.log(
      json({
        mode: "BROADCAST",
        deploymentId,
        out: values.out ?? null,
        generation: manifest.generation,
        shared: manifest.shared,
        status: "verified",
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
