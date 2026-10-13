import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  encodeDeployData,
  getAddress,
  getContractAddress,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { DeploymentId, DeploymentManifest } from "@blink/schemas";
import { verifyDeploymentOnChain } from "./deployment-verifier.js";

export interface RoleAddresses {
  admin: Address;
  resultProposer: Address;
  challenger: Address;
  arbiter: Address;
  maker: Address;
  faucetMinter: Address;
}
type ContractName = "BlinkTestUSD" | "BlinkMarket";
type PerContract<T> = Record<ContractName, T>;
interface Artifact {
  abi: Abi;
  abiHash: Hex;
  bytecode: Hex;
  creationBytecodeHash: Hex;
  compiler: string;
}

export async function assertDeployChain(client: PublicClient) {
  const chainId = await client.getChainId();
  if (chainId === 8453) throw new Error("MAINNET_REFUSED");
  if (chainId !== 84532)
    throw new Error("WRONG_CHAIN: expected 84532, observed " + chainId);
}

// Roles follow the DeploymentManifest rules; the deployer must not hold any of them.
function checkRoles(roles: RoleAddresses, deployer: Address) {
  if (!DeploymentManifest.shape.roles.safeParse(roles).success)
    throw new Error("INVALID_ROLES: every role must be a non-zero address");
  const values = Object.values(roles).map((v) => v.toLowerCase());
  if (new Set(values).size !== values.length)
    throw new Error("ROLES_NOT_DISTINCT");
  if (values.includes(deployer.toLowerCase()))
    throw new Error("DEPLOYER_HOLDS_ROLE");
}

// Artifacts come from scripts/check-contracts.mjs; refuse any whose recorded hashes disagree.
async function loadArtifacts(dir: URL): Promise<PerContract<Artifact>> {
  const load = async (name: ContractName) => {
    const artifact = JSON.parse(
      await readFile(new URL(name + ".json", dir), "utf8"),
    ) as Artifact;
    if (
      keccak256(toBytes(JSON.stringify(artifact.abi))) !== artifact.abiHash ||
      keccak256(artifact.bytecode) !== artifact.creationBytecodeHash ||
      !artifact.compiler.startsWith("0.8.30")
    )
      throw new Error(
        "ARTIFACT_MISMATCH: " + name + " (run pnpm check:contracts)",
      );
    return artifact;
  };
  return {
    BlinkTestUSD: await load("BlinkTestUSD"),
    BlinkMarket: await load("BlinkMarket"),
  };
}

// The deployer's next two CREATE addresses, which are the token and the market.
async function nextAddresses(
  client: PublicClient,
  deployer: Address,
): Promise<PerContract<Address>> {
  const nonce = BigInt(
    await client.getTransactionCount({
      address: deployer,
      blockTag: "pending",
    }),
  );
  return {
    BlinkTestUSD: getContractAddress({ from: deployer, nonce }),
    BlinkMarket: getContractAddress({ from: deployer, nonce: nonce + 1n }),
  };
}

const constructorArgs = (roles: RoleAddresses, token: Address) =>
  ({
    BlinkTestUSD: [roles.faucetMinter],
    BlinkMarket: [
      token,
      roles.maker,
      roles.admin,
      roles.resultProposer,
      roles.challenger,
      roles.arbiter,
    ],
  }) as {
    BlinkTestUSD: [Address];
    BlinkMarket: [Address, Address, Address, Address, Address, Address];
  };

function checkDeploymentId(deploymentId: string) {
  if (!DeploymentId.safeParse(deploymentId).success)
    throw new Error("INVALID_DEPLOYMENT_ID");
}

const reason = (error: unknown) =>
  error instanceof Error
    ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
    : "unknown error";

// Inputs that would only fail once the token is on chain: arguments the ABI encoder rejects
// (such as a bad-checksum address) and a maker the BlinkMarket constructor refuses.
async function checkDeployable(
  client: PublicClient,
  artifacts: PerContract<Artifact>,
  roles: RoleAddresses,
  token: Address,
) {
  const args = constructorArgs(roles, token);
  try {
    for (const name of ["BlinkTestUSD", "BlinkMarket"] as const)
      encodeDeployData({
        abi: artifacts[name].abi,
        bytecode: artifacts[name].bytecode,
        args: args[name],
      });
  } catch (error) {
    throw new Error("INVALID_CONSTRUCTOR_ARGS: " + reason(error));
  }
  if (await client.getCode({ address: roles.maker }))
    throw new Error("MAKER_HAS_CODE");
}

// Plan hashes are the artifacts' ABI and creation-bytecode hashes. The runtime code
// depends on constructor immutables and the deployment address, so only the chain knows it.
export async function planDeployment(input: {
  client: PublicClient;
  roles: RoleAddresses;
  deploymentId: string;
  artifactsDir: URL;
  deployer: Address;
}) {
  await assertDeployChain(input.client);
  checkDeploymentId(input.deploymentId);
  checkRoles(input.roles, input.deployer);
  const artifacts = await loadArtifacts(input.artifactsDir);
  const [addresses, deployerBalanceWei] = await Promise.all([
    nextAddresses(input.client, input.deployer),
    input.client.getBalance({ address: input.deployer }),
  ]);
  await checkDeployable(
    input.client,
    artifacts,
    input.roles,
    addresses.BlinkTestUSD,
  );
  return {
    chainId: 84532 as const,
    deployer: input.deployer,
    deployerBalanceWei,
    constructorArgs: constructorArgs(input.roles, addresses.BlinkTestUSD),
    abiHashes: {
      BlinkTestUSD: artifacts.BlinkTestUSD.abiHash,
      BlinkMarket: artifacts.BlinkMarket.abiHash,
    },
    bytecodeHashes: {
      BlinkTestUSD: artifacts.BlinkTestUSD.creationBytecodeHash,
      BlinkMarket: artifacts.BlinkMarket.creationBytecodeHash,
    },
  };
}

export async function deployContracts(input: {
  client: PublicClient;
  wallet: WalletClient;
  roles: RoleAddresses;
  deploymentId: string;
  artifactsDir: URL;
  gitCommit: string;
  dependencies: Record<string, string>;
}): Promise<DeploymentManifest> {
  const { client, wallet, roles, deploymentId } = input;
  await assertDeployChain(client);
  const account = wallet.account;
  if (!account) throw new Error("DEPLOYER_ACCOUNT_REQUIRED");
  checkDeploymentId(deploymentId);
  checkRoles(roles, account.address);
  const artifacts = await loadArtifacts(input.artifactsDir);
  const manifestFor = (
    contracts: PerContract<Address>,
    deploymentBlock: bigint,
    bytecodeHashes: PerContract<Hex>,
  ) => ({
    status: "DEPLOYED",
    chainId: 84532,
    deploymentId,
    deploymentBlock: String(deploymentBlock),
    contracts,
    artifacts: {
      abiHashes: {
        BlinkTestUSD: artifacts.BlinkTestUSD.abiHash,
        BlinkMarket: artifacts.BlinkMarket.abiHash,
      },
      bytecodeHashes,
      compiler: "0.8.30",
      gitCommit: input.gitCommit,
      dependencies: input.dependencies,
    },
    roles,
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
  });
  // Find everything that would fail after the token is on chain before spending any gas:
  // constructor arguments and the maker, then a dry parse of the manifest with the
  // predicted addresses (bad commit or dependency list).
  const predicted = await nextAddresses(client, account.address);
  await checkDeployable(client, artifacts, roles, predicted.BlinkTestUSD);
  const preflight = DeploymentManifest.safeParse(
    manifestFor(predicted, 0n, {
      BlinkTestUSD: artifacts.BlinkTestUSD.creationBytecodeHash,
      BlinkMarket: artifacts.BlinkMarket.creationBytecodeHash,
    }),
  );
  if (!preflight.success)
    throw new Error(
      "INVALID_DEPLOYMENT_INPUT: " +
        preflight.error.issues
          .map((i) => i.path.join(".") + " " + i.message)
          .join("; "),
    );

  const deployed: Partial<PerContract<Address>> = {};
  const blocks: bigint[] = [];
  const broadcast = async (name: ContractName, args: readonly unknown[]) => {
    await assertDeployChain(client);
    const hash = await wallet.deployContract({
      abi: artifacts[name].abi,
      bytecode: artifacts[name].bytecode,
      args,
      account,
      chain: wallet.chain,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw new Error("DEPLOY_TX_REVERTED: " + name + " " + hash);
    blocks.push(receipt.blockNumber);
    return (deployed[name] = getAddress(receipt.contractAddress));
  };
  try {
    const token = await broadcast("BlinkTestUSD", [roles.faucetMinter]);
    const market = await broadcast(
      "BlinkMarket",
      constructorArgs(roles, token).BlinkMarket,
    );
    const runtimeHash = async (address: Address) => {
      const code = await client.getCode({ address });
      if (!code) throw new Error("DEPLOYED_CODE_MISSING: " + address);
      return keccak256(code);
    };
    const manifest = manifestFor(
      { BlinkTestUSD: token, BlinkMarket: market },
      blocks.reduce((a, b) => (b < a ? b : a)),
      {
        BlinkTestUSD: await runtimeHash(token),
        BlinkMarket: await runtimeHash(market),
      },
    );
    try {
      return (
        await verifyDeploymentOnChain(manifest, deploymentId, client, {
          BlinkTestUSD: artifacts.BlinkTestUSD.abi,
          BlinkMarket: artifacts.BlinkMarket.abi,
        })
      ).manifest;
    } catch (error) {
      throw new Error("DEPLOYMENT_VERIFICATION_FAILED: " + reason(error));
    }
  } catch (error) {
    // Anything already on chain cannot be undone; tell the operator what it is.
    const onChain = Object.entries(deployed)
      .map(([name, address]) => name + " " + address)
      .join(", ");
    throw new Error(
      reason(error) + (onChain ? " (already deployed: " + onChain + ")" : ""),
      { cause: error },
    );
  }
}

// The release commit for a manifest: HEAD of a clean tree, unless the caller opts out.
export function readReleaseCommit(cwd: string, allowDirty: boolean): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  if (!allowDirty && git("status", "--porcelain") !== "")
    throw new Error("DIRTY_TREE");
  return commit;
}
