import { hashTypedData, isErc6492Signature, type Hex } from "viem";
import {
  MAX_OPEN_RFQS,
  MAX_QUOTE_LIFETIME_SECONDS,
  MAX_QUOTES_PER_RFQ,
  RFQ_TTL_SECONDS,
  RfqRequest,
  SignedQuote,
  quoteTypes,
  type ProtocolMarket,
} from "@blink/schemas";
import { tradable } from "@blink/domain";
import {
  SignatureCheckUnavailable,
  type IdentityPrincipal,
  type KeyScope,
  type ProtocolReader,
  type RfqRecord,
  type RfqStore,
  type SignatureVerifier,
} from "@blink/ports";
import { IdentityError, readFreshIndex } from "./identity.js";
import type { RouteService, ServiceRequest } from "./route-service.js";

export const rfqPaths = [
  "/v1/rfqs",
  "/v1/rfqs/:id/quotes",
  "/v1/makers/:address/stats",
] as const;

const UNIT = 1_000_000n;
const lower = (value: string) => value.toLowerCase();
const refuse = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
) => new IdentityError(status, code, { details });
const sideName = (side: string) => (side === "0" ? "YES" : "NO");

/**
 * The RFQ relay. It forwards a taker's request to makers and the makers' signed quotes back; it
 * never prices, signs or fills. A refused quote is never stored, and the stored fields and
 * signature are returned unchanged.
 */
export function createRfqService(deps: {
  store: RfqStore;
  identity: {
    authenticate(
      authorization: string | undefined,
      scope?: KeyScope,
    ): Promise<IdentityPrincipal>;
  };
  reader: Pick<
    ProtocolReader,
    "health" | "hasRole" | "market" | "maker" | "digest"
  >;
  verifier: SignatureVerifier;
  /** The generation's BlinkMarkets (the EIP-712 verifying contract) and Params.maxFillShares. */
  deployment: { markets: string; maxFillShares: number };
  /** Unix seconds; the host clock unless a test or harness supplies chain time. */
  now?: () => number | Promise<number>;
  newId?: () => string;
}): RouteService {
  const clock = async () =>
    deps.now ? await deps.now() : Math.floor(Date.now() / 1000);

  async function caller(req: ServiceRequest) {
    const principal = await deps.identity.authenticate(
      req.authorization,
      "rfq:write",
    );
    if (!principal.address) throw new IdentityError(403, "NOT_REGISTERED");
    return lower(principal.address);
  }
  const requireRole = async (address: string, role: "TAKER" | "MAKER") => {
    if (!(await deps.reader.hasRole(address, role)))
      throw refuse(403, "ROLE_REQUIRED", { role });
  };

  // Every relay write refuses first when the index lags, whatever else is wrong with it.
  const requireFreshIndex = () =>
    readFreshIndex(deps.reader, async () => undefined);

  async function createRfq(req: ServiceRequest) {
    const taker = await caller(req);
    await requireFreshIndex();
    const body = RfqRequest.safeParse(req.body);
    if (!body.success) throw new IdentityError(400, "INVALID_REQUEST");
    const quantity = BigInt(body.data.quantity);
    if (quantity < 1n || quantity > BigInt(deps.deployment.maxFillShares))
      throw refuse(400, "INVALID_REQUEST", {
        reason: "QUANTITY_RANGE",
        maxFillShares: deps.deployment.maxFillShares,
      });
    const now = await clock();
    const market = await readFreshIndex(deps.reader, async () => {
      await requireRole(taker, "TAKER");
      return deps.reader.market(body.data.marketId);
    });
    if (!market) throw new IdentityError(404, "NOT_FOUND");
    if (!tradable(market, now)) throw new IdentityError(409, "MARKET_NOT_TRADABLE");
    const id = (deps.newId ?? (() => crypto.randomUUID()))();
    const expiresAt = now + RFQ_TTL_SECONDS;
    const stored = await deps.store.create(
      {
        id,
        marketId: body.data.marketId,
        specHash: lower(market.specHash),
        side: body.data.side,
        quantity: quantity.toString(),
        taker,
        createdAt: now,
        expiresAt,
      },
      MAX_OPEN_RFQS,
    );
    if (!stored)
      throw refuse(409, "RFQ_LIMIT_REACHED", { maxOpen: MAX_OPEN_RFQS });
    return { status: 201, body: { rfqId: id, expiresAt } };
  }

  async function listRfqs(req: ServiceRequest) {
    const maker = await caller(req);
    await readFreshIndex(deps.reader, () => requireRole(maker, "MAKER"));
    const { after, limit } = req.query as { after?: string; limit: number };
    const rows = await deps.store.listOpen({
      after: after ?? null,
      limit: limit + 1,
      now: await clock(),
    });
    const page = rows.slice(0, limit);
    return {
      status: 200,
      body: {
        items: page.map(view),
        next: rows.length > limit ? page[page.length - 1]!.seq : null,
      },
    };
  }
  const view = (r: RfqRecord) => ({
    rfqId: r.id,
    marketId: r.marketId,
    specHash: r.specHash,
    side: r.side,
    quantity: r.quantity,
    taker: r.taker,
    expiresAt: r.expiresAt,
  });

  /** Every term a taker could be hurt by, checked before the signature is. */
  function checkTerms(
    quote: SignedQuote["quote"],
    rfq: RfqRecord,
    market: ProtocolMarket,
    now: number,
  ) {
    const mismatch = (field: string) => refuse(400, "QUOTE_MISMATCH", { field });
    if (lower(quote.taker) !== rfq.taker) throw mismatch("taker");
    if (BigInt(quote.marketId) !== BigInt(rfq.marketId)) throw mismatch("marketId");
    if (sideName(quote.side) !== rfq.side) throw mismatch("side");
    if (BigInt(quote.quantity) !== BigInt(rfq.quantity)) throw mismatch("quantity");
    if (
      lower(quote.specHash) !== lower(rfq.specHash) ||
      lower(quote.specHash) !== lower(market.specHash)
    )
      throw mismatch("specHash");
    const terms = (reason: string) => refuse(400, "INVALID_QUOTE_TERMS", { reason });
    const price = BigInt(quote.priceBps);
    if (price < 1n || price > 9999n) throw terms("PRICE");
    const validAfter = BigInt(quote.validAfter);
    const expiresAt = BigInt(quote.expiresAt);
    if (
      expiresAt <= validAfter ||
      expiresAt - validAfter > BigInt(MAX_QUOTE_LIFETIME_SECONDS)
    )
      throw terms("LIFETIME");
    if (expiresAt <= BigInt(now)) throw terms("EXPIRED");
    if (expiresAt > BigInt(market.closeAt)) throw terms("AFTER_CLOSE");
  }

  async function checkSignature(quote: SignedQuote["quote"], signature: string) {
    // BlinkMarkets takes ECDSA or ERC-1271, never an ERC-6492 wrapper, so the relay must not either.
    if (isErc6492Signature(signature as Hex))
      throw refuse(400, "INVALID_QUOTE_SIGNATURE", { reason: "ERC6492_UNSUPPORTED" });
    let valid: boolean;
    try {
      valid = (
        await deps.verifier.verifyTypedData({
          address: quote.maker,
          typedData: typedData(quote),
          signature: signature as Hex,
        })
      ).valid;
    } catch (error) {
      if (error instanceof SignatureCheckUnavailable)
        throw new IdentityError(503, "SIGNATURE_CHECK_UNAVAILABLE", {
          retryable: true,
          retryAfterSeconds: 1,
        });
      throw error;
    }
    if (!valid) throw new IdentityError(400, "INVALID_QUOTE_SIGNATURE");
  }
  const typedData = (quote: SignedQuote["quote"]) => ({
    domain: {
      name: "Blink RFQ",
      version: "0.2",
      chainId: 84532,
      verifyingContract: deps.deployment.markets as Hex,
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
  });

  async function postQuote(req: ServiceRequest) {
    const maker = await caller(req);
    await requireFreshIndex();
    const body = SignedQuote.safeParse(req.body);
    if (!body.success) throw new IdentityError(400, "INVALID_REQUEST");
    const { quote, signature } = body.data;
    const rfq = await deps.store.get(req.params.id!);
    if (!rfq) throw new IdentityError(404, "NOT_FOUND");
    const digest = hashTypedData(typedData(quote));
    // One consistent look at the clock and the index: the RFQ, the role, the market, the maker's
    // balance and epoch and the digest. It runs again after the signature check, which can take a
    // long time, so a quote is never accepted against a clock or an index older than the check.
    const look = async () => {
      const now = await clock();
      if (rfq.expiresAt <= now) throw new IdentityError(409, "RFQ_CLOSED");
      const { market, state, status } = await readFreshIndex(deps.reader, async () => {
        await requireRole(maker, "MAKER");
        return {
          market: await deps.reader.market(rfq.marketId),
          state: await deps.reader.maker(maker),
          status: await deps.reader.digest(digest),
        };
      });
      if (!market) throw new IdentityError(404, "NOT_FOUND");
      if (lower(quote.maker) !== maker) throw new IdentityError(403, "MAKER_MISMATCH");
      if (!tradable(market, now)) throw new IdentityError(409, "MARKET_NOT_TRADABLE");
      checkTerms(quote, rfq, market, now);
      if (BigInt(quote.epoch) !== BigInt(state.epoch))
        throw refuse(409, "STALE_EPOCH", { epoch: state.epoch });
      if (status === "CONSUMED") throw new IdentityError(409, "QUOTE_CONSUMED");
      if (status === "CANCELLED") throw new IdentityError(409, "QUOTE_CANCELLED");
      const makerCost =
        BigInt(quote.quantity) * UNIT - BigInt(quote.quantity) * BigInt(quote.priceBps) * 100n;
      if (BigInt(state.freeMicros) < makerCost)
        throw new IdentityError(409, "INSUFFICIENT_MAKER_BALANCE");
      return now;
    };
    await look();
    await checkSignature(quote, signature);
    await look();
    const result = await deps.store.addQuote(
      {
        rfqId: rfq.id,
        maker,
        digest,
        priceBps: Number(quote.priceBps),
        expiresAt: Number(quote.expiresAt),
        quote: JSON.stringify(quote),
        signature,
      },
      MAX_QUOTES_PER_RFQ,
    );
    if (result === "CLOSED") throw new IdentityError(409, "RFQ_CLOSED");
    if (result === "DUPLICATE") throw new IdentityError(409, "QUOTE_ALREADY_POSTED");
    if (result === "FULL")
      throw refuse(409, "RFQ_FULL", { maxQuotes: MAX_QUOTES_PER_RFQ });
    return { status: 201, body: { digest } };
  }

  async function listQuotes(req: ServiceRequest) {
    const taker = await caller(req);
    const rfq = await deps.store.get(req.params.id!);
    // A stranger learns nothing about an RFQ that is not theirs.
    if (!rfq || rfq.taker !== taker) throw new IdentityError(404, "NOT_FOUND");
    const quotes = await deps.store.quotes(rfq.id);
    return {
      status: 200,
      body: {
        items: quotes.map((q) => ({
          quote: JSON.parse(q.quote) as unknown,
          signature: q.signature,
        })),
      },
    };
  }

  return {
    paths: rfqPaths,
    async handle(req) {
      if (req.path === "/v1/makers/:address/stats")
        return {
          status: 200,
          body: { ...(await deps.store.stats(req.params.address!)) },
        };
      if (req.path === "/v1/rfqs/:id/quotes")
        return req.method === "POST" ? postQuote(req) : listQuotes(req);
      return req.method === "POST" ? createRfq(req) : listRfqs(req);
    },
  };
}
