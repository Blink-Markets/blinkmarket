import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  getContractAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  toBytes,
  zeroAddress,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  DeploymentId,
  governorDefaults,
  ProtocolDeployment,
  ProtocolParams,
  TEST_TOKEN_PRICE_MICROS,
} from "@blink/schemas";
import { protocolAbi } from "./protocol-abi.js";

// Local tooling only: the CLI never broadcasts outside Anvil (31337) and Base Sepolia (84532),
// and every contract constructor refuses any chain id but 84532.
export const DEPLOY_CHAIN_IDS = [31337, 84532] as const;
export const DEPLOY_ESTIMATE_RETRY = { attempts: 30, delayMs: 1000 } as const;
const MAX_GENERATION_DEPTH = 64;
const GAS_MARGIN_NUMERATOR = 12n;
const GAS_MARGIN_DENOMINATOR = 10n;

// Contract names double as artifact names (contracts/artifacts/<name>.json) and manifest keys.
export const SHARED_SLOT_CONTRACTS = {
  faucet: "BlinkFaucet",
  busd: "BlinkTestUSD",
  token: "BlinkToken",
  priceSource: "FixedPriceSource",
  governor: "BlinkGovernor",
  anchor: "BlinkAnchor",
} as const;
export const GENERATION_SLOT_CONTRACTS = {
  registry: "BlinkRegistry",
  jurors: "BlinkJurors",
  markets: "BlinkMarkets",
  resolution: "BlinkResolution",
} as const;
export type ProtocolArtifactName =
  | (typeof SHARED_SLOT_CONTRACTS)[keyof typeof SHARED_SLOT_CONTRACTS]
  | (typeof GENERATION_SLOT_CONTRACTS)[keyof typeof GENERATION_SLOT_CONTRACTS];

export type SharedAddresses = ProtocolDeployment["shared"];
export interface GenerationPlanAddresses {
  registry: Address;
  jurors: Address;
  markets: Address;
  resolution: Address;
}
export interface PlannedTransaction {
  name: ProtocolArtifactName;
  phase: "shared" | "generation";
  nonce: number;
  address: Address;
  constructorArgsHash: Hex;
}
export interface DeploymentPlan {
  chainId: 84532;
  deployer: Address;
  nonce: number;
  treasury: Address;
  params: ProtocolParams;
  previousRegistry: Address | null;
  sharedReused: boolean;
  shared: SharedAddresses;
  generation: GenerationPlanAddresses;
  transactions: PlannedTransaction[];
}

// ---- artifacts ----

export interface ProtocolArtifact {
  abi: Abi;
  abiHash: Hex;
  bytecode: Hex;
  creationBytecodeHash: Hex;
  deployedBytecodeTemplate: Hex;
  compiler: string;
}
export type ProtocolArtifacts = Record<ProtocolArtifactName, ProtocolArtifact>;

const DEFAULT_ARTIFACTS_DIR = new URL(
  "../../../contracts/artifacts/",
  import.meta.url,
);
const ARTIFACT_NAMES: readonly ProtocolArtifactName[] = [
  ...Object.values(SHARED_SLOT_CONTRACTS),
  ...Object.values(GENERATION_SLOT_CONTRACTS),
];

// Artifacts come from scripts/check-contracts.mjs; refuse any whose recorded hashes disagree.
export async function loadProtocolArtifacts(
  dir: URL | string = DEFAULT_ARTIFACTS_DIR,
): Promise<ProtocolArtifacts> {
  const entries = await Promise.all(
    ARTIFACT_NAMES.map(async (name) => {
      const file =
        typeof dir === "string"
          ? join(dir, name + ".json")
          : new URL(name + ".json", dir);
      let artifact: ProtocolArtifact;
      try {
        artifact = JSON.parse(await readFile(file, "utf8")) as ProtocolArtifact;
      } catch {
        throw new Error(
          "ARTIFACT_MISSING: " + name + " (run pnpm check:contracts)",
        );
      }
      if (
        keccak256(toBytes(JSON.stringify(artifact.abi))) !== artifact.abiHash ||
        keccak256(artifact.bytecode) !== artifact.creationBytecodeHash ||
        !artifact.compiler.startsWith("0.8.30")
      )
        throw new Error(
          "ARTIFACT_MISMATCH: " + name + " (run pnpm check:contracts)",
        );
      return [name, artifact] as const;
    }),
  );
  return Object.fromEntries(entries) as ProtocolArtifacts;
}

// ---- Params and address tuples <-> chain values ----

type AbiParam = AbiParameter & { components?: readonly AbiParam[] };
const registryAbi = protocolAbi.registry as Abi;
const outputOf = (name: string): AbiParam => {
  const item = registryAbi.find(
    (i): i is AbiFunction => i.type === "function" && i.name === name,
  );
  if (!item?.outputs[0])
    throw new Error("PROTOCOL_ABI_MISSING: registry." + name);
  return item.outputs[0] as AbiParam;
};
export const paramsTuple = outputOf("params");
const addressesTuple = outputOf("addresses");

const arrayElement = (type: string) => type.replace(/\[\d*\]$/, "");
const intBits = (type: string) => /^u?int(\d+)$/.exec(type)?.[1];

// Manifest JSON (decimal strings for uint256, numbers up to uint64) to viem values.
export function toChain(param: AbiParam, value: unknown): unknown {
  if (param.type === "tuple") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      (param.components ?? []).map((c) => [
        c.name,
        toChain(c, record[c.name!]),
      ]),
    );
  }
  if (/\[\d*\]$/.test(param.type))
    return (value as unknown[]).map((v) =>
      toChain({ ...param, type: arrayElement(param.type) } as AbiParam, v),
    );
  const bits = intBits(param.type);
  return bits !== undefined && Number(bits) > 32
    ? BigInt(value as string | number)
    : value;
}

// viem values back to the manifest's JSON shape, field order following the ABI.
export function fromChain(param: AbiParam, value: unknown): unknown {
  if (param.type === "tuple") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      (param.components ?? []).map((c) => [
        c.name,
        fromChain(c, record?.[c.name!]),
      ]),
    );
  }
  if (/\[\d*\]$/.test(param.type))
    return (value as unknown[]).map((v) =>
      fromChain({ ...param, type: arrayElement(param.type) } as AbiParam, v),
    );
  const bits = intBits(param.type);
  if (bits === undefined || typeof value !== "bigint") return value;
  return Number(bits) >= 256 ? value.toString() : Number(value);
}

// ---- plan ----

const checkAddress = (label: string, value: string): Address => {
  if (!isAddress(value, { strict: false }))
    throw new Error("INVALID_ADDRESS: " + label);
  return getAddress(value);
};

// The deployer's CREATE addresses for the four generation contracts starting at `nonce`.
export function predictGeneration(
  deployer: Address,
  nonce: number,
): GenerationPlanAddresses {
  const at = (offset: number) =>
    getContractAddress({ from: deployer, nonce: BigInt(nonce + offset) });
  return { registry: at(0), jurors: at(1), markets: at(2), resolution: at(3) };
}

const generationAddresses = (
  generation: GenerationPlanAddresses,
  plan: Pick<DeploymentPlan, "shared" | "treasury" | "previousRegistry">,
) => ({
  ...generation,
  collateral: plan.shared.busd as Address,
  token: plan.shared.token as Address,
  priceSource: plan.shared.priceSource as Address,
  treasury: plan.treasury,
  previousRegistry: plan.previousRegistry ?? zeroAddress,
});

const GOVERNOR_ARGS = parseAbiParameters(
  "address token, uint48 votingDelay, uint32 votingPeriod, uint256 proposalThreshold, uint256 quorumFraction, uint64 adoptionDelay",
);

function constructorArgs(
  name: ProtocolArtifactName,
  plan: Pick<
    DeploymentPlan,
    "shared" | "treasury" | "previousRegistry" | "params"
  >,
  generation: GenerationPlanAddresses,
): readonly unknown[] {
  switch (name) {
    case "BlinkFaucet":
    case "BlinkAnchor":
      return [];
    case "FixedPriceSource":
      return [BigInt(TEST_TOKEN_PRICE_MICROS)];
    case "BlinkGovernor":
      return [
        plan.shared.token,
        governorDefaults.votingDelay,
        governorDefaults.votingPeriod,
        BigInt(governorDefaults.proposalThreshold),
        BigInt(governorDefaults.quorumFraction),
        BigInt(governorDefaults.adoptionDelay),
      ];
    case "BlinkRegistry":
      return [
        toChain(paramsTuple, plan.params),
        generationAddresses(generation, plan),
      ];
    case "BlinkJurors":
    case "BlinkMarkets":
    case "BlinkResolution":
      return [generationAddresses(generation, plan)];
    default:
      throw new Error("NOT_DEPLOYED_BY_TRANSACTION: " + name);
  }
}

const argTypes = (name: ProtocolArtifactName): readonly AbiParameter[] => {
  switch (name) {
    case "BlinkFaucet":
    case "BlinkAnchor":
      return [];
    case "FixedPriceSource":
      return [{ type: "uint256" }];
    case "BlinkGovernor":
      return GOVERNOR_ARGS;
    case "BlinkRegistry":
      return [paramsTuple, addressesTuple];
    default:
      return [addressesTuple];
  }
};

const argsHash = (name: ProtocolArtifactName, args: readonly unknown[]): Hex =>
  keccak256(
    encodeAbiParameters(argTypes(name) as AbiParameter[], args as never),
  );

/**
 * Pure: lists every transaction with the CREATE address it will produce and the hash of its
 * ABI-encoded constructor arguments. Without `shared` the plan also deploys the shared contracts
 * (faucet, price source, governor, anchor) ahead of the generation; BlinkFaucet creates bUSD and
 * the platform token itself, so those two sit at the faucet's CREATE nonces 1 and 2.
 */
export function planProtocolDeployment(input: {
  deployer: Address;
  nonce: number;
  params: ProtocolParams;
  treasury: Address;
  previousRegistry?: Address;
  shared?: ProtocolDeployment["shared"];
}): DeploymentPlan {
  const deployer = checkAddress("deployer", input.deployer);
  const treasury = checkAddress("treasury", input.treasury);
  if (treasury === zeroAddress) throw new Error("INVALID_ADDRESS: treasury");
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0)
    throw new Error("INVALID_NONCE");
  const params = ProtocolParams.parse(input.params);
  if (input.previousRegistry && !input.shared)
    throw new Error("PREVIOUS_REGISTRY_REQUIRES_SHARED");
  const previousRegistry = input.previousRegistry
    ? checkAddress("previousRegistry", input.previousRegistry)
    : null;

  const at = (offset: number) =>
    getContractAddress({ from: deployer, nonce: BigInt(input.nonce + offset) });
  let shared: SharedAddresses;
  if (input.shared) {
    shared = ProtocolDeployment.shape.shared.parse(input.shared);
    shared = Object.fromEntries(
      Object.entries(shared).map(([k, v]) => [k, getAddress(v)]),
    ) as SharedAddresses;
  } else {
    const faucet = at(0);
    shared = {
      faucet,
      busd: getContractAddress({ from: faucet, nonce: 1n }),
      token: getContractAddress({ from: faucet, nonce: 2n }),
      priceSource: at(1),
      governor: at(2),
      anchor: at(3),
    };
  }
  const sharedReused = input.shared !== undefined;
  const generationNonce = input.nonce + (sharedReused ? 0 : 4);
  const generation = predictGeneration(deployer, generationNonce);

  const base = { shared, treasury, previousRegistry, params };
  const row = (
    name: ProtocolArtifactName,
    phase: PlannedTransaction["phase"],
    nonce: number,
    address: Address,
  ): PlannedTransaction => ({
    name,
    phase,
    nonce,
    address,
    constructorArgsHash: argsHash(
      name,
      constructorArgs(name, base, generation),
    ),
  });
  const transactions: PlannedTransaction[] = [
    ...(sharedReused
      ? []
      : [
          row("BlinkFaucet", "shared", input.nonce, shared.faucet as Address),
          row(
            "FixedPriceSource",
            "shared",
            input.nonce + 1,
            shared.priceSource as Address,
          ),
          row(
            "BlinkGovernor",
            "shared",
            input.nonce + 2,
            shared.governor as Address,
          ),
          row(
            "BlinkAnchor",
            "shared",
            input.nonce + 3,
            shared.anchor as Address,
          ),
        ]),
    row("BlinkRegistry", "generation", generationNonce, generation.registry),
    row("BlinkJurors", "generation", generationNonce + 1, generation.jurors),
    row("BlinkMarkets", "generation", generationNonce + 2, generation.markets),
    row(
      "BlinkResolution",
      "generation",
      generationNonce + 3,
      generation.resolution,
    ),
  ];
  return {
    chainId: 84532,
    deployer,
    nonce: input.nonce,
    treasury,
    params,
    previousRegistry,
    sharedReused,
    shared,
    generation,
    transactions,
  };
}

// ---- chain guards ----

export async function assertProtocolDeployChain(client: PublicClient) {
  const chainId = await client.getChainId();
  if (chainId === 8453) throw new Error("MAINNET_REFUSED");
  if (!(DEPLOY_CHAIN_IDS as readonly number[]).includes(chainId))
    throw new Error(
      "WRONG_CHAIN: expected 31337 or 84532, observed " + chainId,
    );
}

/**
 * Depth of a generation in its registry chain: 1 without a predecessor, 2 with one, and so on.
 * Reads `addresses().previousRegistry`, so a chain that does not end is refused.
 */
export async function generationIndexOf(
  client: PublicClient,
  previousRegistry: Address | null,
  blockNumber?: bigint,
): Promise<number> {
  let depth = 1;
  let cursor = previousRegistry;
  while (cursor) {
    if (++depth > MAX_GENERATION_DEPTH)
      throw new Error("GENERATION_CHAIN_TOO_LONG");
    const a = (await client.readContract({
      address: cursor,
      abi: registryAbi,
      functionName: "addresses",
      ...(blockNumber === undefined ? {} : { blockNumber }),
    })) as { previousRegistry: Address };
    cursor =
      a.previousRegistry === zeroAddress
        ? null
        : getAddress(a.previousRegistry);
  }
  return depth;
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

// ---- deploy ----

/** A failed deployment names what is already on chain; nothing there can be undone. */
export class ProtocolDeployError extends Error {
  constructor(
    message: string,
    readonly deployed: Readonly<Record<string, Address>>,
    options?: { cause: unknown },
  ) {
    const onChain = Object.entries(deployed)
      .map(([name, address]) => name + " " + address)
      .join(", ");
    super(
      message + (onChain ? " (already deployed: " + onChain + ")" : ""),
      options,
    );
    this.name = "ProtocolDeployError";
  }
}

export interface DeployMeta {
  deploymentId: string;
  releaseCommit: string;
  artifactsDir?: URL | string;
  /** Required when the plan reuses shared contracts: supplies their records and settings. */
  sharedFrom?: ProtocolDeployment;
}

const reason = (error: unknown) =>
  error instanceof Error
    ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
    : "unknown error";

export async function deployProtocol(
  wallet: WalletClient,
  publicClient: PublicClient,
  plan: DeploymentPlan,
  meta: DeployMeta,
): Promise<ProtocolDeployment> {
  const deployed: Record<string, Address> = {};
  try {
    return await run(wallet, publicClient, plan, meta, deployed);
  } catch (error) {
    if (error instanceof ProtocolDeployError) throw error;
    throw new ProtocolDeployError(reason(error), deployed, { cause: error });
  }
}

async function run(
  wallet: WalletClient,
  client: PublicClient,
  plan: DeploymentPlan,
  meta: DeployMeta,
  deployed: Record<string, Address>,
): Promise<ProtocolDeployment> {
  await assertProtocolDeployChain(client);
  const account = wallet.account;
  if (!account) throw new Error("DEPLOYER_ACCOUNT_REQUIRED");
  if (account.address.toLowerCase() !== plan.deployer.toLowerCase())
    throw new Error("DEPLOYER_MISMATCH");
  if (!DeploymentId.safeParse(meta.deploymentId).success)
    throw new Error("INVALID_DEPLOYMENT_ID");
  if (!/^[0-9a-f]{40}$/.test(meta.releaseCommit))
    throw new Error("INVALID_RELEASE_COMMIT");
  const sharedFrom = meta.sharedFrom;
  if (plan.sharedReused) {
    if (!sharedFrom) throw new Error("SHARED_MANIFEST_REQUIRED");
    if (
      JSON.stringify(
        Object.values(sharedFrom.shared).map((a) => a.toLowerCase()),
      ) !==
      JSON.stringify(Object.values(plan.shared).map((a) => a.toLowerCase()))
    )
      throw new Error("SHARED_MISMATCH: plan and sharedFrom disagree");
  }
  const artifacts = await loadProtocolArtifacts(meta.artifactsDir);
  const pendingNonce = () =>
    client.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
  const requireNonce = async (expected: number) => {
    const observed = await pendingNonce();
    if (observed !== expected)
      throw new Error(
        "NONCE_DRIFT: expected nonce " + expected + ", observed " + observed,
      );
    return observed;
  };
  await requireNonce(plan.nonce);

  // Everything that would fail only after gas is spent: the shared contracts and the previous
  // generation must already be what the plan assumes.
  if (plan.sharedReused)
    for (const address of Object.values(plan.shared))
      if (!(await client.getCode({ address: address as Address })))
        throw new Error("SHARED_NOT_DEPLOYED: " + address);
  const generationIndex = await generationIndexOf(
    client,
    plan.previousRegistry,
  );
  if (plan.previousRegistry) {
    const previous = (await client.readContract({
      address: plan.previousRegistry,
      abi: registryAbi,
      functionName: "addresses",
    })) as Record<"collateral" | "token" | "priceSource", Address>;
    for (const [field, slot] of [
      ["collateral", "busd"],
      ["token", "token"],
      ["priceSource", "priceSource"],
    ] as const)
      if (previous[field].toLowerCase() !== plan.shared[slot].toLowerCase())
        throw new Error("PREVIOUS_REGISTRY_SHARED_MISMATCH: " + field);
  }

  const records: ProtocolDeployment["contracts"] = {};
  const send = async (
    name: ProtocolArtifactName,
    args: readonly unknown[],
    nonce: number,
    expected: Address,
  ) => {
    const { abi, bytecode } = artifacts[name];
    const data = encodeDeployData({ abi, bytecode, args });
    // Explicit gas and nonce: the wallet makes no reads against a node that lags the last receipt.
    let estimate: bigint | undefined;
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt < DEPLOY_ESTIMATE_RETRY.attempts && estimate === undefined;
      attempt++
    ) {
      try {
        estimate = await client.estimateGas({ account: account.address, data });
      } catch (error) {
        lastError = error;
        await delay(DEPLOY_ESTIMATE_RETRY.delayMs);
      }
    }
    if (estimate === undefined)
      throw new Error(
        "DEPLOY_GAS_ESTIMATE_FAILED: " + name + ": " + reason(lastError),
      );
    // Never retried: a repeated send could mask a transaction that was already accepted.
    const hash = await wallet.deployContract({
      abi,
      bytecode,
      args,
      account,
      chain: wallet.chain,
      nonce,
      gas: (estimate * GAS_MARGIN_NUMERATOR) / GAS_MARGIN_DENOMINATOR,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw new Error("DEPLOY_TX_REVERTED: " + name + " " + hash);
    if (getAddress(receipt.contractAddress) !== expected)
      throw new Error("DEPLOYED_ADDRESS_MISMATCH: " + name);
    deployed[name] = expected;
    return { hash, blockNumber: receipt.blockNumber };
  };
  const record = async (
    name: ProtocolArtifactName,
    address: Address,
    tx: { hash: Hex; blockNumber: bigint },
  ) => {
    const code = await client.getCode({ address, blockNumber: tx.blockNumber });
    if (!code) throw new Error("DEPLOYED_CODE_MISSING: " + name);
    records[name] = {
      address,
      abiHash: artifacts[name].abiHash,
      runtimeHash: keccak256(code),
      deployTx: tx.hash,
      block: Number(tx.blockNumber),
    };
  };

  const base = {
    shared: plan.shared,
    treasury: plan.treasury,
    previousRegistry: plan.previousRegistry,
    params: plan.params,
  };
  for (const tx of plan.transactions.filter((t) => t.phase === "shared")) {
    const sent = await send(
      tx.name,
      constructorArgs(tx.name, base, plan.generation),
      tx.nonce,
      tx.address,
    );
    await record(tx.name, tx.address, sent);
    if (tx.name !== "BlinkFaucet") continue;
    // The faucet created bUSD and the platform token: check where, then record them with its tx.
    const read = (functionName: "busd" | "token") =>
      client.readContract({
        address: tx.address,
        abi: protocolAbi.faucet,
        functionName,
        blockNumber: sent.blockNumber,
      });
    for (const [name, slot] of [
      ["BlinkTestUSD", "busd"],
      ["BlinkToken", "token"],
    ] as const) {
      const address = getAddress(await read(slot));
      if (address !== plan.shared[slot])
        throw new Error("FAUCET_CREATED_UNEXPECTED_" + slot.toUpperCase());
      deployed[name] = address;
      await record(name, address, sent);
    }
  }

  // The generation's addresses embed the nonce each contract is sent from, so any transaction
  // that moved the deployer's nonce since the plan makes the pre-computed addresses wrong.
  const sharedCount = plan.transactions.filter(
    (t) => t.phase === "shared",
  ).length;
  const generationNonce = await requireNonce(plan.nonce + sharedCount);
  const generation = predictGeneration(account.address, generationNonce);
  const generationTxs = [
    ["BlinkRegistry", generation.registry],
    ["BlinkJurors", generation.jurors],
    ["BlinkMarkets", generation.markets],
    ["BlinkResolution", generation.resolution],
  ] as const;
  for (const [offset, [name, address]] of generationTxs.entries()) {
    const sent = await send(
      name,
      constructorArgs(name, base, generation),
      generationNonce + offset,
      address,
    );
    await record(name, address, sent);
  }

  const contracts = {
    ...Object.fromEntries(
      Object.entries(sharedFrom?.contracts ?? {}).filter(([name]) =>
        (Object.values(SHARED_SLOT_CONTRACTS) as readonly string[]).includes(
          name,
        ),
      ),
    ),
    ...records,
  };
  return ProtocolDeployment.parse({
    schema: "blink.deployment/2",
    deploymentId: meta.deploymentId,
    chainId: 84532,
    deployer: plan.deployer,
    treasury: plan.treasury,
    shared: plan.shared,
    generation: {
      index: generationIndex,
      ...generation,
      previousRegistry: plan.previousRegistry,
    },
    params: plan.params,
    governor: sharedFrom?.governor ?? governorDefaults,
    tokenPriceMicros: sharedFrom?.tokenPriceMicros ?? TEST_TOKEN_PRICE_MICROS,
    contracts,
    startBlock: Math.min(...Object.values(contracts).map((c) => c.block)),
    releaseCommit: meta.releaseCommit,
  });
}
