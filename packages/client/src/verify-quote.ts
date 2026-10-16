import { hasMainnetChain } from "./chain-guard.ts";
import { Secp256k1, Signature } from "ox";
import { encodeFunctionData, hashTypedData, parseAbi, type Hex } from "viem";
import {
  CHAIN_ID,
  quoteTypes,
  type ConfigResponse,
  type PublicDeployment,
  type RfqRequest as RfqRequestSchema,
  type SignedQuoteResponse as SignedQuoteSchema,
} from "@blink/schemas";
type RfqRequest = (typeof RfqRequestSchema)["_output"];
type SignedQuote = (typeof SignedQuoteSchema)["_output"];

export type QuoteVerificationCode =
  | "MAINNET_REFUSED"
  | "DEPLOYMENT_MISMATCH"
  | "DOMAIN_MISMATCH"
  | "MAKER_MISMATCH"
  | "SIGNATURE_INVALID"
  | "DIGEST_MISMATCH"
  | "TAKER_MISMATCH"
  | "TERMS_MISMATCH"
  | "COST_MISMATCH"
  | "MAX_COST_EXCEEDED"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "CALLDATA_MISMATCH";

export class QuoteVerificationError extends Error {
  constructor(public readonly code: QuoteVerificationCode) {
    super(code);
    this.name = "QuoteVerificationError";
  }
}

export type QuoteVerificationContext = {
  /** The deployment the taker trusts: from `getConfig()`, never from the quote itself. */
  config: ConfigResponse & { deployment: PublicDeployment };
  /** The taker's verified wallet, the only account the quote may name. */
  wallet: string;
  request: RfqRequest;
  /** Chain time in seconds (the latest block's timestamp), never the host clock. */
  nowSeconds: bigint;
  /**
   * Seconds the quote must still have left (default `DEFAULT_MIN_VALIDITY_SECONDS`); 0 accepts a
   * quote until its last second. Use 0 only to ask whether a quote has really expired.
   */
  minValiditySeconds?: bigint | undefined;
};

/**
 * Time to approve and fill, assuming a 2-second block interval (an assumption, not measured here):
 * the approval takes one block, the fill the next, and one more covers propagation and polling. The API signs quotes
 * for 30 seconds (never fewer than 5), so this costs a taker a fifth of a normal quote.
 */
export const DEFAULT_MIN_VALIDITY_SECONDS = 6n;

// OpenZeppelin ECDSA.tryRecover, which fillQuote uses, refuses s above half the curve order.
const HALF_CURVE_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

const fillQuoteAbi = parseAbi([
  "struct Quote { uint256 marketId; bytes32 specHash; address maker; address taker; uint8 side; uint64 quantity; uint16 priceBps; uint64 validAfter; uint64 expiresAt; uint256 nonce; uint256 epoch; }",
  "function fillQuote(Quote q, bytes signature)",
]);
const UNIT_MICROS = 1_000_000n;
const lower = (value: string) => value.toLowerCase();

/**
 * Throws `QuoteVerificationError` with the first failed check. Everything the taker will pay or
 * send is recomputed from the maker-signed message and the deployment from `getConfig()`; the
 * envelope's own unsigned fields only have to agree with it. Call this before approving or filling.
 */
export function verifySignedQuote(
  envelope: SignedQuote,
  ctx: QuoteVerificationContext,
): void {
  const fail = (code: QuoteVerificationCode): never => {
    throw new QuoteVerificationError(code);
  };
  const { config, request, wallet } = ctx;
  if (hasMainnetChain(config) || hasMainnetChain(envelope))
    return fail("MAINNET_REFUSED");
  const deployment = config.deployment as PublicDeployment | null;
  if (
    !deployment ||
    envelope.deploymentId !== deployment.deploymentId ||
    request.deploymentId !== deployment.deploymentId
  )
    return fail("DEPLOYMENT_MISMATCH");
  const market = lower(deployment.contracts.BlinkMarket);
  const { domain, message } = envelope;
  if (
    domain.name !== "Blink RFQ" ||
    domain.version !== "0.1" ||
    domain.chainId !== CHAIN_ID ||
    envelope.chainId !== CHAIN_ID ||
    config.chainId !== CHAIN_ID ||
    lower(domain.verifyingContract) !== market ||
    lower(envelope.verifyingContract) !== market
  )
    return fail("DOMAIN_MISMATCH");
  const maker = lower(deployment.roles.maker);
  if (lower(message.maker) !== maker) return fail("MAKER_MISMATCH");

  // Types and domain come from this code and the trusted config, not from the envelope.
  const typed = {
    domain: {
      name: "Blink RFQ",
      version: "0.1",
      chainId: CHAIN_ID,
      verifyingContract: market as Hex,
    },
    types: quoteTypes,
    primaryType: "Quote" as const,
    message: {
      marketId: BigInt(message.marketId),
      specHash: message.specHash as Hex,
      maker: message.maker as Hex,
      taker: message.taker as Hex,
      side: Number(message.side),
      quantity: BigInt(message.quantity),
      priceBps: Number(message.priceBps),
      validAfter: BigInt(message.validAfter),
      expiresAt: BigInt(message.expiresAt),
      nonce: BigInt(message.nonce),
      epoch: BigInt(message.epoch),
    },
  };
  const signature = envelope.signature as Hex;
  const digest = hashTypedData(typed);
  // Synchronous on purpose (viem's own recovery is not): a verifier that returned a promise could
  // be called without `await` and would then verify nothing.
  let signer: string | null = null;
  try {
    // The contract recovers with OpenZeppelin's ECDSA: s in the lower half and v of 27 or 28. A
    // signature outside that recovers the maker here (`ox` is lenient) and then reverts on chain.
    const s = BigInt("0x" + signature.slice(66, 130));
    const v = Number.parseInt(signature.slice(130, 132), 16);
    if (s <= HALF_CURVE_ORDER && (v === 27 || v === 28))
      signer = lower(
        Secp256k1.recoverAddress({
          payload: digest,
          signature: Signature.fromHex(signature),
        }),
      );
  } catch {
    // A signature that cannot be recovered is as invalid as one by another key.
  }
  if (signer !== maker) return fail("SIGNATURE_INVALID");
  if (digest !== lower(envelope.quoteId)) return fail("DIGEST_MISMATCH");
  if (lower(message.taker) !== lower(wallet)) return fail("TAKER_MISMATCH");

  if (
    BigInt(message.marketId) !== BigInt(request.marketId) ||
    BigInt(envelope.marketId) !== BigInt(request.marketId) ||
    message.side !== (request.side === "YES" ? "0" : "1") ||
    BigInt(message.quantity) !== BigInt(request.quantity) ||
    BigInt(envelope.expiresAt) !== BigInt(message.expiresAt)
  )
    return fail("TERMS_MISMATCH");

  // taker = q * price * 100 and maker = q * 1e6 - taker (spec 7.2), from the signed price.
  const quantity = BigInt(message.quantity);
  const priceBps = BigInt(message.priceBps);
  const takerCost = quantity * priceBps * 100n;
  if (
    priceBps < 1n ||
    priceBps > 9999n ||
    BigInt(envelope.takerCostMicros) !== takerCost ||
    BigInt(envelope.makerCostMicros) !== quantity * UNIT_MICROS - takerCost
  )
    return fail("COST_MISMATCH");
  if (takerCost > BigInt(request.maxCostMicros))
    return fail("MAX_COST_EXCEEDED");
  // Chain time against the signed window (the contract needs validAfter <= now < expiresAt) and
  // the room an approval and a fill need.
  if (ctx.nowSeconds < BigInt(message.validAfter)) return fail("NOT_YET_VALID");
  const left = BigInt(message.expiresAt) - ctx.nowSeconds;
  if (
    left <= 0n ||
    left < (ctx.minValiditySeconds ?? DEFAULT_MIN_VALIDITY_SECONDS)
  )
    return fail("EXPIRED");

  const expected = encodeFunctionData({
    abi: fillQuoteAbi,
    functionName: "fillQuote",
    args: [typed.message, signature],
  });
  if (lower(envelope.calldata) !== expected) return fail("CALLDATA_MISMATCH");
}
