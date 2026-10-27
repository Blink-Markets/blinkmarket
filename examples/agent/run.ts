// A taker agent on the local stack: claim test bUSD, register, join TAKER, get an API key by wallet
// proof, post an RFQ, verify the quotes makers send back, approve exactly what the best one can
// cost, fill it on chain, wait for the market to be FINAL and redeem. Base Sepolia chain ID 84532
// only, and only against a local node: the key never goes near a remote RPC.
//
//   BLINK_API_URL=... AGENT_PRIVATE_KEY=0x... RPC_URL=http://127.0.0.1:8545 \
//     node --import tsx examples/agent/run.ts
//
// The platform only relays RFQs and quotes. It never quotes, signs or fills: this agent verifies a
// quote itself and sends the fill itself. An agent outside this repository imports the same names
// from "@blink/client".
import { pathToFileURL } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BlinkApiError,
  QuoteVerificationError,
  ROLE,
  agentAbi,
  createBlinkClient,
  verifySignedQuote,
} from "@blink/client";

const CHAIN_ID = 84532;
const MAINNET_CHAIN_ID = 8453;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const QUANTITY = "10";
const MAX_RFQ_ATTEMPTS = 3;
const UNIT = 1_000_000n;

export type AgentConfig = {
  apiUrl: string;
  privateKey: Hex;
  rpcUrl: string;
  /** The market to trade; by default the first OPEN market the API lists. */
  marketId?: string;
  side?: "YES" | "NO";
  log?: (line: string) => void;
  /** Delay between polls of the API and the chain. */
  pollMs?: number;
  /** How long to wait for the index, for quotes, for FINAL and for a receipt. */
  waitMs?: {
    indexing?: number;
    quotes?: number;
    final?: number;
    receipt?: number;
    /** How long to wait for an uncertain fill to settle before giving up (it is never resent). */
    settle?: number;
  };
};
export type AgentResult = {
  marketId: string;
  digest: string;
  /** Empty when the fill landed but this process lost its hash. */
  fillTxHash: string;
  redeemTxHash: string;
  finalOutcome: string;
  payoutMicros: string;
};

/** Reads the three environment variables; the key is only ever passed on to the wallet. */
export function configFromEnv(env: NodeJS.ProcessEnv): AgentConfig {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name}`);
    return value;
  };
  return {
    apiUrl: need("BLINK_API_URL"),
    privateKey: need("AGENT_PRIVATE_KEY") as Hex,
    rpcUrl: need("RPC_URL"),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRefusal = (error: unknown, ...codes: string[]) =>
  error instanceof BlinkApiError && codes.includes(error.body.code);

export async function runAgent(config: AgentConfig): Promise<AgentResult> {
  const log = config.log ?? ((line: string) => console.log(line));
  const pollMs = config.pollMs ?? 1000;
  const waits = {
    indexing: config.waitMs?.indexing ?? 120_000,
    quotes: config.waitMs?.quotes ?? 20_000,
    final: config.waitMs?.final ?? 600_000,
    receipt: config.waitMs?.receipt ?? 180_000,
    settle: config.waitMs?.settle ?? 180_000,
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
  /** A transaction of this wallet, waited for; a revert is an error. */
  async function send(
    what: string,
    request: Parameters<typeof wallet.writeContract>[0],
  ) {
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: waits.receipt,
    });
    if (receipt.status !== "success") throw new Error(`${what}_REVERTED`);
    return receipt;
  }

  // 1. The generation: everything below trusts this manifest and nothing a quote says about itself.
  const anonymous = createBlinkClient(config.apiUrl);
  const { deployment } = await anonymous.getDeployment();
  if (deployment.chainId !== CHAIN_ID)
    throw new Error("DEPLOYMENT_CHAIN_MISMATCH");
  const { params, shared, generation } = deployment;
  const busd = shared.busd as Hex;
  const registry = generation.registry as Hex;
  const markets = generation.markets as Hex;
  const side = config.side ?? "YES";

  // 2. Test bUSD, registration and the TAKER role, all on chain from this wallet.
  const quantity = BigInt(QUANTITY);
  const stake = BigInt(params.minRoleStake);
  const fee = BigInt(params.registrationFee);
  const balance = () =>
    publicClient.readContract({
      address: busd,
      abi: agentAbi.usd,
      functionName: "balanceOf",
      args: [account.address],
    });
  // The most one fill can cost: all shares at nearly a dollar, plus the fee.
  const worstFill = quantity * UNIT + (quantity * UNIT * BigInt(params.feeBps)) / 10_000n;
  if ((await balance()) < fee + stake + worstFill) {
    await send("FAUCET_CLAIM", {
      address: shared.faucet as Hex,
      abi: agentAbi.faucet,
      functionName: "claim",
    });
    log("claimed test bUSD from the faucet");
  }
  const registryRead = (functionName: "isRegistered" | "hasRole", args: never) =>
    publicClient.readContract({
      address: registry,
      abi: agentAbi.registry,
      functionName,
      args,
    } as never) as Promise<boolean>;
  if (!(await registryRead("isRegistered", [account.address] as never))) {
    await send("APPROVE_FEE", {
      address: busd,
      abi: agentAbi.usd,
      functionName: "approve",
      args: [registry, fee],
    });
    await send("REGISTER", {
      address: registry,
      abi: agentAbi.registry,
      functionName: "register",
    });
    log("registered");
  }
  if (!(await registryRead("hasRole", [account.address, ROLE.TAKER] as never))) {
    await send("APPROVE_STAKE", {
      address: busd,
      abi: agentAbi.usd,
      functionName: "approve",
      args: [registry, stake],
    });
    await send("JOIN_TAKER", {
      address: registry,
      abi: agentAbi.registry,
      functionName: "joinRole",
      args: [ROLE.TAKER, stake],
    });
    log("joined the TAKER role");
  }

  // 3. An API key by wallet proof. The API issues one only once its index has seen the registration,
  //    so a not-yet-indexed wallet is retried with a fresh challenge and a growing pause.
  let client = anonymous;
  for (let attempt = 0, pause = pollMs; ; attempt++, pause *= 2) {
    try {
      const challenge = await anonymous.createWalletChallenge({
        address,
        action: "issue",
      });
      const issued = await anonymous.verifyWallet({
        challengeId: challenge.challengeId,
        signature: await account.signMessage({ message: challenge.message }),
      });
      if (!("apiKey" in issued)) throw new Error("NO_API_KEY_ISSUED");
      client = createBlinkClient(config.apiUrl, issued.apiKey);
      break;
    } catch (error) {
      if (!isRefusal(error, "NOT_REGISTERED", "INDEX_STALE") || attempt >= 6)
        throw error;
      await sleep(Math.min(pause, 30_000));
    }
  }
  log("got an API key");

  // 4. The market to trade.
  const open = config.marketId
    ? undefined
    : await until("an OPEN market", waits.indexing, async () => {
        const now = Number(await chainSeconds());
        const page = await client.listMarkets({ state: "OPEN", limit: 100 });
        return page.items.find((i) => i.market.closeAt > now)?.market;
      });
  const { market } = await client.getMarket({
    marketId: config.marketId ?? open!.marketId,
  });
  const marketId = market.marketId;
  log(`trading market ${marketId}`);

  const consumedNow = (digest: Hex) =>
    publicClient.readContract({
      address: markets,
      abi: agentAbi.markets,
      functionName: "consumed",
      args: [digest],
    });
  /**
   * Sends one fill and returns only when its outcome is known. A reverted receipt, or a rejection
   * before broadcast, is a definitive miss. If the answer is lost or the receipt does not come, the
   * transaction may still be pending, so nothing is resent and no replacement RFQ is made until a
   * receipt arrives, `consumed(digest)` shows the fill, or chain time has passed the quote's expiry
   * and the digest is then still unused (a block at or after expiry cannot include the fill).
   */
  async function sendFill(
    quote: Record<string, unknown>,
    signature: Hex,
    digest: Hex,
  ): Promise<{ landed: true; txHash: string } | { landed: false; reason: string }> {
    let txHash: Hex | undefined;
    try {
      txHash = await wallet.writeContract({
        address: markets,
        abi: agentAbi.markets,
        functionName: "fillQuote",
        args: [quote, signature],
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: waits.receipt,
      });
      return receipt.status === "success"
        ? { landed: true, txHash }
        : { landed: false, reason: "FILL_REVERTED" };
    } catch (error) {
      // The node refused it before broadcasting (the call would revert): nothing is pending.
      if (
        txHash === undefined &&
        error instanceof BaseError &&
        error.walk((e) => e instanceof ContractFunctionRevertedError)
      )
        return { landed: false, reason: "FILL_REJECTED_BEFORE_SEND" };
      log(`fill outcome unknown: ${error instanceof Error ? error.message : error}`);
    }
    const expiresAt = quote["expiresAt"] as bigint;
    return until("the fill's outcome", waits.settle, async () => {
      if (txHash !== undefined) {
        const receipt = await publicClient
          .getTransactionReceipt({ hash: txHash })
          .catch(() => undefined);
        if (receipt)
          return receipt.status === "success"
            ? { landed: true as const, txHash }
            : { landed: false as const, reason: "FILL_REVERTED" };
      }
      // Chain time first, then the digest: a fill that lands in between is found, and expiry is
      // concluded only when the digest is still unused after the clock has passed it.
      const now = await chainSeconds();
      if (await consumedNow(digest))
        return { landed: true as const, txHash: txHash ?? "" };
      return now >= expiresAt
        ? { landed: false as const, reason: "QUOTE_EXPIRED_UNUSED" }
        : undefined;
    });
  }

  // 5. RFQ, verify, approve, fill. A quote that expires or is taken first is replaced by a new RFQ.
  let digest: Hex | undefined;
  let fillTxHash = "";
  for (let attempt = 1; digest === undefined; attempt++) {
    if (attempt > MAX_RFQ_ATTEMPTS) throw new Error("NO_USABLE_QUOTE");
    const rfq = await until("the RFQ to be accepted", waits.indexing, async () => {
      try {
        return await client.createRfq({ marketId, side, quantity: QUANTITY });
      } catch (error) {
        // The TAKER role may not be indexed yet.
        if (isRefusal(error, "ROLE_REQUIRED", "INDEX_STALE")) return undefined;
        throw error;
      }
    });
    log(`posted RFQ ${rfq.rfqId}`);
    const verifyAll = async (minValiditySeconds?: bigint) => {
      const now = await chainSeconds();
      const verified = [];
      for (const { quote, signature } of (await client.listQuotes(rfq.rfqId)).items) {
        try {
          verified.push({
            quote,
            signature: signature as Hex,
            ...(await verifySignedQuote(quote, signature as Hex, {
              publicClient,
              deployment,
              market,
              rfq: { marketId, side, quantity: QUANTITY, taker: address },
              now,
              feeBps: params.feeBps,
              minValiditySeconds,
            })),
          });
        } catch (error) {
          if (!(error instanceof QuoteVerificationError)) throw error;
          log(`ignored a quote from ${quote.maker}: ${error.code}`);
        }
      }
      return verified;
    };
    // Quotes arrive while the RFQ is open (30 seconds); the API lists them cheapest first.
    const best = await until("a verified quote", waits.quotes, async () => (await verifyAll())[0]).catch(
      () => undefined,
    );
    if (!best) continue;
    // The approval covers the cost and the fee, never more.
    await send("APPROVE_FILL", {
      address: busd,
      abi: agentAbi.usd,
      functionName: "approve",
      args: [markets, best.maxCost],
    });
    // The quote must still be usable and unused now that the approval has landed.
    const stillGood = (await verifyAll(1n)).find((v) => v.digest === best.digest);
    if (!stillGood || (await consumedNow(best.digest))) continue;
    const q = best.quote;
    const fill = await sendFill(
      {
        marketId: BigInt(q.marketId),
        specHash: q.specHash as Hex,
        maker: q.maker as Hex,
        taker: q.taker as Hex,
        side: Number(q.side),
        quantity: BigInt(q.quantity),
        priceBps: Number(q.priceBps),
        validAfter: BigInt(q.validAfter),
        expiresAt: BigInt(q.expiresAt),
        nonce: BigInt(q.nonce),
        epoch: BigInt(q.epoch),
      },
      best.signature,
      best.digest,
    );
    if (!fill.landed) {
      log(`fill did not land: ${fill.reason}`);
      continue;
    }
    fillTxHash = fill.txHash;
    digest = best.digest;
    log(`filled ${QUANTITY} ${side} shares at ${best.quote.priceBps} bps`);
  }

  // 6. Wait for the market to settle, then redeem.
  const finalOutcome = await until("FINAL", waits.final, async () => {
    const { market: m } = await client.getMarket({ marketId });
    return m.state === "FINAL" ? (m.finalOutcome ?? "INVALID") : undefined;
  });
  const redeemed = await send("REDEEM", {
    address: markets,
    abi: agentAbi.markets,
    functionName: "redeem",
    args: [BigInt(marketId)],
  });
  let payoutMicros = "0";
  for (const entry of redeemed.logs) {
    try {
      const event = decodeEventLog({ abi: agentAbi.markets, ...entry });
      if (event.eventName === "PositionRedeemed")
        payoutMicros = event.args.payout.toString();
    } catch {
      // Not an event of the markets ABI.
    }
  }
  log(`redeemed ${payoutMicros} micro-bUSD`);
  return {
    marketId,
    digest,
    fillTxHash,
    redeemTxHash: redeemed.transactionHash,
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
