import {
  AdminPauseResponse,
  AdminJobsResponse,
  JobState,
} from "./operator-status.ts";
import { z } from "zod";
import { AdminMetricsResponse, HealthResponse } from "./health.ts";
import { PublicDeployment } from "./deployment-v1.ts";
import {
  AccountResponse,
  DeploymentResponse,
  DisputeDetail,
  DisputesPage,
  FeesResponse,
  MarketDetail,
  MarketsPage,
  PositionsPage,
  ReadPageQuery,
  TemplatesPage,
} from "./read-api.ts";
import { MarketStateName } from "./protocol.ts";
import {
  ConsensusItem,
  ForecastProof,
  ForecastReceipt,
  ForecastSubmission,
  ForecastView,
  ForecastWindowRecord,
  ForecastWindowView,
  ForecastWithdrawal,
  ForecasterView,
  SignatureHex,
} from "./research.ts";
import {
  WalletChallengeRequest,
  WalletChallengeResponse,
  WalletVerificationRequest,
  WalletVerificationResponse,
} from "./identity.ts";
import {
  Address,
  ApiError,
  ChainCursor,
  DeploymentId,
  DecimalInteger,
  Hash,
  Mode,
  Outcome,
  PositiveUint256,
  Uint256,
  Uint64,
  TransactionState,
} from "./core.ts";

const Id = z.uuid();
const Time = z.iso.datetime();
const Side = z.enum(["YES", "NO"]);
/** Media types /v1/content stores and serves; anything else is refused. */
export const CONTENT_MEDIA_TYPES = [
  "application/json",
  "text/plain",
  "text/csv",
  "text/html",
  "application/pdf",
] as const;
/** The largest object one upload may store: 1 MiB. */
export const CONTENT_MAX_BYTES = 1_048_576;
/** The largest suggestion request body: 8 KiB. */
export const SUGGESTION_MAX_BODY_BYTES = 8192;
const codePoints = (value: string) => Array.from(value).length;
export const SuggestionRequest = z.strictObject({
  // Counted in code points, as PostgreSQL's char_length does; NUL cannot be stored.
  text: z
    .string()
    .trim()
    .refine(
      (v) => codePoints(v) >= 20 && codePoints(v) <= 2000 && !v.includes("\0"),
      "Text must be 20 to 2000 characters",
    ),
  // Only recorded, never fetched.
  sourceUrls: z
    .array(
      z
        .url({ protocol: /^https$/ })
        .max(2048)
        .refine((v) => {
          if (!URL.canParse(v)) return false;
          const url = new URL(v);
          return !url.username && !url.password;
        }, "No credentials in a source URL"),
    )
    .max(5)
    .optional(),
});
export const SuggestionStatus = z.enum(["OPEN", "CLAIMED", "MARKET_CREATED"]);
const Suggestion = z.strictObject({
  id: Id,
  text: z.string(),
  sourceUrls: z.array(z.string()),
  status: SuggestionStatus,
  claimCount: z.number().int().min(0),
  specHashes: z.array(Hash),
  createdAt: Time,
});
/** An RFQ stays open this long; a taker may hold at most MAX_OPEN_RFQS open ones. */
export const RFQ_TTL_SECONDS = 30;
export const MAX_OPEN_RFQS = 5;
/** One RFQ holds at most this many quotes, one per maker. */
export const MAX_QUOTES_PER_RFQ = 20;
/** BlinkMarkets refuses a quote that lives longer than this. */
export const MAX_QUOTE_LIFETIME_SECONDS = 60;
/** Room for the quote fields and a signature of up to 8192 bytes (a contract wallet may sign long). */
export const RFQ_BODY_MAX_BYTES = 20_000;
/** A forecast body: five short fields and a signature of up to 8192 bytes. */
export const FORECAST_BODY_MAX_BYTES = 20_000;
export const RfqRequest = z.strictObject({
  marketId: PositiveUint256,
  side: Side,
  quantity: Uint64.refine((v) => BigInt(v) > 0n, "quantity must be positive"),
});
/**
 * The eleven fields of the EIP-712 Quote, as the maker signed them (decimal strings, side "0" for
 * YES and "1" for NO). Range rules (price, lifetime, epoch) are checked by the relay so that each
 * refusal carries its own code.
 */
export const QuoteFields = z.strictObject({
  marketId: PositiveUint256,
  specHash: Hash,
  maker: Address,
  taker: Address,
  side: z.enum(["0", "1"]),
  quantity: Uint64,
  priceBps: DecimalInteger.refine((v) => BigInt(v) <= 65535n, "uint16 overflow"),
  validAfter: Uint64,
  expiresAt: Uint64,
  nonce: Uint256,
  epoch: Uint256,
});
export type QuoteFields = z.infer<typeof QuoteFields>;
export const SignedQuote = z.strictObject({
  quote: QuoteFields,
  signature: SignatureHex,
});
export type SignedQuote = z.infer<typeof SignedQuote>;
export const RfqView = z.strictObject({
  rfqId: Id,
  marketId: PositiveUint256,
  specHash: Hash,
  side: Side,
  quantity: Uint64,
  taker: Address,
  expiresAt: z.number().int().min(0),
});
export const MakerStats = z.strictObject({
  quotesRelayed: z.number().int().min(0),
  quotesFilled: z.number().int().min(0),
  quotesCancelledBeforeExpiry: z.number().int().min(0),
});
const AfterQuery = z.strictObject({
  after: z.string().regex(/^[0-9]{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ConfigResponse = z.strictObject({
  chainId: z.literal(84532),
  stage: z.enum(["architecture", "m2-identity", "m2-markets", "m2-trading"]),
  tradingEnabled: z.boolean(),
  deployment: z.union([z.null(), PublicDeployment]),
  asset: z.strictObject({
    name: z.literal("Blink Test USD"),
    symbol: z.literal("bUSD"),
    decimals: z.literal(6),
    hasValue: z.literal(false),
  }),
});
export type ConfigResponse = z.infer<typeof ConfigResponse>;
const ListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(1024).optional(),
  })
  .strict();
const list = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
const noQuery = z.strictObject({});
const deploymentQuery = z.strictObject({ deploymentId: DeploymentId });
export const IdempotencyHeaders = z
  .object({ "idempotency-key": z.string().regex(/^[\x21-\x7e]{1,128}$/) })
  .loose();
export type HttpContract = {
  method: "GET" | "POST";
  path: string;
  params: z.ZodObject;
  query: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
  status: number;
  access: string;
  /** false: the operation takes no Idempotency-Key header (default true for POST). */
  idempotencyKey?: boolean;
  description?: string;
  /** The request body is raw bytes of one of these media types, at most maxBytes (no JSON body schema). */
  rawRequest?: { mediaTypes: readonly string[]; maxBytes: number };
  /** The response is the stored bytes, served with the stored media type. */
  rawResponse?: boolean;
  /** Response headers this operation always sets (name -> description), for the OpenAPI document. */
  responseHeaders?: Record<string, string>;
  /** Request body limit in bytes where it differs from the service default. */
  bodyLimit?: number;
};
// The literal method, path and response types stay visible, so clients can type each call.
function operation<
  M extends "GET" | "POST",
  P extends string,
  R extends z.ZodType,
>(
  method: M,
  path: P,
  response: R,
  options: Partial<Omit<HttpContract, "method" | "path" | "response">> = {},
): HttpContract & { method: M; path: P; response: R } {
  const params: Record<string, z.ZodType> = {};
  for (const [, name] of path.matchAll(/:([A-Za-z]+)/g)) {
    params[name!] =
      name === "address"
        ? Address
        : name === "txHash" ||
            name === "quoteId" ||
            name === "specHash" ||
            name === "hash"
          ? Hash
          : path.startsWith("/v1/markets/")
            ? PositiveUint256
            : Id;
  }
  return {
    method,
    path,
    response,
    params: z.strictObject(params),
    query:
      path.startsWith("/v1/markets/:id") ||
      path.includes("/positions") ||
      path.includes("/transactions/:")
        ? deploymentQuery
        : noQuery,
    status: 200,
    access: "public",
    ...options,
  } as HttpContract & { method: M; path: P; response: R };
}
const contracts = [
  operation("GET", "/v1/admin/pause", AdminPauseResponse, { access: "admin" }),
  operation("GET", "/v1/admin/jobs", AdminJobsResponse, {
    access: "admin",
    query: z.strictObject({ state: JobState.default("DEAD") }),
  }),
  operation("GET", "/v1/admin/metrics", AdminMetricsResponse, {
    access: "admin",
  }),
  operation("POST", "/v1/auth/wallet-challenges", WalletChallengeResponse, {
    body: WalletChallengeRequest,
    access: "public",
    status: 201,
    idempotencyKey: false,
    description:
      "Public; no API key. Not idempotent: every call creates a new challenge (valid 300 seconds). Limits: 30 per hour per client IP, and per (client IP, address) 10 per hour and 5 pending challenges.",
  }),
  operation(
    "POST",
    "/v1/auth/wallet-verifications",
    WalletVerificationResponse,
    {
      body: WalletVerificationRequest,
      access: "public",
      idempotencyKey: false,
      description:
        "Public; no API key. Single use: a challenge issues or revokes once, then answers 409. Verification attempts are limited per challenge and per client IP. The apiKey secret is shown only in the first successful issue response.",
    },
  ),
  operation("GET", "/v1/deployment", DeploymentResponse, {
    description:
      "The current protocol deployment manifest (blink.deployment/2): chain, contract addresses, generation and the Params that bind every rule.",
  }),
  operation("GET", "/v1/markets", MarketsPage, {
    query: ReadPageQuery.extend({ state: MarketStateName.optional() }),
    description:
      "Markets in id order, paged by after/limit (at most 100). Each item carries the parseMarketSpec result of its stored spec bytes, or the reason there is none (SPEC_UNAVAILABLE); an unreadable spec never hides a market.",
  }),
  operation("GET", "/v1/markets/:id", MarketDetail, {
    query: noQuery,
    description:
      "The market, the parseMarketSpec result of its spec bytes, and its proposal (null before one).",
  }),
  operation("GET", "/v1/markets/:id/spec", z.string(), {
    query: noQuery,
    rawResponse: true,
    responseHeaders: {
      "Blink-Index-Stale": "true or false: the index freshness rule (IndexHealth.stale)",
      "Blink-Index-Indexed-Block": "IndexHealth.indexedBlock",
      "Blink-Index-Head-Block": "IndexHealth.headBlock",
      "Blink-Index-Lag-Seconds": "IndexHealth.lagSeconds",
    },
    description:
      "The exact stored spec bytes with the stored media type, served like GET /v1/content/:hash except for Cache-Control: no-cache, because the body is immutable but the index health is not. The raw body cannot carry IndexHealth, so every answer (success, 404, 503) sets the Blink-Index-* headers. 503 SPEC_UNAVAILABLE when the platform holds no intact bytes for the market's specHash.",
  }),
  operation("GET", "/v1/markets/:id/disputes", DisputesPage, {
    query: ReadPageQuery,
    description: "A market's disputes in id order.",
  }),
  operation("GET", "/v1/disputes/:id", DisputeDetail, {
    params: z.strictObject({ id: PositiveUint256 }),
    query: ReadPageQuery.extend({ round: z.coerce.number().int().min(0).optional() }),
    description:
      "The dispute with all its rounds, and a page of votes in (round, juror) order. A vote's choice is null until its reveal.",
  }),
  operation("GET", "/v1/markets/:id/fees", FeesResponse, {
    query: noQuery,
    description:
      "How the market's fee pool was split by distributeFees, recomputed from the deployment Params and the final outcome; fees is null until it ran.",
  }),
  operation("GET", "/v1/accounts/:address", AccountResponse, {
    description:
      "Roles, credit per role decayed to the request time, and juror state. 404 for an address the index has not seen register.",
  }),
  operation("GET", "/v1/accounts/:address/positions", PositionsPage, {
    query: ReadPageQuery,
    description: "An account's positions in market-id order.",
  }),
  operation("GET", "/v1/templates", TemplatesPage, {
    query: ReadPageQuery,
    description: "Registered question templates in template-id order.",
  }),
  operation(
    "POST",
    "/v1/content",
    z.strictObject({
      hash: Hash,
      size: z.number().int().min(1).max(CONTENT_MAX_BYTES),
      mediaType: z.enum(CONTENT_MEDIA_TYPES),
      uri: z.url(),
    }),
    {
      access: "content:write",
      status: 201,
      idempotencyKey: false,
      rawRequest: {
        mediaTypes: CONTENT_MEDIA_TYPES,
        maxBytes: CONTENT_MAX_BYTES,
      },
      bodyLimit: CONTENT_MAX_BYTES,
      description:
        "The body is the raw bytes (at most 1 MiB) with a Content-Type of application/json, text/plain, text/csv, text/html or application/pdf. Needs a registered address and the content:write scope. Stored at keccak256(bytes); storing the same bytes again returns the first record. A market spec naming an existing suggestionId is linked to that suggestion.",
    },
  ),
  operation("GET", "/v1/content/:hash", z.string(), {
    rawResponse: true,
    description:
      "The exact stored bytes with the stored media type, immutable, nosniff and a sandbox Content-Security-Policy. text/html is served as an attachment.",
  }),
  operation("POST", "/v1/suggestions", z.strictObject({ id: Id }), {
    body: SuggestionRequest,
    status: 201,
    idempotencyKey: false,
    bodyLimit: SUGGESTION_MAX_BODY_BYTES,
    description:
      "Public; no API key. Not idempotent: each call adds a suggestion. Limits: 5 per hour per client IP and 500 per day overall. A suggestion creates no on-chain right and no write access.",
  }),
  operation("GET", "/v1/suggestions", list(Suggestion), {
    query: ListQuery.extend({ status: SuggestionStatus.optional() }),
    description:
      "Newest first. The status is derived at read time: MARKET_CREATED if a linked spec has a market, else CLAIMED if a Creator claimed it, else OPEN.",
  }),
  operation("GET", "/v1/suggestions/:id", Suggestion),
  operation("POST", "/v1/suggestions/:id/claims", Suggestion, {
    access: "suggestion:claim",
    status: 201,
    idempotencyKey: false,
    description:
      "Needs the suggestion:claim scope and the CREATOR role in the indexed current generation. One claim per creator; claims are informational and give no exclusivity.",
  }),
  operation("GET", "/v1/markets/:id/forecast-windows", list(ForecastWindowView), {
    query: ListQuery,
    description:
      "The market's forecast windows in (scheduledAt, horizon) order. openAt and deadline are unix seconds, so an agent learns the schedule here; a window's root appears once the deadline passed and the worker stored it.",
  }),
  operation("POST", "/v1/markets/:id/forecasts", ForecastReceipt, {
    body: ForecastSubmission,
    query: noQuery,
    access: "forecast:write",
    status: 201,
    bodyLimit: FORECAST_BODY_MAX_BYTES,
    description:
      "Needs the forecast:write scope and the FORECASTER role in the indexed current generation. The signature must be the EIP-712 Forecast struct (domain \"Blink Forecast\" 1, chain 84532, verifyingContract the manifest's shared.anchor) for the key's wallet, the route's market, this deployment's BlinkMarkets and the window named by horizon and scheduledAt; EOA, ERC-1271 and ERC-6492 signatures are accepted and the checked block is stored as verifiedBlock. Admitted by the database clock between the window's openAt and deadline, once per forecaster per window; needs an Idempotency-Key, and repeating the identical submission (same key or not) returns the same receipt. Answers: digest and leaf. Refused with 503 INDEX_STALE while the index lags and 503 SIGNATURE_CHECK_UNAVAILABLE when the signature cannot be checked; a refused forecast is never stored. Answers are sealed: nobody else can read one before the window's deadline.",
  }),
  operation("GET", "/v1/markets/:id/forecasts", list(ForecastView), {
    query: ListQuery.extend({ windowId: z.uuid() }),
    access: "public; own before deadline",
    description:
      "A window's answers with their signatures. Before the deadline only the caller's own answer is returned (send the API key); an anonymous caller sees none. Withdrawn answers stay listed with withdrawnAt.",
  }),
  operation("POST", "/v1/forecasts/:id/withdrawal", ForecastWithdrawal, {
    access: "forecast:write",
    idempotencyKey: false,
    description:
      "The forecaster withdraws its own answer by submission id, before the window's deadline. A withdrawn answer stays stored (an annotation, not a deletion) but leaves the Merkle root, the consensus and the scores. Withdrawing twice returns the first withdrawal.",
  }),
  operation("GET", "/v1/forecast-windows/:id", ForecastWindowRecord, {
    description:
      "The window with its Merkle root, its sorted leaves and the BlinkAnchor record of the root (null until anyone anchored it). Before the deadline root and leaves are empty. The platform never anchors: any agent may call BlinkAnchor.anchor(root), and a forecaster may anchor its own single leaf.",
  }),
  operation("GET", "/v1/forecast-windows/:id/proof", ForecastProof, {
    query: z.strictObject({ leaf: Hash }),
    description:
      "The sibling path of a leaf, checkable with OpenZeppelin MerkleProof.verify against the root. 409 WINDOW_SEALED before the deadline, 409 ROOT_PENDING until the worker stored the root, 404 LEAF_NOT_FOUND for a leaf the window does not hold.",
  }),
  operation("GET", "/v1/markets/:id/consensus", list(ConsensusItem), {
    query: ListQuery,
    description:
      "The credit-weighted consensus of every closed window of the market, with the number of answers and whether the outcome was already public at the deadline. Weights are frozen as of each window's deadline. Open windows are not listed.",
  }),
  operation("GET", "/v1/forecasters", list(ForecasterView), {
    query: ListQuery.extend({ sort: z.literal("weight").default("weight") }),
    description:
      "Forecasters by credit weight, highest first: n and meanBrier come from the latest 50 scored LIVE submissions, and the weight (an exact fraction, weightNumerator / weightDenominator in lowest terms) is 0 below 5 of them, else max(0, 0.25 - meanBrier). Ordered by exact weight, then more scored answers, then address ascending. The cursor is the exact boundary of the last row, `<weightNumerator>/<weightDenominator>:<n>:<address>`; the next page holds the rows after it, so a score that changes between pages never repeats or skips a row (a malformed cursor is 400 INVALID_CURSOR). Informational: it gates nothing.",
  }),
  operation("GET", "/v1/forecasters/:address", ForecasterView, {
    description: "One forecaster's credit; 404 for an address that never submitted.",
  }),
  operation(
    "POST",
    "/v1/rfqs",
    z.strictObject({ rfqId: Id, expiresAt: z.number().int().min(0) }),
    {
      body: RfqRequest,
      access: "rfq:write",
      status: 201,
      idempotencyKey: false,
      bodyLimit: RFQ_BODY_MAX_BYTES,
      description:
        "Needs the rfq:write scope and the TAKER role in the indexed current generation; refused with 503 INDEX_STALE while the index lags. The market must be OPEN before its close time (409 MARKET_NOT_TRADABLE) and 1 <= quantity <= maxFillShares. An RFQ stays open 30 seconds; a taker may hold 5 open RFQs. Not idempotent: each call creates an RFQ. The platform only relays: it never prices, signs or fills.",
    },
  ),
  operation("GET", "/v1/rfqs", z.strictObject({ items: z.array(RfqView), next: z.string().nullable() }), {
    query: AfterQuery,
    access: "rfq:write",
    description:
      "Open RFQs for makers, oldest first. Needs the rfq:write scope and the MAKER role in the indexed current generation. `after` is the `next` of the previous page.",
  }),
  operation(
    "POST",
    "/v1/rfqs/:id/quotes",
    z.strictObject({ digest: Hash }),
    {
      body: SignedQuote,
      access: "rfq:write",
      status: 201,
      idempotencyKey: false,
      bodyLimit: RFQ_BODY_MAX_BYTES,
      description:
        "Needs the rfq:write scope and the MAKER role. The quote must equal the RFQ's taker, market, side and quantity, name the caller as maker, be signed by the maker (EOA, or ERC-1271 for a contract wallet; ERC-6492 wrappers are refused), live at most 60 seconds, expire after now and no later than the market close, carry the maker's current epoch, have an unused digest and be covered by the maker's free balance. One quote per maker per RFQ, 20 per RFQ. The fields and signature bytes are stored and returned unchanged. Refused with 503 INDEX_STALE while the index lags and 503 SIGNATURE_CHECK_UNAVAILABLE when the signature cannot be checked; a refused quote is never stored.",
    },
  ),
  operation(
    "GET",
    "/v1/rfqs/:id/quotes",
    z.strictObject({ items: z.array(SignedQuote) }),
    {
      access: "rfq:write",
      description:
        "Only the RFQ's taker (the key's wallet). Quotes ordered by priceBps ascending, then arrival, exactly as the makers posted them. Verify each one (see @blink/client verifySignedQuote) before approving or filling.",
    },
  ),
  operation("GET", "/v1/makers/:address/stats", MakerStats, {
    description:
      "Public and informational only: quotes relayed, quotes filled (matched by digest against QuoteFilled) and quotes cancelled before they expired (matched against QuoteCancelled). It gates nothing and quotes that bypass the relay are invisible to it.",
  }),
  operation(
    "POST",
    "/v1/transactions",
    z.strictObject({
      trackingId: Id,
      status: z.enum(["UNKNOWN", "INCLUDED", "FINALIZED", "REVERTED", "REORGED"]),
    }),
    {
      body: z.strictObject({ txHash: Hash }),
      status: 202,
      access: "key",
      idempotencyKey: false,
      description:
        "Any API key. Registers a transaction hash for tracking; the sender must be the key's wallet and the target a contract of the current generation, the faucet or the anchor, otherwise the tracked row carries a rejectReason. Posting a hash the same key already tracks returns the same trackingId; a hash tracked by another key answers 409 TX_ALREADY_TRACKED.",
    },
  ),
  operation(
    "GET",
    "/v1/transactions/:txHash",
    z.strictObject({
      deploymentId: DeploymentId,
      txHash: Hash,
      status: TransactionState,
      replacementOf: Hash.nullable(),
      rejectReason: z.string().nullable(),
      chainCursor: ChainCursor.nullable(),
    }),
  ),
  operation(
    "GET",
    "/v1/metrics",
    z.strictObject({
      mode: Mode,
      eventCount: Uint256,
      missingCount: Uint256,
      invalidCount: Uint256,
      brier: z.number().min(0).max(1).nullable(),
      consensusBrier: z.number().min(0).max(1).nullable(),
    }),
    {
      query: z.strictObject({ mode: Mode }),
      description:
        "Per mode, LIVE and REPLAY never mix. eventCount counts markets with an eligible answer; brier is the mean over those markets of the mean agent Brier, consensusBrier the same for the consensus of each window. Contaminated windows, withdrawn answers and INVALID outcomes are left out of both.",
    },
  ),
] satisfies readonly HttpContract[];
export const apiContracts: readonly HttpContract[] = contracts;
/** Every contract with its literal method, path and response types, for typed clients. */
export type ApiContract = (typeof contracts)[number];
const json = (s: z.ZodType) =>
  z.toJSONSchema(s, { target: "draft-2020-12", io: "input" });
export function generateOpenApi(enabledPaths: readonly string[] = []) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const c of apiContracts) {
    const path = c.path.replace(/:([A-Za-z]+)/g, "{$1}");
    const parameters = [
      ...Object.entries(c.params.shape).map(([name, s]) => ({
        name,
        in: "path",
        required: true,
        schema: json(s as z.ZodType),
      })),
      ...Object.entries(c.query.shape).map(([name, s]) => ({
        name,
        in: "query",
        required: !(s as z.ZodType).isOptional(),
        schema: json(s as z.ZodType),
      })),
      ...(c.method === "POST" && c.idempotencyKey !== false
        ? [
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 128 },
            },
          ]
        : []),
    ];
    const declared = c.responseHeaders
      ? {
          headers: Object.fromEntries(
            Object.entries(c.responseHeaders).map(([name, description]) => [
              name,
              { description, schema: { type: "string" } },
            ]),
          ),
        }
      : {};
    // A route that declares response headers sets them on the answers its own handler produces
    // (success, 404, 503), not on early refusals such as 400 or 429.
    const handlerErrors = [404, 503];
    const responses: Record<string, unknown> = Object.fromEntries(
      [400, 401, 403, 404, 409, 429, 500, 501, 503].map((code) => [
        String(code),
        {
          description:
            code === 501
              ? "Planned operation; no business implementation"
              : "API error",
          ...(handlerErrors.includes(code) ? declared : {}),
          content: { "application/json": { schema: json(ApiError) } },
        },
      ]),
    );
    responses[c.status] = {
      description: enabledPaths.includes(c.path)
        ? "Success"
        : "Planned success contract (not yet enabled)",
      ...declared,
      content: c.rawResponse
        ? {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          }
        : { "application/json": { schema: json(c.response) } },
    };
    (paths[path] ??= {})[c.method.toLowerCase()] = {
      operationId:
        c.method.toLowerCase() + c.path.replace(/[^a-zA-Z0-9]/g, "_"),
      "x-status": enabledPaths.includes(c.path) ? "enabled" : "not-implemented",
      "x-planned-access": c.access,
      ...(c.description ? { description: c.description } : {}),
      parameters,
      security:
        c.access === "public"
          ? []
          : c.access.startsWith("public")
            ? [{}, { ApiKey: [] }]
            : [{ ApiKey: [] }],
      ...(c.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: json(c.body) } },
            },
          }
        : c.rawRequest
          ? {
              requestBody: {
                required: true,
                content: Object.fromEntries(
                  c.rawRequest.mediaTypes.map((type) => [
                    type,
                    { schema: { type: "string", format: "binary" } },
                  ]),
                ),
              },
            }
          : {}),
      responses,
    };
  }
  paths["/v1/health"] = {
    get: {
      security: [{}, { ApiKey: [] }],
      responses: Object.fromEntries(
        [200, 503].map((code) => [
          String(code),
          {
            description: "Readiness; details require an admin key",
            content: { "application/json": { schema: json(HealthResponse) } },
          },
        ]),
      ),
    },
  };
  paths["/v1/config"] = {
    get: {
      responses: {
        "200": {
          description: "Runtime configuration",
          content: { "application/json": { schema: json(ConfigResponse) } },
        },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Blink v0.1 contracts",
      version: "0.1.1",
      description:
        "Shared API contracts. Enabled operations depend on configured adapters; x-status records availability. Trading remains disabled. Refinements and ownership checks are enforced in application code.",
    },
    paths,
    components: {
      securitySchemes: { ApiKey: { type: "http", scheme: "bearer" } },
    },
  };
}
