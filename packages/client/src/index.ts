import { hasMainnetChain } from "./chain-guard.ts";
import { isClientHttpLoopbackHost } from "./url-policy.ts";
import { hashTypedData, keccak256, type Hex } from "viem";
import {
  ApiError,
  ConfigResponse,
  IdempotencyHeaders,
  apiContracts,
  forecastTypedData,
  parseMarketSpec,
  type ForecastMessage,
  type ApiContract,
  type MarketStateName,
} from "@blink/schemas";

export class BlinkApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
    /** The server's Retry-After, in seconds, when it sent one. */
    public readonly retryAfterSeconds?: number,
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
      const retryAfter = response.headers.get("retry-after");
      if (!error.retryable || attempt >= maxAttempts) {
        const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
        throw new BlinkApiError(
          response.status,
          error,
          Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined,
        );
      }
      await sleep(waitBefore(retryAfter, attempt));
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
            // Fastify refuses an empty body that claims to be JSON (suggestion claims, withdrawals).
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(keyed ? { "Idempotency-Key": key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    ) as Out<M, P>;
  }
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
    /** The current generation's manifest and the index health it was read at. */
    getDeployment: () => call("GET", "/v1/deployment"),
    listMarkets: (query: After & { state?: MarketStateName } = {}) =>
      call("GET", "/v1/markets", { query }),
    /** The market, the parse of its spec bytes and its proposal. */
    getMarket: (ref: { marketId: string }) =>
      call("GET", "/v1/markets/:id", { params: { id: ref.marketId } }),
    /** The spec bytes, accepted only if keccak256(bytes) is the `specHash` the caller already trusts. */
    async getMarketSpec(ref: { marketId: string }, specHash: string) {
      const { url } = target("GET", "/v1/markets/:id/spec", {
        params: { id: ref.marketId },
      });
      const bytes = await send(url);
      if (keccak256(bytes) !== specHash.toLowerCase())
        throw new Error("SPEC_HASH_MISMATCH");
      const parsed = parseMarketSpec(bytes);
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.spec;
    },
    listDisputes: (ref: { marketId: string }, query: After = {}) =>
      call("GET", "/v1/markets/:id/disputes", { params: { id: ref.marketId }, query }),
    getDispute: (ref: { disputeId: string }, query: After & { round?: number } = {}) =>
      call("GET", "/v1/disputes/:id", { params: { id: ref.disputeId }, query }),
    getFees: (ref: { marketId: string }) =>
      call("GET", "/v1/markets/:id/fees", { params: { id: ref.marketId } }),
    getAccount: (ref: { address: string }) =>
      call("GET", "/v1/accounts/:address", { params: { address: ref.address } }),
    getPositions: (ref: { address: string }, query: After = {}) =>
      call("GET", "/v1/accounts/:address/positions", {
        params: { address: ref.address },
        query,
      }),
    listTemplates: (query: After = {}) => call("GET", "/v1/templates", { query }),
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
    // --- signed forecasts ---
    /** The market's windows with their schedule (unix seconds) and, once closed, their Merkle roots. */
    listForecastWindows: (ref: { marketId: string }, page: Page = {}) =>
      call("GET", "/v1/markets/:id/forecast-windows", {
        params: { id: ref.marketId },
        query: page,
      }),
    /**
     * forecast:write and the FORECASTER role. `{ horizon, scheduledAt, probabilityBps, contentHash,
     * signature }`, where the signature covers `forecastTypedData` for the key's wallet. Answers
     * `{ digest, leaf }`.
     */
    submitForecast: (ref: { marketId: string }, input: unknown, key?: string) =>
      call("POST", "/v1/markets/:id/forecasts", {
        params: { id: ref.marketId },
        body: input,
        key,
      }),
    /** A window's answers; before its deadline only the key's own (sealed). */
    listForecasts: (ref: { marketId: string }, query: Page & { windowId: string }) =>
      call("GET", "/v1/markets/:id/forecasts", {
        params: { id: ref.marketId },
        query,
      }),
    /** Withdraws the key's own answer before the window's deadline. */
    withdrawForecast: (ref: { submissionId: string }) =>
      call("POST", "/v1/forecasts/:id/withdrawal", {
        params: { id: ref.submissionId },
      }),
    /** The window's root, sorted leaves and BlinkAnchor record; empty until its deadline. */
    getForecastWindow: (ref: { windowId: string }) =>
      call("GET", "/v1/forecast-windows/:id", { params: { id: ref.windowId } }),
    /** The sibling path of a leaf, for OpenZeppelin MerkleProof.verify against the root. */
    getForecastProof: (ref: { windowId: string }, leaf: string) =>
      call("GET", "/v1/forecast-windows/:id/proof", {
        params: { id: ref.windowId },
        query: { leaf },
      }),
    /** The credit-weighted consensus of the market's closed windows. */
    getConsensus: (ref: { marketId: string }, page: Page = {}) =>
      call("GET", "/v1/markets/:id/consensus", {
        params: { id: ref.marketId },
        query: page,
      }),
    listForecasters: (page: Page = {}) =>
      call("GET", "/v1/forecasters", { query: { sort: "weight", ...page } }),
    getForecaster: (ref: { address: string }) =>
      call("GET", "/v1/forecasters/:address", { params: { address: ref.address } }),
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
/**
 * What a forecaster signs: the typed data of its answer, bound to the deployment's BlinkAnchor
 * (`shared.anchor` of the manifest) and BlinkMarkets, the market and the window.
 */
export {
  FORECAST_HORIZONS,
  NO_CONTENT_HASH,
  forecastTypedData,
  forecastTypes,
  type ForecastMessage,
} from "@blink/schemas";
/** The EIP-712 digest of a forecast: what the platform returns as `digest`. */
export const forecastDigest = (input: { anchor: string; message: ForecastMessage }) =>
  hashTypedData(forecastTypedData(input));
/** The leaf of a digest in the window tree: keccak256(keccak256(digest)), what BlinkAnchor may anchor. */
export const forecastLeaf = (digest: string): Hex =>
  keccak256(keccak256(digest as Hex));
export {
  DEFAULT_MIN_VALIDITY_SECONDS,
  QuoteVerificationError,
  approvalFor,
  feeOf,
  takerCostOf,
  quoteTypedData,
  verifySignedQuote,
  type QuoteVerificationCode,
  type QuoteVerificationContext,
  type VerifiedQuote,
} from "./verify-quote.ts";
export { agentAbi } from "./agent-abi.ts";
export {
  CREATION_GROUND,
  MARKET_STATE,
  OUTCOME,
  QUESTION_CLASS,
  ROLE,
  templateIdFor,
  voteCommitment,
} from "./protocol-constants.ts";
export {
  GM_LT_V1,
  gmLtV1Outcome,
  parseGrossMargin,
  type GrossMarginResult,
} from "./templates/index.ts";
/** Re-exported so that an agent reads a MarketSpec without importing the schemas package. */
export { parseMarketSpec, type MarketSpecV02 } from "@blink/schemas";
