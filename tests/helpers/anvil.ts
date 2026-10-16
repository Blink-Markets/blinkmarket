import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
// @ts-expect-error Plain JS tool resolver has no declaration file.
import { foundryBinary } from "../../scripts/foundry.mjs";
import type { DeploymentManifest } from "../../packages/schemas/src/index.js";

// Public Anvil fixture mnemonic: never funded on a live network.
const mnemonic = "test test test test test test test test test test test junk";

export type Anvil = Awaited<ReturnType<typeof startAnvil>>;

export async function startAnvil(
  options: {
    chainId?: number;
    baseFee?: bigint;
    receiptTimeoutMs?: number;
  } = {},
) {
  const chainId = options.chainId ?? 84532;
  // Reserve an OS-selected loopback port; this helper only ever connects to its own Anvil.
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
      ...(options.baseFee === undefined
        ? []
        : ["--base-fee", String(options.baseFee), "--gas-price", "1"]),
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
  const killOnExit = () => {
    node.kill("SIGKILL");
  };
  process.once("exit", killOnExit);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      process.off("exit", killOnExit);
      if (node.exitCode !== null || node.signalCode !== null) return;
      const exited = new Promise<void>((r) => node.once("exit", () => r()));
      node.kill("SIGTERM");
      const timer = setTimeout(() => node.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    })());
  const url = "http://127.0.0.1:" + port;
  const chain = defineChain({
    id: chainId,
    name: "Blink local Anvil",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(url, { retryCount: 0 }),
    pollingInterval: 10,
    // Snapshot/revert tests must never read a cached head.
    cacheTime: 0,
  });
  const { receiptTimeoutMs } = options;
  if (receiptTimeoutMs !== undefined) {
    // viem polls a missing receipt for 3 minutes and swallows every error meanwhile, which
    // would keep an abandoned run's process alive after its Anvil is gone. Anvil automines:
    // a receipt that is not there within seconds never will be.
    const waitForReceipt = publicClient.waitForTransactionReceipt;
    publicClient.waitForTransactionReceipt = (args) =>
      waitForReceipt({ timeout: receiptTimeoutMs, ...args });
  }
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; ++i) {
      if (node.exitCode !== null || nodeError)
        throw new Error(nodeError || "Anvil exited");
      try {
        ready = (await publicClient.getChainId()) === chainId;
      } catch {
        await delay(50);
      }
    }
    if (!ready) throw new Error("Local Anvil startup timeout");
  } catch (error) {
    await stop();
    throw error;
  }
  const account = (addressIndex: number) =>
    mnemonicToAccount(mnemonic, { addressIndex });
  const accounts = {
    admin: account(0),
    maker: account(1),
    proposer: account(2),
    challenger: account(3),
    arbiter: account(4),
    minter: account(5),
    taker: account(6),
    taker2: account(7),
    keeper: account(8),
    trader: account(9),
  };
  return {
    url,
    chainId,
    publicClient,
    accounts,
    wallet: (account: LocalAccount) =>
      createWalletClient({ account, chain, transport: http(url) }),
    async snapshot() {
      return (await publicClient.request({
        method: "evm_snapshot" as never,
      })) as unknown as string;
    },
    async revert(id: string) {
      const reverted = await publicClient.request({
        method: "evm_revert" as never,
        params: [id] as never,
      });
      if (reverted !== true) throw new Error("ANVIL_REVERT_FAILED: " + id);
    },
    async mine(blocks = 1) {
      await publicClient.request({
        method: "anvil_mine" as never,
        params: [numberToHex(blocks)] as never,
      });
    },
    // Applies to the next mined block only; the caller mines (or sends a transaction).
    async setNextTimestamp(seconds: bigint) {
      await publicClient.request({
        method: "evm_setNextBlockTimestamp" as never,
        params: [numberToHex(seconds)] as never,
      });
    },
    stop,
  };
}

const artifact = async (name: string) =>
  JSON.parse(
    await readFile(
      new URL("../../contracts/artifacts/" + name + ".json", import.meta.url),
      "utf8",
    ),
  ) as { abi: Abi; bytecode: Hex; abiHash: Hex };

// Deploys the generated artifacts from the admin account and describes them as a manifest
// for this isolated Anvil only; it is never registered as a real deployment.
export async function deployBlink(anvil: Anvil): Promise<{
  market: Address;
  token: Address;
  deploymentBlock: bigint;
  manifest: DeploymentManifest;
}> {
  const [usd, blink] = await Promise.all([
    artifact("BlinkTestUSD"),
    artifact("BlinkMarket"),
  ]);
  const { admin, maker, proposer, challenger, arbiter, minter } =
    anvil.accounts;
  const wallet = anvil.wallet(admin);
  const deploy = async (
    { abi, bytecode }: { abi: Abi; bytecode: Hex },
    args: readonly unknown[],
  ) => {
    const receipt = await anvil.publicClient.waitForTransactionReceipt({
      hash: await wallet.deployContract({ abi, bytecode, args }),
    });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw new Error("ANVIL_DEPLOY_FAILED");
    return receipt;
  };
  const tokenReceipt = await deploy(usd, [minter.address]);
  const token = tokenReceipt.contractAddress!;
  const marketReceipt = await deploy(blink, [
    token,
    maker.address,
    admin.address,
    proposer.address,
    challenger.address,
    arbiter.address,
  ]);
  const market = marketReceipt.contractAddress!;
  const codeHash = async (address: Address) =>
    keccak256((await anvil.publicClient.getCode({ address }))!);
  return {
    market,
    token,
    deploymentBlock: tokenReceipt.blockNumber,
    manifest: {
      status: "DEPLOYED",
      chainId: 84532,
      deploymentId: "local-anvil",
      deploymentBlock: String(tokenReceipt.blockNumber),
      contracts: { BlinkTestUSD: token, BlinkMarket: market },
      artifacts: {
        abiHashes: { BlinkTestUSD: usd.abiHash, BlinkMarket: blink.abiHash },
        bytecodeHashes: {
          BlinkTestUSD: await codeHash(token),
          BlinkMarket: await codeHash(market),
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
      tradingEnabled: true,
    },
  };
}
