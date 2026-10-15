import { Secp256k1, Signature } from "ox";
import { encodeFunctionData, hashTypedData, parseAbi, type Hex } from "viem";
import {
  quoteTypes,
  type ConfigResponse,
  type PublicDeployment,
  type RfqRequest as RfqRequestSchema,
  type SignedQuoteResponse as SignedQuoteSchema,
} from "@blink/schemas";
type RfqRequest = (typeof RfqRequestSchema)["_output"];
type SignedQuote = (typeof SignedQuoteSchema)["_output"];

export type QuoteVerificationCode =
  | "DEPLOYMENT_MISMATCH"
  | "DOMAIN_MISMATCH"
  | "MAKER_MISMATCH"
  | "SIGNATURE_INVALID"
  | "DIGEST_MISMATCH"
  | "TAKER_MISMATCH"
  | "TERMS_MISMATCH"
  | "COST_MISMATCH"
  | "MAX_COST_EXCEEDED"
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
};

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
    domain.chainId !== config.chainId ||
    envelope.chainId !== config.chainId ||
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
      chainId: config.chainId,
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
  if (ctx.nowSeconds >= BigInt(message.expiresAt)) return fail("EXPIRED");

  const expected = encodeFunctionData({
    abi: fillQuoteAbi,
    functionName: "fillQuote",
    args: [typed.message, signature],
  });
  if (lower(envelope.calldata) !== expected) return fail("CALLDATA_MISMATCH");
}
