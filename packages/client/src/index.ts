import { hasMainnetChain } from "./chain-guard.ts";
import { isClientHttpLoopbackHost } from "./url-policy.ts";
import { keccak256 } from "viem";
import {
  ApiError,
  ConfigResponse,
  IdempotencyHeaders,
  ProtocolDeployment,
  ProtocolMarket,
  apiContracts,
  parseMarketSpec,
  type ApiContract,
  type IndexHealth,
  type MarketStateName,
} from "@blink/schemas";

export class BlinkApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(body.message);
  }
}

type Method = "GET" | "POST";
type Operation<M extends Method, P extends string> = Extract<
  ApiContract,
  { method: M; path: P }
>;
/** What a contract's response schema yields, so each call is typed by the schema that checks it. */
type Out<M extends Method, P extends string> = Operation<
  M,
  P
>["response"]["_output"];
type Page = { limit?: number; cursor?: string };
/** Paging of the protocol read routes and the RFQ list: `after` is the previous page's `next`. */
type After = { limit?: number; after?: string };
type ForecastMarket = { deploymentId: string; marketId: string };
/** A page of the protocol read routes. Every such answer carries the index health it was read at. */
export type ProtocolPage<T = Record<string, unknown>> = {
  items: T[];
  next: string | null;
  index: IndexHealth;
};
/** A market from the read API: the indexed fields plus whatever the route adds (spec, proposal, index). */
export type MarketDetail = ProtocolMarket & Record<string, unknown>;

export type BlinkClientOptions = {
  /**
   * Tries per call (default 3). Only an answer the server marks `retryable` is tried again, and
   * a POST is always repeated with the Idempotency-Key of its first try.
   */
  maxAttempts?: number;
  /** How the client waits between tries; replaced in tests. */
  sleep?: (milliseconds: number) => Promise<void>;
};
const MAX_WAIT_MS = 10_000;
const BASE_WAIT_MS = 250;

export function createBlinkClient(
  baseUrl: string,
  apiKey?: string,
  options: BlinkClientOptions = {},
) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && isClientHttpLoopbackHost(base.hostname))
  )
    throw new Error("HTTPS_REQUIRED");
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  // The server's own Retry-After when it sends one; otherwise 250 ms, doubling.
  const waitBefore = (retryAfter: string | null, attempt: number) => {
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    return Math.min(
      Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : BASE_WAIT_MS * 2 ** (attempt - 1),
      MAX_WAIT_MS,
    );
  };
  /** The body bytes of a successful answer; an API refusal is a BlinkApiError after its retries. */
  async function send(path: string, init: RequestInit = {}) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(new URL(path, base), {
        ...init,
        redirect: "error",
        headers: {
          ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          ...init.headers,
        },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.ok) return bytes;
      const error = ApiError.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!error.retryable || attempt >= maxAttempts)
        throw new BlinkApiError(response.status, error);
      await sleep(waitBefore(response.headers.get("retry-after"), attempt));
    }
  }
  const json = (bytes: Uint8Array): unknown => {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (hasMainnetChain(value)) throw new Error("MAINNET_REFUSED");
    return value;
  };
  const queryString = (query: Record<string, unknown>) => {
    const entries = Object.entries(query).filter(([, v]) => v !== undefined);
    return entries.length
      ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))
      : "";
  };
  type Args = {
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
    key?: string | undefined;
  };
  /** The contract of an operation and its URL, with the path and query checked against the schema. */
  function target(method: Method, path: string, args: Args) {
    const contract = apiContracts.find(
      (c) => c.method === method && c.path === path,
    )!;
    const params = contract.params.parse(args.params ?? {});
    const query = contract.query.parse(args.query ?? {});
    const url =
      path.replace(/:([A-Za-z]+)/g, (_, name: string) =>
        encodeURIComponent(String(params[name])),
      ) + queryString(query);
    return { contract, url };
  }
  /**
   * One contract operation, checked against the shared schemas before anything is sent and after
   * the answer arrives. A POST carries the given Idempotency-Key or a fresh UUID, chosen once, so
   * every retry of the call repeats the same key.
   */
  async function call<
    M extends Method,
    P extends Extract<ApiContract, { method: M }>["path"],
  >(method: M, path: P, args: Args = {}): Promise<Out<M, P>> {
    const { contract, url } = target(method, path, args);
    if (method === "GET")
      return contract.response.parse(json(await send(url))) as Out<M, P>;
    const body = contract.body ? contract.body.parse(args.body) : undefined;
    // The public wallet endpoints define no Idempotency-Key: a challenge is single use instead.
    const keyed = contract.idempotencyKey !== false;
    const key = args.key ?? crypto.randomUUID();
    if (keyed) IdempotencyHeaders.parse({ "idempotency-key": key });
    return contract.response.parse(
      json(
        await send(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(keyed ? { "Idempotency-Key": key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    ) as Out<M, P>;
  }
  const marketParams = (ref: ForecastMarket) => ({
    params: { id: ref.marketId },
    query: { deploymentId: ref.deploymentId },
  });
  /** A route of the protocol read API (deployment, markets, disputes, fees, accounts, templates). */
  const read = async (path: string, query: Record<string, unknown> = {}) =>
    json(await send(path + queryString(query)));
  const segment = (value: string) => encodeURIComponent(value);
  /** Bytes served by hash, accepted only if keccak256(bytes) is the hash asked for. */
  const bytesByHash = async (path: string, hash: string) => {
    const bytes = await send(path);
    if (keccak256(bytes) !== hash.toLowerCase())
      throw new Error("HASH_MISMATCH");
    return bytes;
  };
  return {
    // --- identity ---
    /** Public and not idempotent: each call creates a new challenge (300 s; limits are per client IP, and per client IP and address). */
    createWalletChallenge: (input: unknown) =>
      call("POST", "/v1/auth/wallet-challenges", { body: input }),
    /** Public and single use: sign the challenge message, then verify once to receive the key. */
    verifyWallet: (input: unknown) =>
      call("POST", "/v1/auth/wallet-verifications", { body: input }),
    // --- config and protocol reads (public) ---
    getConfig: async () => ConfigResponse.parse(json(await send("/v1/config"))),
    /** The current generation's manifest v2: contract addresses and Params. */
    async getDeployment(): Promise<ProtocolDeployment> {
      const body = (await read("/v1/deployment")) as Record<string, unknown>;
      const { index: _index, ...manifest } = body;
      return ProtocolDeployment.parse(
        manifest.deployment !== undefined ? manifest.deployment : manifest,
      );
    },
    listMarkets: (
      query: After & { state?: MarketStateName } = {},
    ): Promise<ProtocolPage<ProtocolMarket>> =>
      read("/v1/markets", query) as Promise<ProtocolPage<ProtocolMarket>>,
    async getMarket(marketId: string): Promise<MarketDetail> {
      const body = (await read("/v1/markets/" + segment(marketId))) as Record<
        string,
        unknown
      >;
      const nested = body.market;
      return ProtocolMarket.loose().parse(
        typeof nested === "object" && nested !== null && !("marketId" in body)
          ? { ...nested, ...body }
          : body,
      ) as MarketDetail;
    },
    /** The spec bytes, accepted only if keccak256(bytes) is the `specHash` the caller already trusts. */
    async getMarketSpec(marketId: string, specHash: string) {
      const bytes = await bytesByHash(
        "/v1/markets/" + segment(marketId) + "/spec",
        specHash,
      );
      const parsed = parseMarketSpec(bytes);
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.spec;
    },
    listDisputes: (marketId: string, query: After = {}) =>
      read("/v1/markets/" + segment(marketId) + "/disputes", query) as Promise<ProtocolPage>,
    getDispute: (disputeId: string) =>
      read("/v1/disputes/" + segment(disputeId)),
    getFees: (marketId: string) =>
      read("/v1/markets/" + segment(marketId) + "/fees"),
    getAccount: (address: string) =>
      read("/v1/accounts/" + segment(address)),
    getPositions: (address: string, query: After = {}) =>
      read("/v1/accounts/" + segment(address) + "/positions", query) as Promise<ProtocolPage>,
    listTemplates: (query: After = {}) =>
      read("/v1/templates", query) as Promise<ProtocolPage>,
    // --- content and suggestions ---
    /** Uploads bytes (needs a key with content:write); the answer must name keccak256 of what was sent. */
    async uploadContent(bytes: Uint8Array, mediaType: string) {
      const { contract } = target("POST", "/v1/content", {});
      const answer = contract.response.parse(
        json(
          await send("/v1/content", {
            method: "POST",
            headers: { "Content-Type": mediaType },
            body: new Uint8Array(bytes).buffer,
          }),
        ),
      ) as { hash: string; size: number };
      if (answer.hash !== keccak256(bytes) || answer.size !== bytes.length)
        throw new Error("HASH_MISMATCH");
      return answer as Out<"POST", "/v1/content">;
    },
    getContent: (hash: string) => bytesByHash("/v1/content/" + segment(hash), hash),
    /** Public and not idempotent: each call adds a suggestion. */
    submitSuggestion: (input: unknown) =>
      call("POST", "/v1/suggestions", { body: input }),
    listSuggestions: (
      query: Page & { status?: "OPEN" | "CLAIMED" | "MARKET_CREATED" } = {},
    ) => call("GET", "/v1/suggestions", { query }),
    getSuggestion: (id: string) =>
      call("GET", "/v1/suggestions/:id", { params: { id } }),
    claimSuggestion: (id: string) =>
      call("POST", "/v1/suggestions/:id/claims", { params: { id } }),
    // --- forecasts ---
    listForecastWindows: (ref: ForecastMarket, page: Page = {}) =>
      call("GET", "/v1/markets/:id/forecast-windows", {
        params: marketParams(ref).params,
        query: { deploymentId: ref.deploymentId, ...page },
      }),
    submitForecast: (ref: ForecastMarket, input: unknown, key?: string) =>
      call("POST", "/v1/markets/:id/forecasts", {
        ...marketParams(ref),
        body: input,
        key,
      }),
    listForecasts: (ref: ForecastMarket, query: Page & { windowId: string }) =>
      call("GET", "/v1/markets/:id/forecasts", {
        params: marketParams(ref).params,
        query: { deploymentId: ref.deploymentId, ...query },
      }),
    // --- RFQ relay (rfq:write) ---
    /** Taker: `{ marketId, side, quantity }`. Open for 30 seconds; the relay never prices or fills. */
    createRfq: (input: unknown) => call("POST", "/v1/rfqs", { body: input }),
    /** Maker: the open RFQs. */
    listRfqs: (query: After = {}) => call("GET", "/v1/rfqs", { query }),
    /** Maker: `{ quote, signature }` for an RFQ. */
    postQuote: (rfqId: string, input: unknown) =>
      call("POST", "/v1/rfqs/:id/quotes", { params: { id: rfqId }, body: input }),
    /** Taker: the RFQ's quotes, cheapest first, exactly as the makers posted them. Verify each one. */
    listQuotes: (rfqId: string) =>
      call("GET", "/v1/rfqs/:id/quotes", { params: { id: rfqId } }),
    /** Public and informational: quotes relayed, filled and cancelled before expiry. */
    getMakerStats: (address: string) =>
      call("GET", "/v1/makers/:address/stats", { params: { address } }),
    // --- transactions ---
    /** Registers a hash the key's wallet sent to the current generation, the faucet or the anchor. */
    trackTransaction: (input: { txHash: string }) =>
      call("POST", "/v1/transactions", { body: input }),
    getTransaction: (ref: { deploymentId: string; txHash: string }) =>
      call("GET", "/v1/transactions/:txHash", {
        params: { txHash: ref.txHash },
        query: { deploymentId: ref.deploymentId },
      }),
    getMetrics: (mode: "LIVE" | "REPLAY") =>
      call("GET", "/v1/metrics", { query: { mode } }),
  };
}
export {
  DEFAULT_MIN_VALIDITY_SECONDS,
  QuoteVerificationError,
  approvalFor,
  feeOf,
  takerCostOf,
  verifySignedQuote,
  type QuoteVerificationCode,
  type QuoteVerificationContext,
  type VerifiedQuote,
} from "./verify-quote.ts";
