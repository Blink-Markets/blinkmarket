import {
  hashTypedData,
  isErc6492Signature,
  isHex,
  size,
  slice,
  hexToBigInt,
  type Hex,
  type PublicClient,
} from "viem";
import {
  CHAIN_ID,
  quoteTypes,
  type ProtocolDeployment,
  type ProtocolMarket,
  type QuoteFields,
} from "@blink/schemas";

export type QuoteVerificationCode =
  | "DEPLOYMENT_MISMATCH"
  | "MAKER_MISMATCH"
  | "TAKER_MISMATCH"
  | "TERMS_MISMATCH"
  | "INVALID_PRICE"
  | "INVALID_LIFETIME"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "AFTER_CLOSE"
  | "SIGNATURE_INVALID";

export class QuoteVerificationError extends Error {
  constructor(public readonly code: QuoteVerificationCode) {
    super(code);
    this.name = "QuoteVerificationError";
  }
}

/**
 * Seconds a quote must still have left (unless the caller says otherwise): one block for the
 * approval, one for the fill and one of slack, assuming 2-second blocks. An assumption, not
 * something measured here.
 */
export const DEFAULT_MIN_VALIDITY_SECONDS = 6n;
/** BlinkMarkets refuses a quote that lives longer than this. */
const MAX_LIFETIME_SECONDS = 60n;
// OpenZeppelin ECDSA.tryRecover, which fillQuote uses for a maker without code, refuses s above half
// the curve order.
const HALF_CURVE_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const lower = (value: string) => value.toLowerCase();

export type QuoteVerificationContext = {
  /** The node the taker trusts (chain 84532). Reads the maker's code and checks the signature. */
  publicClient: Pick<PublicClient, "getCode" | "verifyTypedData">;
  /** The generation the taker trusts: from `getDeployment()`, never from the quote itself. */
  deployment: Pick<ProtocolDeployment, "chainId" | "generation">;
  /** The market as the indexer reports it; the quote must name its spec hash and end before it closes. */
  market: Pick<ProtocolMarket, "marketId" | "specHash" | "closeAt">;
  /** What the taker asked for, and its own address, the only account the quote may name. */
  rfq: {
    marketId: string;
    side: "YES" | "NO";
    quantity: string;
    taker: string;
  };
  /** Chain time in seconds (the latest block's timestamp), never the host clock. */
  now: bigint;
  /** Params.feeBps of the generation. */
  feeBps: number;
  /** The maker the taker means to deal with, if it picked one. */
  maker?: string | undefined;
  /** Default `DEFAULT_MIN_VALIDITY_SECONDS`; 0 accepts a quote until its last second. */
  minValiditySeconds?: bigint | undefined;
};
export type VerifiedQuote = {
  /** The EIP-712 digest BlinkMarkets records as consumed. */
  digest: Hex;
  takerCost: bigint;
  fee: bigint;
  /** takerCost + fee: what the taker's allowance must cover. */
  maxCost: bigint;
};

/** takerCost = quantity x priceBps x 100 micro-bUSD. */
export const takerCostOf = (quote: Pick<QuoteFields, "quantity" | "priceBps">) =>
  BigInt(quote.quantity) * BigInt(quote.priceBps) * 100n;
/** The fee is charged on top of the taker cost, rounded down, as fillQuote does. */
export const feeOf = (takerCost: bigint, feeBps: number) =>
  (takerCost * BigInt(feeBps)) / 10_000n;

/** What a taker must approve for this quote: the cost plus the fee, never less. */
export function approvalFor(
  quote: Pick<QuoteFields, "quantity" | "priceBps">,
  feeBps: number,
): bigint {
  const takerCost = takerCostOf(quote);
  return takerCost + feeOf(takerCost, feeBps);
}

// What fillQuote accepts from a maker without code: 65 bytes, low s, v of 27 or 28.
function isCanonicalEcdsa(signature: Hex): boolean {
  if (!isHex(signature, { strict: true }) || size(signature) !== 65)
    return false;
  const v = hexToBigInt(slice(signature, 64, 65));
  return (
    (v === 27n || v === 28n) &&
    hexToBigInt(slice(signature, 32, 64)) <= HALF_CURVE_ORDER
  );
}

/**
 * The EIP-712 typed data of a quote: what a maker signs and what BlinkMarkets hashes. The domain
 * is the deployment's BlinkMarkets on chain 84532; the one builder for both sides of a fill.
 */
export function quoteTypedData(
  quote: QuoteFields,
  deployment: Pick<ProtocolDeployment, "generation">,
) {
  return {
    domain: {
      name: "Blink RFQ",
      version: "0.2",
      chainId: CHAIN_ID,
      verifyingContract: deployment.generation.markets as Hex,
    },
    types: quoteTypes,
    primaryType: "Quote" as const,
    message: {
      marketId: BigInt(quote.marketId),
      specHash: quote.specHash as Hex,
      maker: quote.maker as Hex,
      taker: quote.taker as Hex,
      side: Number(quote.side),
      quantity: BigInt(quote.quantity),
      priceBps: Number(quote.priceBps),
      validAfter: BigInt(quote.validAfter),
      expiresAt: BigInt(quote.expiresAt),
      nonce: BigInt(quote.nonce),
      epoch: BigInt(quote.epoch),
    },
  };
}

/**
 * Throws `QuoteVerificationError` with the first failed check, else returns the digest and what
 * the taker will pay. The domain and types come from this code and the trusted deployment, never
 * from the relay, and the signature is checked against chain state with viem `verifyTypedData`, so a
 * contract-wallet maker (ERC-1271) verifies like an EOA. It is async: a caller that forgets to
 * await gets a promise, not a quote it may use.
 */
export async function verifySignedQuote(
  quote: QuoteFields,
  signature: Hex,
  ctx: QuoteVerificationContext,
): Promise<VerifiedQuote> {
  const fail = (code: QuoteVerificationCode): never => {
    throw new QuoteVerificationError(code);
  };
  const { deployment, market, rfq } = ctx;
  if (deployment.chainId !== CHAIN_ID) return fail("DEPLOYMENT_MISMATCH");
  if (ctx.maker !== undefined && lower(quote.maker) !== lower(ctx.maker))
    return fail("MAKER_MISMATCH");
  if (lower(quote.taker) !== lower(rfq.taker)) return fail("TAKER_MISMATCH");
  if (
    BigInt(quote.marketId) !== BigInt(rfq.marketId) ||
    BigInt(quote.marketId) !== BigInt(market.marketId) ||
    quote.side !== (rfq.side === "YES" ? "0" : "1") ||
    BigInt(quote.quantity) !== BigInt(rfq.quantity) ||
    lower(quote.specHash) !== lower(market.specHash)
  )
    return fail("TERMS_MISMATCH");
  const price = BigInt(quote.priceBps);
  if (price < 1n || price > 9999n) return fail("INVALID_PRICE");
  const validAfter = BigInt(quote.validAfter);
  const expiresAt = BigInt(quote.expiresAt);
  if (
    expiresAt <= validAfter ||
    expiresAt - validAfter > MAX_LIFETIME_SECONDS
  )
    return fail("INVALID_LIFETIME");
  if (expiresAt > BigInt(market.closeAt)) return fail("AFTER_CLOSE");
  // The contract needs validAfter <= now < expiresAt, and the taker needs room to approve and fill.
  if (ctx.now < validAfter) return fail("NOT_YET_VALID");
  const left = expiresAt - ctx.now;
  if (left <= 0n || left < (ctx.minValiditySeconds ?? DEFAULT_MIN_VALIDITY_SECONDS))
    return fail("EXPIRED");

  const typed = quoteTypedData(quote, deployment);
  // BlinkMarkets takes ECDSA (no code) or ERC-1271 (code), never an ERC-6492 wrapper; viem's
  // validator would accept one, so the same rule is applied here, not a looser one.
  if (isErc6492Signature(signature)) return fail("SIGNATURE_INVALID");
  const code = await ctx.publicClient.getCode({
    address: quote.maker as Hex,
  });
  if ((!code || code === "0x") && !isCanonicalEcdsa(signature))
    return fail("SIGNATURE_INVALID");
  const valid = await ctx.publicClient.verifyTypedData({
    address: quote.maker as Hex,
    ...typed,
    signature,
  });
  if (!valid) return fail("SIGNATURE_INVALID");

  const takerCost = takerCostOf(quote);
  const fee = feeOf(takerCost, ctx.feeBps);
  return {
    digest: hashTypedData(typed),
    takerCost,
    fee,
    maxCost: takerCost + fee,
  };
}
