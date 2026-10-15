import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData, type Hex } from "viem";
import { encodeAllowedCall } from "../packages/adapters/src/signing-calldata.js";
import {
  QuoteVerificationError,
  verifySignedQuote,
  type QuoteVerificationCode,
} from "../packages/client/src/index.js";
import { quoteCosts } from "../packages/domain/src/pricing.js";
import {
  parseQuoteMessage,
  quoteDomain,
} from "../packages/domain/src/signing-policy.js";
import {
  ConfigResponse,
  PublicDeployment,
  RfqRequest,
  SignedQuoteResponse,
  quoteTypes,
} from "../packages/schemas/src/index.js";
import { testAccounts, testManifest } from "./helpers/signer-fixture.js";

// Every quote here is signed offline with a public Anvil development key.
const manifest = testManifest({ deploymentId: "client-verify" });
const market = manifest.contracts.BlinkMarket as Hex;
const deployment = PublicDeployment.parse({
  deploymentId: manifest.deploymentId,
  chainId: manifest.chainId,
  deploymentBlock: manifest.deploymentBlock,
  contracts: manifest.contracts,
  artifacts: {
    abiHashes: manifest.artifacts.abiHashes,
    bytecodeHashes: manifest.artifacts.bytecodeHashes,
  },
  roles: manifest.roles,
  parameters: manifest.parameters,
});
const config = ConfigResponse.parse({
  chainId: 84532,
  stage: "m2-trading",
  tradingEnabled: true,
  deployment,
  asset: {
    name: "Blink Test USD",
    symbol: "bUSD",
    decimals: 6,
    hasValue: false,
  },
}) as ConfigResponse & { deployment: PublicDeployment };
const wallet = testAccounts.taker.address;
const request = RfqRequest.parse({
  deploymentId: "client-verify",
  marketId: "1",
  side: "YES",
  quantity: "10",
  maxCostMicros: "6500000",
});
const baseMessage = {
  marketId: "1",
  specHash: ("0x" + "11".repeat(32)) as Hex,
  maker: testAccounts.maker.address.toLowerCase(),
  taker: wallet.toLowerCase(),
  side: "0",
  quantity: "10",
  priceBps: "6000",
  validAfter: "1000",
  expiresAt: "1030",
  nonce: "7",
  epoch: "3",
};
type Message = typeof baseMessage;
const NOW = 1010n;

const typed = (message: Message, verifyingContract: Hex = market) => ({
  domain: { ...quoteDomain(manifest), verifyingContract },
  types: quoteTypes,
  primaryType: "Quote" as const,
  message: {
    marketId: BigInt(message.marketId),
    specHash: message.specHash,
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
});
const encode = (message: Message, signature: Hex) =>
  encodeAllowedCall({
    to: market,
    functionName: "fillQuote",
    args: [parseQuoteMessage(message)!, signature],
  });

/** A response as `POST /v1/rfqs` builds it, signed by `signer` (the maker unless a test says otherwise). */
async function envelopeFor(
  overrides: Partial<Message> = {},
  signer = testAccounts.maker,
) {
  const message = { ...baseMessage, ...overrides };
  const data = typed(message);
  const signature = await signer.signTypedData(data);
  const { takerCostMicros, makerCostMicros } = quoteCosts(
    BigInt(message.quantity),
    Number(message.priceBps),
  );
  return SignedQuoteResponse.parse({
    deploymentId: "client-verify",
    quoteId: hashTypedData(data),
    marketId: message.marketId,
    mode: "REPLAY",
    chainId: 84532,
    verifyingContract: market,
    domain: data.domain,
    types: quoteTypes,
    message,
    signature,
    takerCostMicros: String(takerCostMicros),
    makerCostMicros: String(makerCostMicros),
    expiresAt: message.expiresAt,
    calldata: encode(message, signature),
    forecastSnapshotId: "00000000-0000-4000-8000-000000000001",
    chainCursor: {
      blockNumber: "10",
      blockHash: "0x" + "ab".repeat(32),
      finality: "INCLUDED",
    },
  });
}
type Envelope = Awaited<ReturnType<typeof envelopeFor>>;
const context = (over: Record<string, unknown> = {}) => ({
  config,
  wallet,
  request,
  nowSeconds: NOW,
  ...over,
});
const verify = (envelope: Envelope, over: Record<string, unknown> = {}) =>
  verifySignedQuote(envelope, context(over) as never);
function rejects(
  code: QuoteVerificationCode,
  envelope: Envelope,
  over: Record<string, unknown> = {},
) {
  assert.throws(
    () => verify(envelope, over),
    (error) =>
      error instanceof QuoteVerificationError &&
      error instanceof Error &&
      error.code === code &&
      error.message === code,
    code,
  );
}
const tamper = (envelope: Envelope, patch: Record<string, unknown>) =>
  ({ ...envelope, ...patch }) as Envelope;

test("an honest envelope from the production calldata encoder verifies", async () => {
  assert.equal(verify(await envelopeFor()), undefined);
  // A quote is still good in its last second.
  assert.equal(verify(await envelopeFor(), { nowSeconds: 1029n }), undefined);
});

test("DEPLOYMENT_MISMATCH: another deployment, a request for another deployment, or no deployment", async () => {
  const envelope = await envelopeFor();
  rejects("DEPLOYMENT_MISMATCH", tamper(envelope, { deploymentId: "other" }));
  rejects("DEPLOYMENT_MISMATCH", envelope, {
    request: { ...request, deploymentId: "other" },
  });
  rejects("DEPLOYMENT_MISMATCH", envelope, {
    config: { ...config, deployment: null },
  });
});

test("DOMAIN_MISMATCH: name, version, chain and verifying contract (top level or domain)", async () => {
  const envelope = await envelopeFor();
  const foreign = testAccounts.taker2.address;
  for (const domain of [
    { ...envelope.domain, name: "Other RFQ" },
    { ...envelope.domain, version: "0.2" },
    { ...envelope.domain, chainId: 8453 },
    { ...envelope.domain, verifyingContract: foreign },
  ])
    rejects("DOMAIN_MISMATCH", tamper(envelope, { domain }));
  rejects("DOMAIN_MISMATCH", tamper(envelope, { verifyingContract: foreign }));
  rejects("DOMAIN_MISMATCH", tamper(envelope, { chainId: 8453 }));
});

test("MAKER_MISMATCH: a quote validly signed by someone who is not the deployment's maker", async () => {
  const impostor = testAccounts.taker2;
  rejects(
    "MAKER_MISMATCH",
    await envelopeFor({ maker: impostor.address.toLowerCase() }, impostor),
  );
});

test("SIGNATURE_INVALID: another key, a message edited after signing, a malformed signature", async () => {
  // Claims the maker but is signed by someone else.
  rejects("SIGNATURE_INVALID", await envelopeFor({}, testAccounts.taker2));
  // Edited after signing: the signature no longer recovers the maker.
  const envelope = await envelopeFor();
  rejects(
    "SIGNATURE_INVALID",
    tamper(envelope, {
      message: { ...envelope.message, priceBps: "1" },
    }),
  );
  // 65 bytes with an impossible recovery id.
  rejects(
    "SIGNATURE_INVALID",
    tamper(envelope, { signature: "0x" + "00".repeat(64) + "ff" }),
  );
});

test("DIGEST_MISMATCH: a quoteId that is not the digest of the signed message", async () => {
  const envelope = await envelopeFor();
  rejects(
    "DIGEST_MISMATCH",
    tamper(envelope, { quoteId: "0x" + "cd".repeat(32) }),
  );
});

test("TAKER_MISMATCH: a quote for someone else's wallet, even though the maker signed it", async () => {
  rejects(
    "TAKER_MISMATCH",
    await envelopeFor({ taker: testAccounts.taker2.address.toLowerCase() }),
  );
  rejects("TAKER_MISMATCH", await envelopeFor(), {
    wallet: testAccounts.taker2.address,
  });
});

test("TERMS_MISMATCH: another market, the other side, another quantity, an expiry that differs from the signed one", async () => {
  rejects("TERMS_MISMATCH", await envelopeFor({ marketId: "2" }));
  rejects("TERMS_MISMATCH", await envelopeFor({ side: "1" }));
  rejects("TERMS_MISMATCH", await envelopeFor({ quantity: "11" }));
  const envelope = await envelopeFor();
  rejects("TERMS_MISMATCH", tamper(envelope, { marketId: "2" }));
  // The unsigned display field must not claim a later expiry than the signed message.
  rejects("TERMS_MISMATCH", tamper(envelope, { expiresAt: "9999" }));
  // The NO side verifies when NO was asked.
  assert.equal(
    verify(await envelopeFor({ side: "1" }), {
      request: { ...request, side: "NO" },
    }),
    undefined,
  );
});

test("COST_MISMATCH: reported costs that do not follow from the signed price and quantity", async () => {
  const envelope = await envelopeFor();
  rejects("COST_MISMATCH", tamper(envelope, { takerCostMicros: "1" }));
  rejects("COST_MISMATCH", tamper(envelope, { makerCostMicros: "1" }));
  // The signed price is what the contract charges, whatever the envelope says.
  rejects("COST_MISMATCH", {
    ...(await envelopeFor({ priceBps: "9000" })),
    takerCostMicros: envelope.takerCostMicros,
    makerCostMicros: envelope.makerCostMicros,
  } as Envelope);
});

test("MAX_COST_EXCEEDED: the taker cost is above the limit by one micro-bUSD, and at the limit it passes", async () => {
  const envelope = await envelopeFor();
  assert.equal(envelope.takerCostMicros, "6000000");
  rejects("MAX_COST_EXCEEDED", envelope, {
    request: { ...request, maxCostMicros: "5999999" },
  });
  assert.equal(
    verify(envelope, { request: { ...request, maxCostMicros: "6000000" } }),
    undefined,
  );
});

test("EXPIRED: the first second at or after expiresAt, by the supplied chain time", async () => {
  const envelope = await envelopeFor();
  rejects("EXPIRED", envelope, { nowSeconds: 1030n });
  rejects("EXPIRED", envelope, { nowSeconds: 5000n });
});

test("CALLDATA_MISMATCH: calldata for other terms, another signature, or not fillQuote", async () => {
  const envelope = await envelopeFor();
  const other = await envelopeFor({ nonce: "8" });
  rejects("CALLDATA_MISMATCH", tamper(envelope, { calldata: other.calldata }));
  // The signature's own byte (the argument's tail is zero padding, so edit the v byte).
  const at = envelope.calldata.length - 31 * 2 - 2;
  rejects(
    "CALLDATA_MISMATCH",
    tamper(envelope, {
      calldata:
        envelope.calldata.slice(0, at) +
        (envelope.calldata.slice(at, at + 2) === "1b" ? "1c" : "1b") +
        envelope.calldata.slice(at + 2),
    }),
  );
  rejects(
    "CALLDATA_MISMATCH",
    tamper(envelope, { calldata: envelope.calldata + "00" }),
  );
  rejects("CALLDATA_MISMATCH", tamper(envelope, { calldata: "0x095ea7b3" }));
});

test("the first failure wins, in the documented order", async () => {
  const envelope = await envelopeFor();
  // Wrong deployment and tampered calldata and an expired quote: the deployment is reported.
  rejects(
    "DEPLOYMENT_MISMATCH",
    tamper(envelope, { deploymentId: "other", calldata: "0x00" }),
    { nowSeconds: 9999n },
  );
  // Tampered cost beats an exceeded limit, which beats expiry, which beats calldata.
  const costly = tamper(envelope, {
    takerCostMicros: "1",
    calldata: "0x00",
  });
  rejects("COST_MISMATCH", costly, {
    nowSeconds: 9999n,
    request: { ...request, maxCostMicros: "1" },
  });
  rejects("MAX_COST_EXCEEDED", tamper(envelope, { calldata: "0x00" }), {
    nowSeconds: 9999n,
    request: { ...request, maxCostMicros: "1" },
  });
  rejects("EXPIRED", tamper(envelope, { calldata: "0x00" }), {
    nowSeconds: 9999n,
  });
});
