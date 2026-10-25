import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import {
  BlinkApiError,
  createBlinkClient,
  verifySignedQuote,
} from "../../packages/client/src/index.ts";
import { contractWalletArtifacts } from "../helpers/contract-wallet.ts";
import {
  protocolAbi,
  quoteStruct,
  startRfqStack,
  type RfqStack,
} from "../helpers/rfq-stack.ts";

const MAKER_DEPOSIT = 100_000_000n;
const QUANTITY = "10";

async function deployWallet(stack: RfqStack, owner: Address) {
  const { wallet } = contractWalletArtifacts();
  const receipt = await stack.anvil.publicClient.waitForTransactionReceipt({
    hash: await stack.anvil
      .wallet(stack.anvil.accounts.admin)
      .deployContract({ abi: wallet.abi, bytecode: wallet.bytecode, args: [owner] }),
  });
  assert.equal(receipt.status, "success");
  return receipt.contractAddress as Address;
}

// admin creates the market, the EOA maker and the wallet maker quote, the taker fills.
async function setup() {
  const stack = await startRfqStack();
  try {
    const { accounts } = stack.anvil;
    await stack.onboard("admin", 0);
    await stack.onboard("maker", 1);
    await stack.onboard("taker", 2);
    await stack.depositMaker("maker", MAKER_DEPOSIT);
    // The wallet maker is owned by `trader` and acts through MockErc1271Wallet.execute.
    const wallet = await deployWallet(stack, accounts.trader.address);
    await stack.onboardWallet(wallet, accounts.trader, 1);
    await stack.write(accounts.trader, wallet, contractWalletArtifacts().wallet.abi, "execute", [
      stack.markets,
      0n,
      encodeFunctionData({ abi: protocolAbi.markets, functionName: "depositMaker", args: [MAKER_DEPOSIT] }),
    ]);
    await stack.stakeJurors();
    const market = await stack.createOpenMarket();
    await stack.sync();
    const key = {
      taker: await stack.keyFor(accounts.taker),
      maker: await stack.keyFor(accounts.maker),
      wallet: await stack.keyFor(accounts.trader, wallet),
    };
    const as = (apiKey: string) => createBlinkClient(stack.apiUrl, apiKey);
    return { stack, accounts, wallet, market, key, as };
  } catch (error) {
    await stack.close();
    throw error;
  }
}
const refusal = (code: string) => (error: unknown) =>
  error instanceof BlinkApiError && error.body.code === code;

test(
  "two makers quote through the relay, the taker fills the best and the indexer marks it consumed",
  { timeout: 300_000 },
  async () => {
    const { stack, accounts, wallet, market, key, as } = await setup();
    try {
      const taker = as(key.taker);
      const rfq = await taker.createRfq({
        marketId: String(market.marketId),
        side: "YES",
        quantity: QUANTITY,
      });
      // The EOA maker asks 4500, the contract-wallet maker 4000.
      const eoaQuote = await stack.quoteFor(market, accounts.maker.address, accounts.taker.address, { priceBps: "4500" });
      const walletQuote = await stack.quoteFor(market, wallet, accounts.taker.address, { priceBps: "4000" });
      const eoaDigest = await as(key.maker).postQuote(rfq.rfqId, {
        quote: eoaQuote,
        signature: await stack.sign(accounts.maker, eoaQuote),
      });
      const walletSignature = await stack.sign(accounts.trader, walletQuote);
      const walletDigest = await as(key.wallet).postQuote(rfq.rfqId, {
        quote: walletQuote,
        signature: walletSignature,
      });
      // Makers see the RFQ; the taker sees both quotes, cheapest first, exactly as posted.
      assert.deepEqual((await as(key.maker).listRfqs()).items.map((r) => r.rfqId), [rfq.rfqId]);
      const quotes = (await taker.listQuotes(rfq.rfqId)).items;
      assert.deepEqual(quotes.map((q) => q.quote.priceBps), ["4000", "4500"]);
      assert.deepEqual(quotes[0]!.quote, walletQuote);
      assert.equal(quotes[0]!.signature, walletSignature);

      // The taker checks the best quote itself, then approves what it can cost and fills on chain.
      const best = quotes[0]!;
      const verified = await verifySignedQuote(best.quote, best.signature as Hex, {
        publicClient: stack.anvil.publicClient,
        deployment: stack.d,
        market: (await stack.publicReader.market(String(market.marketId)))!,
        rfq: { marketId: String(market.marketId), side: "YES", quantity: QUANTITY, taker: accounts.taker.address },
        now: (await stack.anvil.publicClient.getBlock()).timestamp,
        feeBps: stack.d.params.feeBps,
      });
      assert.equal(verified.digest, walletDigest.digest);
      assert.notEqual(verified.digest, eoaDigest.digest);
      assert.equal(verified.maxCost, 4_040_000n);
      await stack.write(accounts.taker, stack.d.shared.busd, erc20Abi, "approve", [stack.markets, verified.maxCost]);
      await stack.write(accounts.taker, stack.markets, protocolAbi.markets, "fillQuote", [
        quoteStruct(best.quote),
        best.signature,
      ]);

      await stack.sync();
      assert.equal(await stack.publicReader.digest(walletDigest.digest), "CONSUMED");
      assert.equal(await stack.publicReader.digest(eoaDigest.digest), "UNUSED");
      assert.deepEqual(await as(key.taker).getMakerStats(wallet), {
        quotesRelayed: 1,
        quotesFilled: 1,
        quotesCancelledBeforeExpiry: 0,
      });
      assert.deepEqual(await as(key.taker).getMakerStats(accounts.maker.address), {
        quotesRelayed: 1,
        quotesFilled: 0,
        quotesCancelledBeforeExpiry: 0,
      });
      // A fill is final for the digest: the relay refuses to carry the same quote again.
      const other = await taker.createRfq({
        marketId: String(market.marketId),
        side: "YES",
        quantity: QUANTITY,
      });
      await assert.rejects(
        as(key.wallet).postQuote(other.rfqId, { quote: walletQuote, signature: walletSignature }),
        refusal("QUOTE_CONSUMED"),
      );
    } finally {
      await stack.close();
    }
  },
);

test(
  "relay and BlinkMarkets agree on contract-wallet quotes",
  { timeout: 300_000 },
  async () => {
    const { stack, accounts, wallet, market, key, as } = await setup();
    try {
      const rfq = await as(key.taker).createRfq({
        marketId: String(market.marketId),
        side: "YES",
        quantity: QUANTITY,
      });
      const fill = (q: Awaited<ReturnType<typeof stack.quoteFor>>, signature: Hex) =>
        stack.anvil.publicClient.simulateContract({
          account: accounts.taker,
          address: stack.markets,
          abi: protocolAbi.markets,
          functionName: "fillQuote",
          args: [quoteStruct(q), signature],
        } as never);

      // Signed by the wallet's owner: the relay takes it and the contract would fill it.
      const good = await stack.quoteFor(market, wallet, accounts.taker.address);
      const goodSignature = await stack.sign(accounts.trader, good);
      await as(key.wallet).postQuote(rfq.rfqId, { quote: good, signature: goodSignature });
      await fill(good, goodSignature);

      // Signed by someone who does not own the wallet: the relay refuses it and the contract reverts.
      const forged = await stack.quoteFor(market, wallet, accounts.taker.address, { nonce: "99" });
      const forgedSignature = await stack.sign(accounts.taker2, forged);
      const other = await as(key.taker).createRfq({
        marketId: String(market.marketId),
        side: "YES",
        quantity: QUANTITY,
      });
      await assert.rejects(
        as(key.wallet).postQuote(other.rfqId, { quote: forged, signature: forgedSignature }),
        refusal("INVALID_QUOTE_SIGNATURE"),
      );
      await assert.rejects(fill(forged, forgedSignature), /InvalidSignature/);
      assert.deepEqual((await as(key.taker).listQuotes(other.rfqId)).items, []);

      // An ERC-6492 wrapper is not a signature the contract accepts, so the relay refuses it too.
      const wrapped = (goodSignature + "6492".repeat(16)) as Hex;
      await assert.rejects(
        as(key.wallet).postQuote(other.rfqId, { quote: good, signature: wrapped }),
        refusal("INVALID_QUOTE_SIGNATURE"),
      );
      await assert.rejects(fill(good, wrapped), /InvalidSignature|reverted/);
    } finally {
      await stack.close();
    }
  },
);
