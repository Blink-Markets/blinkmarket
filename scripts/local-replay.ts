import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  hashTypedData,
  keccak256,
  type Abi,
  type Hex,
  type Address,
  type PublicClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
// @ts-expect-error Plain JS tool resolver has no declaration file.
import { foundryBinary } from "./foundry.mjs";
import {
  quoteTypes,
  type DeploymentManifest,
} from "../packages/schemas/src/index.js";
import { encodeNewSpec } from "../packages/adapters/src/spec-archive.js";
import { creationReceiptReader } from "../packages/adapters/src/creation-receipt-reader.js";
import { untrackedCreation } from "../packages/adapters/src/creation-tracker-store.js";
import { encodeMarketCreation } from "../packages/adapters/src/creation-calldata.js";

const artifact = async (name: string) =>
  JSON.parse(
    await readFile(
      new URL("../contracts/artifacts/" + name + ".json", import.meta.url),
      "utf8",
    ),
  ) as { abi: Abi; bytecode: Hex; abiHash: Hex };
const [usdArtifact, marketArtifact] = await Promise.all([
  artifact("BlinkTestUSD"),
  artifact("BlinkMarket"),
]);
// Reserve an OS-selected loopback port; this script only ever connects to its own Anvil.
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
    "84532",
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
  id: 84532,
  name: "Blink isolated local REPLAY",
  nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [url] } },
});
const client = createPublicClient({
  chain,
  transport: http(url, { retryCount: 0 }),
  pollingInterval: 10,
});
const mnemonic = "test test test test test test test test test test test junk"; // Public Anvil fixture, never funded/live.
const accounts = Array.from({ length: 7 }, (_, addressIndex) =>
  mnemonicToAccount(mnemonic, { addressIndex }),
);
const [admin, maker, proposer, challenger, arbiter, minter, taker] =
  accounts as [
    (typeof accounts)[number],
    (typeof accounts)[number],
    (typeof accounts)[number],
    (typeof accounts)[number],
    (typeof accounts)[number],
    (typeof accounts)[number],
    (typeof accounts)[number],
    (typeof accounts)[number],
  ];
const wallet = createWalletClient({ chain, transport: http(url) });
const receipt = async (hash: Hex) => {
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("REPLAY_TX_REVERTED: " + hash);
  return r;
};
const write = async (
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  account: typeof admin,
) =>
  receipt(
    await wallet.writeContract({ address, abi, functionName, args, account }),
  );
const read = async (
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
) => client.readContract({ address, abi, functionName, args });
const jump = async (timestamp: bigint) => {
  await client.request({
    method: "evm_setNextBlockTimestamp" as never,
    params: [Number(timestamp)] as never,
  });
  await client.request({ method: "evm_mine" as never });
};
function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected)
    throw new Error(label + ": " + String(actual) + " != " + String(expected));
}
try {
  let ready = false;
  for (let i = 0; i < 100; ++i) {
    if (node.exitCode !== null || nodeError)
      throw new Error(nodeError || "Anvil exited");
    try {
      ready = (await client.getChainId()) === 84532;
      if (ready) break;
    } catch {}
    await delay(50);
  }
  if (!ready) throw new Error("Local Anvil startup timeout");
  equal(await client.getChainId(), 84532, "chain");
  const usdReceipt = await receipt(
    await wallet.deployContract({
      account: admin,
      abi: usdArtifact.abi,
      bytecode: usdArtifact.bytecode,
      args: [minter.address],
    }),
  );
  const usd = usdReceipt.contractAddress!;
  const marketReceipt = await receipt(
    await wallet.deployContract({
      account: admin,
      abi: marketArtifact.abi,
      bytecode: marketArtifact.bytecode,
      args: [
        usd,
        maker.address,
        admin.address,
        proposer.address,
        challenger.address,
        arbiter.address,
      ],
    }),
  );
  const market = marketReceipt.contractAddress!;
  // In-memory manifest for our isolated Anvil only; never registered as a real deployment.
  const trackingManifest: DeploymentManifest = {
    status: "DEPLOYED",
    chainId: 84532,
    deploymentId: "isolated-replay",
    deploymentBlock: String(usdReceipt.blockNumber),
    contracts: { BlinkTestUSD: usd, BlinkMarket: market },
    artifacts: {
      abiHashes: {
        BlinkTestUSD: usdArtifact.abiHash,
        BlinkMarket: marketArtifact.abiHash,
      },
      bytecodeHashes: {
        BlinkTestUSD: keccak256((await client.getCode({ address: usd }))!),
        BlinkMarket: keccak256((await client.getCode({ address: market }))!),
      },
      compiler: "0.8.30",
      gitCommit: "0".repeat(40),
      dependencies: { openzeppelin: "5.6.1" },
    },
    roles: {
      admin: admin.address,
      maker: maker.address,
      resultProposer: proposer.address,
      challenger: challenger.address,
      arbiter: arbiter.address,
      faucetMinter: minter.address,
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
  equal(await read(usd, usdArtifact.abi, "decimals"), 6, "decimals");
  await write(
    usd,
    usdArtifact.abi,
    "mint",
    [maker.address, 1000_000000n],
    minter,
  );
  await write(
    usd,
    usdArtifact.abi,
    "mint",
    [taker.address, 1000_000000n],
    minter,
  );
  await write(usd, usdArtifact.abi, "approve", [market, 1000_000000n], maker);
  await write(
    market,
    marketArtifact.abi,
    "depositMaker",
    [1000_000000n],
    maker,
  );
  await write(
    market,
    marketArtifact.abi,
    "setTakerAllowed",
    [taker.address, true],
    admin,
  );
  const reports = [];
  for (const [index, scenario] of ["normal", "dispute", "timeout"].entries()) {
    const now = (await client.getBlock()).timestamp;
    const closeAt = now + 60n;
    const proposalDeadline = now + 180n;
    const hardDeadline = now + 400n;
    const marketId = BigInt(index + 1);
    const template = JSON.parse(
      await readFile(
        new URL("../fixtures/replay/market-spec.json", import.meta.url),
        "utf8",
      ),
    );
    const frozen = encodeNewSpec(
      {
        ...template,
        schemaVersion: "blink.market.v0.1.1",
        entityId: "fixture-" + scenario,
        closeAt: String(closeAt),
        proposalDeadline: String(proposalDeadline),
        hardDeadline: String(hardDeadline),
        resolutionPolicy: {
          hardDeadlineOutcome: "INVALID",
          unfinalizedProposalAtHardDeadline: "INVALID",
          invalidPayoutRule: "HALF_PER_SIDE_NOT_PURCHASE_REFUND",
          authorityModel: "TEAM_OPERATED_WHITELISTED_ROLES",
        },
      },
      now,
    );
    const specHash = frozen.hash;
    await writeFile(
      new URL(
        "../contracts/artifacts/replay-" + scenario + "-spec.json",
        import.meta.url,
      ),
      frozen.bytes,
    );
    const created = await write(
      market,
      marketArtifact.abi,
      "createMarket",
      [
        specHash,
        "fixture://REPLAY/" + scenario,
        1,
        closeAt,
        proposalDeadline,
        hardDeadline,
        120,
        10000n,
        500n,
      ],
      admin,
    );
    const validAfter = (await client.getBlock()).timestamp;
    const trackingId = "00000000-0000-4000-8000-000000000001";
    const observed = await creationReceiptReader(
      client as PublicClient,
    ).observe(
      {
        manifest: trackingManifest,
        status: untrackedCreation(trackingId),
        intent: {
          creationIntentId: trackingId,
          approvalId: trackingId,
          deploymentId: "isolated-replay",
          state: "AWAITING_ADMIN_SIGNATURE",
          chainId: 84532,
          to: market,
          requiredSender: admin.address,
          value: "0",
          specHash,
          specUri: "fixture://REPLAY/" + scenario,
          calldata: encodeMarketCreation(
            frozen.spec,
            specHash,
            "fixture://REPLAY/" + scenario,
          ),
        },
      },
      created.transactionHash,
    );
    equal(observed.state, "INCLUDED", "creation receipt observed");
    equal(observed.marketId, String(marketId), "creation event marketId");
    console.log(
      "PASS REPLAY creation receipt: " +
        scenario +
        " marketId=" +
        observed.marketId,
    );
    const message = {
      marketId,
      specHash,
      maker: maker.address,
      taker: taker.address,
      side: 0,
      quantity: 100n,
      priceBps: 6000,
      validAfter,
      expiresAt: validAfter + 30n,
      nonce: BigInt(index + 1),
      epoch: 0n,
    };
    const domain = {
      name: "Blink RFQ",
      version: "0.1",
      chainId: 84532,
      verifyingContract: market,
    };
    const typed = {
      domain,
      types: quoteTypes,
      primaryType: "Quote" as const,
      message,
    };
    const digest = hashTypedData(typed);
    equal(
      await read(market, marketArtifact.abi, "hashQuote", [message]),
      digest,
      "TS/Solidity EIP-712 digest",
    );
    const signature = await maker.signTypedData(typed);
    await write(usd, usdArtifact.abi, "approve", [market, 60_000000n], taker);
    const filled = await write(
      market,
      marketArtifact.abi,
      "fillQuote",
      [message, signature],
      taker,
    );
    equal(
      await read(market, marketArtifact.abi, "consumed", [digest]),
      true,
      "digest consumed",
    );
    let finalTx: Hex;
    if (scenario === "timeout") {
      await jump(hardDeadline);
      finalTx = (
        await write(
          market,
          marketArtifact.abi,
          "finalizeTimeout",
          [marketId],
          taker,
        )
      ).transactionHash;
    } else {
      await jump(closeAt);
      await write(
        market,
        marketArtifact.abi,
        "proposeOutcome",
        [marketId, 0, keccak256(new TextEncoder().encode("report"))],
        proposer,
      );
      if (scenario === "dispute") {
        await write(
          market,
          marketArtifact.abi,
          "challengeOutcome",
          [marketId, keccak256(new TextEncoder().encode("challenge"))],
          challenger,
        );
        finalTx = (
          await write(
            market,
            marketArtifact.abi,
            "arbitrate",
            [marketId, 1, keccak256(new TextEncoder().encode("decision"))],
            arbiter,
          )
        ).transactionHash;
      } else {
        const m = (await read(market, marketArtifact.abi, "getMarket", [
          marketId,
        ])) as { proposedAt: bigint; challengeSeconds: number };
        await jump(m.proposedAt + BigInt(m.challengeSeconds));
        finalTx = (
          await write(
            market,
            marketArtifact.abi,
            "finalizeUnchallenged",
            [marketId],
            taker,
          )
        ).transactionHash;
      }
    }
    const beforeT = (await read(usd, usdArtifact.abi, "balanceOf", [
      taker.address,
    ])) as bigint;
    const beforeM = (await read(usd, usdArtifact.abi, "balanceOf", [
      maker.address,
    ])) as bigint;
    await write(market, marketArtifact.abi, "redeem", [marketId], taker);
    await write(market, marketArtifact.abi, "redeem", [marketId], maker);
    const paidT =
      ((await read(usd, usdArtifact.abi, "balanceOf", [
        taker.address,
      ])) as bigint) - beforeT;
    const paidM =
      ((await read(usd, usdArtifact.abi, "balanceOf", [
        maker.address,
      ])) as bigint) - beforeM;
    equal(
      paidT,
      scenario === "normal"
        ? 100_000000n
        : scenario === "dispute"
          ? 0n
          : 50_000000n,
      "taker payout",
    );
    equal(paidM, 100_000000n - paidT, "maker payout");
    const settled = (await read(market, marketArtifact.abi, "getMarket", [
      marketId,
    ])) as { escrowMicros: bigint; finalOutcome: number };
    equal(settled.escrowMicros, 0n, "escrow");
    for (const owner of [maker, taker]) {
      const p = (await read(market, marketArtifact.abi, "getPosition", [
        marketId,
        owner.address,
      ])) as readonly [bigint, bigint];
      equal(p[0] + p[1], 0n, "redeemed positions");
    }
    reports.push({
      mode: "REPLAY",
      scenario,
      marketId: String(marketId),
      quoteId: digest,
      createTx: created.transactionHash,
      fillTx: filled.transactionHash,
      finalTx,
      takerPayoutMicros: String(paidT),
      makerPayoutMicros: String(paidM),
      escrowMicros: "0",
    });
    console.log(
      "PASS REPLAY " +
        scenario +
        ": payouts " +
        paidT +
        "/" +
        paidM +
        " micros; escrow=0",
    );
  }
  equal(
    await read(market, marketArtifact.abi, "makerFreeBalance"),
    880_000000n,
    "maker free",
  );
  const report = {
    status: "LOCAL_REPLAY_ONLY",
    chainId: 84532,
    createdAt: new Date().toISOString(),
    contracts: { BlinkTestUSD: usd, BlinkMarket: market },
    abiHashes: {
      BlinkTestUSD: usdArtifact.abiHash,
      BlinkMarket: marketArtifact.abiHash,
    },
    runtimeBytecodeHashes: {
      BlinkTestUSD: keccak256((await client.getCode({ address: usd }))!),
      BlinkMarket: keccak256((await client.getCode({ address: market }))!),
    },
    scenarios: reports,
  };
  await writeFile(
    new URL("../contracts/artifacts/replay-report.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  if (node.pid && node.exitCode === null) {
    const exited = new Promise<void>((r) => node.once("exit", () => r()));
    node.kill("SIGTERM");
    const timer = setTimeout(() => node.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  }
}
