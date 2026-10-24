import {
  getAddress,
  hexToBytes,
  keccak256,
  toBytes,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { requireDeployment, type ProtocolDeployment } from "@blink/schemas";
import { protocolAbi } from "./protocol-abi.js";
import {
  fromChain,
  generationIndexOf,
  GENERATION_SLOT_CONTRACTS,
  loadProtocolArtifacts,
  paramsTuple,
  SHARED_SLOT_CONTRACTS,
  type ProtocolArtifacts,
} from "./protocol-deployer.js";

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

// ---- manifest v2 ----

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface VerificationReport {
  deploymentId: string;
  ok: boolean;
  checks: VerificationCheck[];
  blockNumber: string;
  blockHash: Hex;
  verifiedAt: Date;
}

const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

// Runtime code equals the artifact's template except where an immutable was written. Solidity
// leaves each immutable as a 32-byte run of zeros in the template, so a byte may differ only
// inside such a run. ponytail: a zero run in real code could hide a patched byte; the recorded
// runtime hash and the cross-link reads below are the second line of defence.
function matchesTemplate(code: Hex, template: Hex): boolean {
  const actual = hexToBytes(code);
  const expected = hexToBytes(template);
  if (actual.length !== expected.length) return false;
  const free = new Uint8Array(expected.length);
  for (let start = 0; start < expected.length;) {
    let end = start;
    while (end < expected.length && expected[end] === 0) end++;
    if (end - start >= 32) free.fill(1, start, end);
    start = end + 1;
  }
  return actual.every((byte, i) => byte === expected[i] || free[i] === 1);
}

/**
 * Checks a manifest v2 against the chain: code against the artifacts, registry params and
 * address cross-links, faucet-created assets and their minters, the governor and the anchor.
 * Every check runs against one head block; a failing check never stops the others.
 */
export async function verifyProtocolDeployment(
  client: PublicClient,
  manifest: ProtocolDeployment,
  options: { artifactsDir?: URL | string } = {},
): Promise<VerificationReport> {
  const checks: VerificationCheck[] = [];
  const check = async (name: string, run: () => Promise<string | void>) => {
    try {
      const failure = await run();
      checks.push(
        failure ? { name, ok: false, detail: failure } : { name, ok: true },
      );
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail:
          error instanceof Error
            ? ((error as { shortMessage?: string }).shortMessage ??
              error.message)
            : "unknown error",
      });
    }
  };
  const verifiedAt = new Date();
  const block = await client.getBlock();
  const blockNumber = block.number;
  const read = (
    address: string,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
  ) =>
    client.readContract({
      address: address as Address,
      abi,
      functionName,
      args,
      blockNumber,
    });
  // Pins a getter to an expected address.
  const expectAddress = async (
    what: string,
    address: string,
    abi: Abi,
    fn: string,
    expected: string,
  ) => {
    const observed = (await read(address, abi, fn)) as string;
    if (!sameAddress(observed, expected))
      return what + ": " + fn + "() is " + observed + ", expected " + expected;
  };
  const firstFailure = async (items: Promise<string | void>[]) =>
    (await Promise.all(items)).find((r) => r) as string | undefined;

  await check("chain", async () => {
    const id = await client.getChainId();
    if (id !== manifest.chainId) return "chain id " + id;
  });
  let artifacts: ProtocolArtifacts | undefined;
  await check("artifacts", async () => {
    artifacts = await loadProtocolArtifacts(options.artifactsDir);
  });

  // Every recorded contract: ABI hash, runtime hash and runtime code against its artifact.
  for (const [name, record] of Object.entries(manifest.contracts))
    await check("code:" + name, async () => {
      const artifact = artifacts?.[name as keyof ProtocolArtifacts];
      if (!artifact) return "no artifact for " + name;
      if (record.abiHash !== artifact.abiHash)
        return "ABI hash differs from the artifact";
      const code = await client.getCode({
        address: record.address as Address,
        blockNumber,
      });
      if (!code || code === "0x") return "no code at " + record.address;
      if (keccak256(code) !== record.runtimeHash)
        return "runtime hash differs from the manifest";
      if (!matchesTemplate(code, artifact.deployedBytecodeTemplate))
        return "runtime code differs from the artifact";
    });

  // Each slot is backed by exactly the record of the contract that belongs there.
  await check("slots", async () => {
    const wrong = [
      ...Object.entries(SHARED_SLOT_CONTRACTS).map(
        ([slot, name]) =>
          [
            name,
            manifest.shared[slot as keyof typeof manifest.shared],
          ] as const,
      ),
      ...Object.entries(GENERATION_SLOT_CONTRACTS).map(
        ([slot, name]) =>
          [
            name,
            manifest.generation[slot as keyof typeof GENERATION_SLOT_CONTRACTS],
          ] as const,
      ),
    ].filter(
      ([name, address]) =>
        !manifest.contracts[name] ||
        !sameAddress(manifest.contracts[name].address, address),
    );
    if (wrong.length)
      return "no matching record for " + wrong.map(([n]) => n).join(", ");
  });

  const { shared, generation } = manifest;
  await check("registry.params", async () => {
    const onChain = fromChain(
      paramsTuple,
      await read(generation.registry, protocolAbi.registry as Abi, "params"),
    ) as Record<string, unknown>;
    // The ABI lists every field, so a field missing from the manifest also shows as a mismatch.
    const expected = manifest.params as Record<string, unknown>;
    const differing = Object.keys(onChain).filter(
      (k) => JSON.stringify(onChain[k]) !== JSON.stringify(expected[k]),
    );
    const extra = Object.keys(expected).filter((k) => !(k in onChain));
    if (differing.length || extra.length)
      return "differs in " + [...differing, ...extra].join(", ");
  });
  await check("registry.addresses", async () => {
    const a = (await read(
      generation.registry,
      protocolAbi.registry as Abi,
      "addresses",
    )) as Record<
      | "registry"
      | "jurors"
      | "markets"
      | "resolution"
      | "collateral"
      | "token"
      | "priceSource"
      | "treasury"
      | "previousRegistry",
      string
    >;
    const pairs: [string, string, string][] = [
      ["registry", a.registry, generation.registry],
      ["jurors", a.jurors, generation.jurors],
      ["markets", a.markets, generation.markets],
      ["resolution", a.resolution, generation.resolution],
      ["collateral", a.collateral, shared.busd],
      ["token", a.token, shared.token],
      ["priceSource", a.priceSource, shared.priceSource],
      ["treasury", a.treasury, manifest.treasury],
      [
        "previousRegistry",
        a.previousRegistry,
        generation.previousRegistry ?? zeroAddress,
      ],
    ];
    const wrong = pairs.filter(
      ([, observed, expected]) => !sameAddress(observed, expected),
    );
    if (wrong.length) return "mismatch in " + wrong.map(([k]) => k).join(", ");
  });
  const links: [string, string, Abi, [string, string][]][] = [
    [
      "jurors",
      generation.jurors,
      protocolAbi.jurors as Abi,
      [
        ["registry", generation.registry],
        ["markets", generation.markets],
        ["resolution", generation.resolution],
        ["token", shared.token],
        ["collateral", shared.busd],
        ["priceSource", shared.priceSource],
        ["treasury", manifest.treasury],
      ],
    ],
    [
      "markets",
      generation.markets,
      protocolAbi.markets as Abi,
      [
        ["registry", generation.registry],
        ["jurors", generation.jurors],
        ["resolution", generation.resolution],
        ["collateral", shared.busd],
      ],
    ],
    [
      "resolution",
      generation.resolution,
      protocolAbi.resolution as Abi,
      [
        ["registry", generation.registry],
        ["markets", generation.markets],
        ["jurors", generation.jurors],
        ["collateral", shared.busd],
      ],
    ],
  ];
  for (const [name, address, abi, getters] of links)
    await check(name + ".links", async () =>
      firstFailure(
        getters.map(([fn, expected]) =>
          expectAddress(name, address, abi, fn, expected),
        ),
      ),
    );
  await check("faucet", async () =>
    firstFailure([
      expectAddress(
        "faucet",
        shared.faucet,
        protocolAbi.faucet as Abi,
        "busd",
        shared.busd,
      ),
      expectAddress(
        "faucet",
        shared.faucet,
        protocolAbi.faucet as Abi,
        "token",
        shared.token,
      ),
      expectAddress(
        "busd",
        shared.busd,
        protocolAbi.token as Abi,
        "minter",
        shared.faucet,
      ),
      expectAddress(
        "token",
        shared.token,
        protocolAbi.token as Abi,
        "minter",
        shared.faucet,
      ),
    ]),
  );
  await check("governor", async () => {
    const wrongToken = await expectAddress(
      "governor",
      shared.governor,
      protocolAbi.governor as Abi,
      "token",
      shared.token,
    );
    if (wrongToken) return wrongToken;
    for (const [fn, expected] of [
      ["votingDelay", BigInt(manifest.governor.votingDelay)],
      ["votingPeriod", BigInt(manifest.governor.votingPeriod)],
      ["proposalThreshold", BigInt(manifest.governor.proposalThreshold)],
      ["adoptionDelay", BigInt(manifest.governor.adoptionDelay)],
    ] as const)
      if (
        (await read(shared.governor, protocolAbi.governor as Abi, fn)) !==
        expected
      )
        return "governor." + fn + " differs from the manifest";
  });
  await check("priceSource", async () => {
    if (
      (await read(
        shared.priceSource,
        protocolAbi.priceSource as Abi,
        "tokenPriceMicros",
      )) !== BigInt(manifest.tokenPriceMicros)
    )
      return "tokenPriceMicros differs from the manifest";
  });
  await check("anchor", async () => {
    const code = await client.getCode({
      address: shared.anchor as Address,
      blockNumber,
    });
    if (!code || code === "0x") return "no code at the anchor";
  });
  await check("generation.index", async () => {
    const previous = generation.previousRegistry
      ? getAddress(generation.previousRegistry)
      : null;
    if (previous && !(await client.getCode({ address: previous, blockNumber })))
      return "no code at previousRegistry";
    const depth = await generationIndexOf(client, previous, blockNumber);
    if (depth !== generation.index)
      return "chain depth is " + depth + ", manifest says " + generation.index;
  });
  await check("reorg", async () => {
    if ((await client.getBlock({ blockNumber })).hash !== block.hash)
      return "head block changed during verification";
  });

  return {
    deploymentId: manifest.deploymentId,
    ok: checks.every((c) => c.ok),
    checks,
    blockNumber: blockNumber.toString(),
    blockHash: block.hash,
    verifiedAt,
  };
}
