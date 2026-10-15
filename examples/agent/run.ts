// An external agent on the local stack: bind a wallet, forecast, get test bUSD, buy shares with a
// verified RFQ, wait for the market to finalize, and redeem. Base Sepolia chain ID 84532 only, and
// only against a local node: the key never goes near a remote RPC.
//
//   BLINK_API_URL=... BLINK_API_KEY=... AGENT_PRIVATE_KEY=0x... RPC_URL=http://127.0.0.1:8545 \
//     node --import tsx examples/agent/run.ts
//
// An agent outside this repository imports the same names from "@blink/client".
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BlinkApiError,
  QuoteVerificationError,
  createBlinkClient,
  verifySignedQuote,
} from "../../packages/client/src/index.ts";

const CHAIN_ID = 84532;
const MAINNET_CHAIN_ID = 8453;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const QUANTITY = "10";
// The most this agent pays for one share, in micro-bUSD: the API refuses a dearer quote.
const MAX_COST_PER_SHARE_MICROS = 900_000n;
const MAX_QUOTE_ATTEMPTS = 3;

// Just what a taker calls on the bUSD token and the market.
const tokenAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const marketAbi = parseAbi([
  "function consumed(bytes32 digest) view returns (bool)",
  "function redeem(uint256 id)",
]);

export type AgentConfig = {
  apiUrl: string;
  apiKey: string;
  privateKey: Hex;
  rpcUrl: string;
  log?: (line: string) => void;
  /** Delay between polls of the API and the chain. */
  pollMs?: number;
  /** How long to wait for the faucet credit, for the API to index a transaction, and for FINAL. */
  waitMs?: { faucet?: number; indexing?: number; final?: number };
};
export type AgentResult = {
  marketId: string;
  quoteId: string;
  /** Empty when the fill landed but this process lost its hash. */
  fillTxHash: string;
  redeemTxHash: string;
  finalOutcome: string;
  payoutMicros: string;
};

/** Reads the four environment variables; the key is only ever passed on to the wallet. */
export function configFromEnv(env: NodeJS.ProcessEnv): AgentConfig {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name}`);
    return value;
  };
  return {
    apiUrl: need("BLINK_API_URL"),
    apiKey: need("BLINK_API_KEY"),
    privateKey: need("AGENT_PRIVATE_KEY") as Hex,
    rpcUrl: need("RPC_URL"),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function runAgent(config: AgentConfig): Promise<AgentResult> {
  const log = config.log ?? ((line: string) => console.log(line));
  const pollMs = config.pollMs ?? 1000;
  const waits = {
    faucet: config.waitMs?.faucet ?? 120_000,
    indexing: config.waitMs?.indexing ?? 120_000,
    final: config.waitMs?.final ?? 600_000,
  };
  // The key signs transactions: refuse any node that is not on this machine.
  if (!LOOPBACK.includes(new URL(config.rpcUrl).hostname))
    throw new Error(
      "RPC_NOT_LOOPBACK: this example only talks to a local node",
    );

  const chain = defineChain({
    id: CHAIN_ID,
    name: "Blink local",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl, { retryCount: 0 }),
    pollingInterval: pollMs,
    cacheTime: 0,
  });
  const nodeChainId = await publicClient.getChainId();
  if (nodeChainId === MAINNET_CHAIN_ID)
    throw new Error("MAINNET_REFUSED: this node is chain ID 8453");
  if (nodeChainId !== CHAIN_ID)
    throw new Error("RPC_CHAIN_MISMATCH: expected chain ID 84532");
  const account = privateKeyToAccount(config.privateKey);
  const wallet = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl, { retryCount: 0 }),
  });
  const client = createBlinkClient(config.apiUrl, config.apiKey);
  const address = account.address.toLowerCase();

  async function until<T>(
    what: string,
    timeoutMs: number,
    probe: () => Promise<T | undefined>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() >= deadline)
        throw new Error(`TIMEOUT waiting for ${what}`);
      await sleep(pollMs);
    }
  }
  /** Chain time, never this machine's clock: quotes expire by block timestamp. */
  const chainSeconds = async () =>
    (await publicClient.getBlock({ blockTag: "latest" })).timestamp;

  // 1. The deployment: everything below trusts this and nothing a quote says about itself.
  const publicConfig = await client.getConfig();
  const deployment = publicConfig.deployment;
  if (!deployment) throw new Error("NO_DEPLOYMENT: the API has no deployment");
  const trusted = { ...publicConfig, deployment };
  const deploymentId = deployment.deploymentId;
  const marketAddress = deployment.contracts.BlinkMarket as Hex;
  const tokenAddress = deployment.contracts.BlinkTestUSD as Hex;
  log(
    `deployment ${deploymentId} on chain ${publicConfig.chainId}, trading ${publicConfig.tradingEnabled}`,
  );

  // 2. Bind this wallet to the API key's agent (a second run finds it bound already).
  try {
    const challenge = await client.createWalletChallenge({ address });
    await client.verifyWallet({
      challengeId: challenge.challengeId,
      signature: await account.signMessage({ message: challenge.message }),
    });
    log(`wallet ${address} bound`);
  } catch (error) {
    if (!(
      error instanceof BlinkApiError &&
      error.body.code === "WALLET_ALREADY_BOUND"
    ))
      throw error;
    log("wallet already bound");
  }

  // 3. A market that can trade, and its spec checked against the hash the market list gave.
  const markets = await client.listMarkets({ deploymentId, status: "OPEN" });
  const market = markets.items.find((m) => m.canTrade);
  if (!market) throw new Error("NO_TRADABLE_MARKET");
  const ref = { deploymentId, marketId: market.marketId };
  const spec = await client.getMarketSpec(ref, market.specHash);
  log(
    `market ${market.marketId} (${spec.entityId} ${spec.fiscalPeriod}) spec verified`,
  );

  // 4. A forecast in the window that is open now, if there is one and this agent has not used it.
  const windows = await client.listForecastWindows(ref);
  const open = windows.items.find((w) => w.status === "OPEN");
  const evidenceIds = spec.sourceEvidenceIds.filter(isUuid);
  if (open && evidenceIds.length > 0) {
    try {
      // A real agent forms this probability from the evidence; the example only shows the call.
      await client.submitForecast(ref, {
        horizonKey: open.horizonKey,
        probability: 0.6,
        evidenceIds,
        rationale:
          "Example agent: fixed probability, not derived from evidence.",
        agentVersion: "example-agent/0.1",
      });
      log(`forecast submitted for window ${open.windowId}`);
    } catch (error) {
      if (!(
        error instanceof BlinkApiError &&
        error.body.code === "FORECAST_ALREADY_SUBMITTED"
      ))
        throw error;
      log("forecast already submitted for this window");
    }
  } else log("no open forecast window with usable evidence; forecast skipped");

  // 5. Test bUSD from the faucet, unless the wallet already holds enough for the purchase.
  const budget = BigInt(QUANTITY) * MAX_COST_PER_SHARE_MICROS;
  const balance = () =>
    publicClient.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account.address],
    });
  if ((await balance()) < budget) {
    try {
      await client.claimFaucet({ deploymentId });
      log("faucet claim queued");
    } catch (error) {
      // A claim made in the last 24 hours is paid or still pending: wait for its credit instead.
      if (!(
        error instanceof BlinkApiError &&
        ["FAUCET_PENDING", "RATE_LIMITED"].includes(error.body.code)
      ))
        throw error;
      log(`faucet answered ${error.body.code}; waiting for the balance`);
    }
    await until("the faucet credit", waits.faucet, async () =>
      (await balance()) >= budget ? true : undefined,
    );
  }
  log(`balance ${await balance()} micro-bUSD`);

  // 6. RFQ, verify, approve exactly, fill. An expired quote is requoted under a new key.
  const request = {
    deploymentId,
    marketId: market.marketId,
    side: "YES",
    quantity: QUANTITY,
    maxCostMicros: String(budget),
  } as const;
  type Quote = Awaited<ReturnType<typeof client.requestQuote>>;
  /**
   * Throws QuoteVerificationError on the first thing wrong with the quote, by chain time. By
   * default the quote must also have room left for an approval and a fill; `minValiditySeconds: 0n`
   * asks only whether it has really expired.
   */
  const verify = async (quote: Quote, minValiditySeconds?: bigint) =>
    verifySignedQuote(quote, {
      config: trusted,
      wallet: address,
      request,
      nowSeconds: await chainSeconds(),
      minValiditySeconds,
    });
  const isConsumed = (quote: Quote) =>
    publicClient.readContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: "consumed",
      args: [quote.quoteId as Hex],
    });
  /**
   * Sends the verified calldata, once. It reads consumed(digest) first. If the outcome of the send
   * is unknown (the answer was lost, the receipt never came) it is never sent again: it waits
   * until consumed(digest) says the fill landed, or the quote expires by chain time (then the
   * next quote is a different one). Returns the hash, or undefined when the fill landed but this
   * process never saw its hash.
   */
  async function fill(quote: Quote): Promise<Hex | undefined> {
    if (await isConsumed(quote))
      throw new Error("QUOTE_CONSUMED: filled before this agent sent it");
    await verify(quote);
    // A fill that would revert is refused here, so a failure after this point is an unknown outcome.
    await publicClient
      .call({ account, to: marketAddress, data: quote.calldata as Hex })
      .catch((error: { shortMessage?: string }) => {
        throw new Error("FILL_WOULD_REVERT: " + (error.shortMessage ?? error));
      });
    let sent: Hex | undefined;
    try {
      sent = await wallet.sendTransaction({
        to: marketAddress,
        data: quote.calldata as Hex,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: sent,
      });
      if (receipt.status === "success") {
        log(`fill ${sent} included in block ${receipt.blockNumber}`);
        return sent;
      }
      // Reverted: if the quote really ran out meanwhile this throws EXPIRED, otherwise it is a real failure.
      await verify(quote, 0n);
      throw new Error("FILL_REVERTED: " + sent);
    } catch (error) {
      if (error instanceof QuoteVerificationError) throw error;
      if (error instanceof Error && error.message.startsWith("FILL_REVERTED"))
        throw error;
      const why =
        (error as { shortMessage?: string }).shortMessage ?? String(error);
      log(`fill outcome unknown (${why}); not sending it again`);
    }
    for (;;) {
      if (await isConsumed(quote)) return sent;
      // Only real expiry ends the wait: until then the fill may still land, and a requote could
      // buy twice.
      await verify(quote, 0n);
      await sleep(pollMs);
    }
  }
  async function buy() {
    // A new Idempotency-Key per quote; a retry of the same RFQ would reuse it.
    const quote = await client.requestQuote(request, crypto.randomUUID());
    await verify(quote);
    if (quote.message.specHash.toLowerCase() !== market!.specHash.toLowerCase())
      throw new Error("QUOTE_SPEC_MISMATCH: the quote is for another spec");
    log(
      `quote ${quote.quoteId} verified: ${QUANTITY} YES for ${quote.takerCostMicros} micro-bUSD, expires ${quote.expiresAt}`,
    );
    // Exactly the cost: the market can pull no more than this quote's price.
    const approval = await wallet.writeContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: "approve",
      args: [marketAddress, BigInt(quote.takerCostMicros)],
    });
    const approved = await publicClient.waitForTransactionReceipt({
      hash: approval,
    });
    if (approved.status !== "success")
      throw new Error("APPROVE_REVERTED: " + approval);
    await client.trackTransaction({
      deploymentId,
      txHash: approval,
      action: "APPROVE",
    });
    log(`approved ${quote.takerCostMicros} micro-bUSD in ${approval}`);
    return { quote, fillTxHash: await fill(quote) };
  }
  // A quote that ran out, or that this node's chain view has not reached yet (a lagging node):
  // either way the answer is a new quote under a new key.
  const isExpiry = (error: unknown) =>
    (error instanceof QuoteVerificationError &&
      (error.code === "EXPIRED" || error.code === "NOT_YET_VALID")) ||
    (error instanceof BlinkApiError &&
      (error.body.code === "QUOTE_EXPIRED" ||
        error.body.details["reason"] === "QUOTE_EXPIRED"));
  let bought: Awaited<ReturnType<typeof buy>> | undefined;
  for (let attempt = 1; !bought; attempt++) {
    try {
      bought = await buy();
    } catch (error) {
      if (!isExpiry(error) || attempt >= MAX_QUOTE_ATTEMPTS) throw error;
      log(
        "quote expired before it was filled; asking for a new one under a new key",
      );
      await sleep(pollMs);
    }
  }
  const { quote, fillTxHash } = bought;

  // 7. Tell the API about the fill, then watch the transaction and the position it created.
  if (fillTxHash) {
    await client.trackTransaction({
      deploymentId,
      txHash: fillTxHash,
      action: "FILL",
      quoteId: quote.quoteId,
    });
    await until("the fill to be indexed", waits.indexing, async () => {
      const tx = await client.getTransaction({
        deploymentId,
        txHash: fillTxHash,
      });
      if (tx.status === "REVERTED" || tx.status === "REORGED")
        throw new Error(`FILL_${tx.status}: ${fillTxHash}`);
      return tx.status === "INCLUDED" || tx.status === "FINALIZED"
        ? tx
        : undefined;
    });
  }
  const holding = () =>
    client
      .getPositions({ deploymentId, address })
      .then((positions) =>
        positions.items.find((p) => p.marketId === market.marketId),
      );
  await until("the position", waits.indexing, async () => {
    const position = await holding();
    return position && BigInt(position.yesShares) >= BigInt(QUANTITY)
      ? position
      : undefined;
  });
  log(`position: ${QUANTITY} YES shares in market ${market.marketId}`);

  // 8. The market finalizes on its own (the keeper); then the position pays out.
  const resolved = await until(
    "the market to be FINAL",
    waits.final,
    async () => {
      const resolution = await client.getResolution(ref);
      return resolution.finalOutcome === null ? undefined : resolution;
    },
  );
  const finalOutcome = resolved.finalOutcome!;
  log(`market final: ${finalOutcome}`);
  const payoutMicros = (await holding())?.payoutMicros ?? "0";
  const redeemTxHash = await wallet.writeContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: "redeem",
    args: [BigInt(market.marketId)],
  });
  await publicClient.waitForTransactionReceipt({ hash: redeemTxHash });
  await client.trackTransaction({
    deploymentId,
    txHash: redeemTxHash,
    action: "REDEEM",
  });
  log(`redeemed in ${redeemTxHash}: ${payoutMicros} micro-bUSD`);

  return {
    marketId: market.marketId,
    quoteId: quote.quoteId,
    fillTxHash: fillTxHash ?? "",
    redeemTxHash,
    finalOutcome,
    payoutMicros,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(await runAgent(configFromEnv(process.env)), null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
