import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData, verifyTypedData, type Hex } from "viem";
import {
  DEFAULT_MIN_VALIDITY_SECONDS,
  QuoteVerificationError,
  approvalFor,
  verifySignedQuote,
  type QuoteVerificationCode,
  type QuoteVerificationContext,
} from "../packages/client/src/index.js";
import { quoteTypes, type QuoteFields } from "../packages/schemas/src/index.js";
import { testAccounts } from "./helpers/protocol-fixture.js";
import { hash, protocolManifest } from "./helpers/protocol-index.js";

// Every quote here is signed offline with a public Anvil development key.
const deployment = protocolManifest("client-verify");
const MARKETS = deployment.generation.markets as Hex;
const SPEC_HASH = hash(77);
const NOW = 1010n;
const FEE_BPS = 100;
const taker = testAccounts.taker.address.toLowerCase();
const makerKey = testAccounts.maker;

const baseQuote: QuoteFields = {
  marketId: "1",
  specHash: SPEC_HASH,
  maker: makerKey.address.toLowerCase(),
  taker,
  side: "0",
  quantity: "10",
  priceBps: "4000",
  validAfter: "1000",
  expiresAt: "1030",
  nonce: "7",
  epoch: "3",
};
const messageOf = (q: QuoteFields) => ({
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
});
const typed = (
  q: QuoteFields,
  domain: { version?: string; verifyingContract?: Hex } = {},
) => ({
  domain: {
    name: "Blink RFQ",
    version: domain.version ?? "0.2",
    chainId: 84532,
    verifyingContract: domain.verifyingContract ?? MARKETS,
  },
  types: quoteTypes,
  primaryType: "Quote" as const,
  message: messageOf(q),
});
const sign = (q: QuoteFields, signer = makerKey, domain = {}) =>
  signer.signTypedData(typed(q, domain));

// EOAs have no code and are verified by recovery; the wallet below has code and its own rule.
const eoaClient = {
  getCode: async () => undefined,
  verifyTypedData: (args: unknown) =>
    verifyTypedData(args as Parameters<typeof verifyTypedData>[0]),
} as unknown as QuoteVerificationContext["publicClient"];

const ctx = (
  patch: Partial<QuoteVerificationContext> = {},
): QuoteVerificationContext => ({
  publicClient: eoaClient,
  deployment,
  market: { marketId: "1", specHash: SPEC_HASH, closeAt: 2000 },
  rfq: { marketId: "1", side: "YES", quantity: "10", taker },
  now: NOW,
  feeBps: FEE_BPS,
  ...patch,
});
async function refused(
  code: QuoteVerificationCode,
  quote: QuoteFields,
  signature: Hex,
  context = ctx(),
) {
  await assert.rejects(
    verifySignedQuote(quote, signature, context),
    (error: unknown) =>
      error instanceof QuoteVerificationError && error.code === code,
    code,
  );
}

test("verifySignedQuote requires fee-inclusive maxCost", async () => {
  const signature = await sign(baseQuote);
  const verified = await verifySignedQuote(baseQuote, signature, ctx());
  // 10 shares at 4000 bps cost 4_000_000; the 1% fee is charged on top, so the approval is 4_040_000.
  assert.equal(verified.takerCost, 4_000_000n);
  assert.equal(verified.fee, 40_000n);
  assert.equal(verified.maxCost, 4_040_000n);
  assert.equal(approvalFor(baseQuote, FEE_BPS), 4_040_000n);
  // The digest is the EIP-712 hash BlinkMarkets records.
  assert.equal(verified.digest, hashTypedData(typed(baseQuote)));
  // The fee rounds down, as the contract does; an approval of the cost alone is never enough.
  const odd = { ...baseQuote, quantity: "3", priceBps: "3333" };
  assert.equal(approvalFor(odd, FEE_BPS), 999_900n + 9_999n);
  assert.ok(approvalFor(baseQuote, 0) < approvalFor(baseQuote, FEE_BPS));
});

test("rejects domain 0.1", async () => {
  // A signature over the retired 0.1 domain, or over another contract's domain, is not a quote.
  await refused("SIGNATURE_INVALID", baseQuote, await sign(baseQuote, makerKey, { version: "0.1" }));
  await refused(
    "SIGNATURE_INVALID",
    baseQuote,
    await sign(baseQuote, makerKey, { verifyingContract: ("0x" + "22".repeat(20)) as Hex }),
  );
});

test("rejects maker mismatch", async () => {
  const signature = await sign(baseQuote);
  // The taker meant to deal with someone else.
  await refused("MAKER_MISMATCH", baseQuote, signature, ctx({ maker: testAccounts.proposer.address }));
  // The named maker did not sign it.
  await refused("SIGNATURE_INVALID", baseQuote, await sign(baseQuote, testAccounts.proposer));
  assert.ok(await verifySignedQuote(baseQuote, signature, ctx({ maker: makerKey.address })));
});

test("rejects a quote that differs from the rfq or the market", async () => {
  const check = async (code: QuoteVerificationCode, patch: Partial<QuoteFields>, c = ctx()) => {
    const quote = { ...baseQuote, ...patch };
    await refused(code, quote, await sign(quote), c);
  };
  await check("TAKER_MISMATCH", { taker: testAccounts.taker2.address.toLowerCase() });
  await check("TERMS_MISMATCH", { marketId: "2" });
  await check("TERMS_MISMATCH", { side: "1" });
  await check("TERMS_MISMATCH", { quantity: "9" });
  await check("TERMS_MISMATCH", { specHash: hash(78) });
  await check("INVALID_PRICE", { priceBps: "0" });
  await check("INVALID_PRICE", { priceBps: "10000" });
  await check("INVALID_LIFETIME", { expiresAt: "1061" });
  await check("INVALID_LIFETIME", { validAfter: "1030" });
  await check("AFTER_CLOSE", {}, ctx({ market: { marketId: "1", specHash: SPEC_HASH, closeAt: 1029 } }));
  await check("DEPLOYMENT_MISMATCH", {}, ctx({ deployment: { ...deployment, chainId: 8453 as never } }));
});

test("checks the signed window against chain time with room to act", async () => {
  const signature = await sign(baseQuote);
  await refused("NOT_YET_VALID", baseQuote, signature, ctx({ now: 999n }));
  assert.ok(await verifySignedQuote(baseQuote, signature, ctx({ now: 1000n })));
  const margin = BigInt(DEFAULT_MIN_VALIDITY_SECONDS);
  // Exactly the margin is left at 1024; one second less is not enough.
  assert.ok(await verifySignedQuote(baseQuote, signature, ctx({ now: 1030n - margin })));
  await refused("EXPIRED", baseQuote, signature, ctx({ now: 1030n - margin + 1n }));
  // With no margin the quote lives until its last second, and not beyond.
  assert.ok(await verifySignedQuote(baseQuote, signature, ctx({ now: 1029n, minValiditySeconds: 0n })));
  await refused("EXPIRED", baseQuote, signature, ctx({ now: 1030n, minValiditySeconds: 0n }));
});

test("accepts only the signatures BlinkMarkets accepts", async () => {
  const signature = await sign(baseQuote);
  // High-s and v of 0 or 1 recover the maker in viem but revert in OpenZeppelin ECDSA.
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt("0x" + signature.slice(66, 130));
  const highS = ("0x" +
    signature.slice(2, 66) +
    (n - s).toString(16).padStart(64, "0") +
    (signature.slice(130) === "1b" ? "1c" : "1b")) as Hex;
  await refused("SIGNATURE_INVALID", baseQuote, highS);
  await refused("SIGNATURE_INVALID", baseQuote, (signature.slice(0, 130) + "00") as Hex);
  await refused("SIGNATURE_INVALID", baseQuote, signature.slice(0, 130) as Hex);
  // An ERC-6492 wrapper is not accepted by the contract, so it is not accepted here.
  await refused("SIGNATURE_INVALID", baseQuote, (signature + "6492".repeat(16)) as Hex);
});

test("a contract-wallet maker verifies through the chain, not by recovery", async () => {
  const wallet = ("0x" + "c0de".repeat(10)) as Hex;
  const quote = { ...baseQuote, maker: wallet };
  // The wallet owner's signature is valid for the wallet; the node (ERC-1271) says so.
  const ownerSignature = await sign(quote, testAccounts.trader);
  const calls: unknown[] = [];
  const walletClient = {
    getCode: async () => "0x60016000" as Hex,
    verifyTypedData: async (args: { signature: Hex }) => {
      calls.push(args);
      return args.signature === ownerSignature;
    },
  } as unknown as QuoteVerificationContext["publicClient"];
  const verified = await verifySignedQuote(quote, ownerSignature, ctx({ publicClient: walletClient }));
  assert.equal(verified.maxCost, 4_040_000n);
  assert.equal(calls.length, 1);
  await refused("SIGNATURE_INVALID", quote, await sign(quote, makerKey), ctx({ publicClient: walletClient }));
});

test("verifySignedQuote is async so an un-awaited call cannot pass as verified", async () => {
  const signature = await sign(baseQuote);
  const pending = verifySignedQuote(baseQuote, signature, ctx());
  assert.ok(pending instanceof Promise);
  await pending;
});
