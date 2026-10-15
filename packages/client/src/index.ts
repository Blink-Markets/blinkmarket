import { keccak256 } from "viem";
import {
  ApiError,
  ConfigResponse,
  IdempotencyHeaders,
  MarketSpec,
  apiContracts,
  type ApiContract,
  type PublicMarketRef,
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
type MarketKey = Pick<PublicMarketRef, "deploymentId" | "marketId">;
type Page = { limit?: number; cursor?: string };

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
    !(
      base.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    )
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
  const json = (bytes: Uint8Array): unknown =>
    JSON.parse(new TextDecoder().decode(bytes));
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
    const body = contract.body!.parse(args.body);
    const key = args.key ?? crypto.randomUUID();
    IdempotencyHeaders.parse({ "idempotency-key": key });
    return contract.response.parse(
      json(
        await send(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        }),
      ),
    ) as Out<M, P>;
  }
  const marketParams = (ref: MarketKey) => ({
    params: { id: ref.marketId },
    query: { deploymentId: ref.deploymentId },
  });
  return {
    // --- identity ---
    createWalletChallenge: (input: unknown, key?: string) =>
      call("POST", "/v1/auth/wallet-challenges", {
        body: input,
        key,
      }),
    verifyWallet: (input: unknown, key?: string) =>
      call("POST", "/v1/auth/wallet-verifications", {
        body: input,
        key,
      }),
    // --- candidates, evidence and approval ---
    createCandidate: (input: unknown, key?: string) =>
      call("POST", "/v1/candidates", {
        body: input,
        key,
      }),
    reviseCandidate: (id: string, input: unknown, key?: string) =>
      call("POST", "/v1/candidates/:id/revisions", {
        params: { id },
        body: input,
        key,
      }),
    getCandidate: (id: string) =>
      call("GET", "/v1/candidates/:id", { params: { id } }),
    getEvidence: (id: string) =>
      call("GET", "/v1/evidence/:id", { params: { id } }),
    rejectCandidate: (id: string, input: unknown, key?: string) =>
      call("POST", "/v1/admin/candidates/:id/reject", {
        params: { id },
        body: input,
        key,
      }),
    approveCandidate: (id: string, input: unknown, key?: string) =>
      call("POST", "/v1/admin/candidates/:id/approve", {
        params: { id },
        body: input,
        key,
      }),
    getCreationIntent: (id: string) =>
      call("GET", "/v1/admin/creation-intents/:id", { params: { id } }),
    getCreationChainStatus: (id: string) =>
      call("GET", "/v1/admin/creation-intents/:id/chain-status", {
        params: { id },
      }),
    // --- config and markets ---
    getConfig: async () => ConfigResponse.parse(json(await send("/v1/config"))),
    listMarkets: (
      query: Page & {
        deploymentId?: string;
        mode?: "LIVE" | "REPLAY";
        status?: "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL";
        entity?: string;
      } = {},
    ) => call("GET", "/v1/markets", { query }),
    // `mode` is part of the reference but not of the request: the market is `marketId` in a deployment.
    getMarket: (ref: PublicMarketRef) =>
      call("GET", "/v1/markets/:id", marketParams(ref)),
    /** The spec bytes, accepted only if keccak256(bytes) is the `specHash` the caller already trusts. */
    async getMarketSpec(ref: MarketKey, specHash: string) {
      const { url } = target("GET", "/v1/markets/:id/spec", marketParams(ref));
      const bytes = await send(url);
      if (keccak256(bytes) !== specHash.toLowerCase())
        throw new Error("SPEC_HASH_MISMATCH");
      return MarketSpec.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    },
    // --- forecasts ---
    listForecastWindows: (ref: MarketKey, page: Page = {}) =>
      call("GET", "/v1/markets/:id/forecast-windows", {
        params: marketParams(ref).params,
        query: { deploymentId: ref.deploymentId, ...page },
      }),
    submitForecast: (ref: MarketKey, input: unknown, key?: string) =>
      call("POST", "/v1/markets/:id/forecasts", {
        ...marketParams(ref),
        body: input,
        key,
      }),
    listForecasts: (ref: MarketKey, query: Page & { windowId: string }) =>
      call("GET", "/v1/markets/:id/forecasts", {
        params: marketParams(ref).params,
        query: { deploymentId: ref.deploymentId, ...query },
      }),
    // --- quotes and transactions ---
    requestQuote: (input: unknown, key?: string) =>
      call("POST", "/v1/rfqs", { body: input, key }),
    getQuote: (quoteId: string) =>
      call("GET", "/v1/quotes/:quoteId", { params: { quoteId } }),
    trackTransaction: (input: unknown, key?: string) =>
      call("POST", "/v1/transactions", {
        body: input,
        key,
      }),
    getTransaction: (ref: { deploymentId: string; txHash: string }) =>
      call("GET", "/v1/transactions/:txHash", {
        params: { txHash: ref.txHash },
        query: { deploymentId: ref.deploymentId },
      }),
    getPositions: (
      ref: { deploymentId: string; address: string },
      page: Page = {},
    ) =>
      call("GET", "/v1/accounts/:address/positions", {
        params: { address: ref.address },
        query: { deploymentId: ref.deploymentId, ...page },
      }),
    // --- resolution, faucet and metrics ---
    submitResolutionReport: (ref: MarketKey, input: unknown, key?: string) =>
      call("POST", "/v1/markets/:id/resolution-reports", {
        ...marketParams(ref),
        body: input,
        key,
      }),
    getResolution: (ref: MarketKey) =>
      call("GET", "/v1/markets/:id/resolution", marketParams(ref)),
    claimFaucet: (input: unknown, key?: string) =>
      call("POST", "/v1/faucet/claims", {
        body: input,
        key,
      }),
    getMetrics: (mode: "LIVE" | "REPLAY") =>
      call("GET", "/v1/metrics", { query: { mode } }),
  };
}
export type { MarketRef as PublicMarketRef } from "@blink/schemas";
export {
  QuoteVerificationError,
  verifySignedQuote,
  type QuoteVerificationCode,
  type QuoteVerificationContext,
} from "./verify-quote.ts";
