import {
  AdminPauseResponse,
  AdminJobsResponse,
  JobState,
} from "./operator-status.ts";
import { z } from "zod";
import { AdminMetricsResponse, HealthResponse } from "./health.ts";
import { PublicDeployment } from "./deployment-v1.ts";
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
  Hash,
  MarketSpec,
  Mode,
  Outcome,
  PositiveUint256,
  Quote,
  Uint256,
  Uint64,
  TransactionState,
} from "./core.ts";

const Id = z.uuid();
const Text = z.string().min(1).max(4000);
const Time = z.iso.datetime();
const EvidenceIds = z.array(Id).min(1).max(50);
const Side = z.enum(["YES", "NO"]);
const Horizon = z.strictObject({
  horizonType: z.enum(["DAILY", "PRE_CLOSE"]),
  scheduledAt: Time,
});
export const Probability = z
  .number()
  .finite()
  .min(0)
  .max(1)
  .refine((v) => Number(v.toFixed(6)) === v, "At most six decimal places");
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
export const RfqRequest = z.strictObject({
  deploymentId: DeploymentId,
  marketId: PositiveUint256,
  side: Side,
  quantity: Uint64.refine((v) => BigInt(v) > 0n && BigInt(v) <= 100n),
  maxCostMicros: Uint256,
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
export const SignedQuoteResponse = z.strictObject({
  deploymentId: DeploymentId,
  quoteId: Hash,
  marketId: PositiveUint256,
  mode: Mode,
  chainId: z.literal(84532),
  verifyingContract: Address,
  domain: z.strictObject({
    name: z.literal("Blink RFQ"),
    version: z.literal("0.1"),
    chainId: z.literal(84532),
    verifyingContract: Address,
  }),
  types: z.strictObject({
    Quote: z
      .array(z.strictObject({ name: z.string(), type: z.string() }))
      .length(11),
  }),
  message: Quote,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  takerCostMicros: Uint256,
  makerCostMicros: Uint256,
  expiresAt: Uint64,
  calldata: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),
  forecastSnapshotId: Id,
  chainCursor: ChainCursor,
});
const Ref = {
  deploymentId: DeploymentId,
  marketId: PositiveUint256,
  mode: Mode,
};
const Summary = z.strictObject({
  ...Ref,
  specHash: Hash,
  storedState: z.enum(["PENDING", "OPEN", "PROPOSED", "DISPUTED", "FINAL", "CANCELLED"]),
  effectiveState: z.enum(["PENDING", "OPEN", "CLOSED", "PROPOSED", "DISPUTED", "FINAL", "CANCELLED"]),
  paused: z.boolean(),
  canTrade: z.boolean(),
  reasons: z.array(z.string()),
  chainCursor: ChainCursor,
});
const Window = z.strictObject({
  windowId: Id,
  horizonKey: Horizon,
  openAt: Time,
  deadline: Time,
  status: z.enum(["UPCOMING", "OPEN", "CLOSED"]),
});
const Forecast = z.strictObject({
  submissionId: Id,
  agentId: Id,
  windowId: Id,
  probability: Probability,
  receivedAt: Time,
  evidenceIds: EvidenceIds,
  rationale: Text,
  agentVersion: Text,
  withdrawnAt: Time.nullable(),
  contaminated: z.boolean(),
});
const Resolution = z.strictObject({
  ...Ref,
  proposedOutcome: Outcome.nullable(),
  finalOutcome: Outcome.nullable(),
  proposalEvidenceHash: Hash.nullable(),
  finalEvidenceHash: Hash.nullable(),
  proposedAt: Time.nullable(),
  challengeEndsAt: Time.nullable(),
  hardDeadline: Time,
  chainCursor: ChainCursor,
});
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
  operation("GET", "/v1/markets", list(Summary), {
    query: ListQuery.extend({
      deploymentId: DeploymentId.optional(),
      mode: Mode.optional(),
      status: z
        .enum(["PENDING", "OPEN", "CLOSED", "PROPOSED", "DISPUTED", "FINAL", "CANCELLED"])
        .optional(),
    }),
  }),
  operation(
    "GET",
    "/v1/markets/:id",
    Summary.extend({
      spec: MarketSpec,
      resolution: Resolution,
    }),
  ),
  operation("GET", "/v1/markets/:id/spec", MarketSpec),
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
  operation("GET", "/v1/markets/:id/forecast-windows", list(Window), {
    query: ListQuery.extend({ deploymentId: DeploymentId }),
  }),
  operation(
    "POST",
    "/v1/markets/:id/forecasts",
    z.strictObject({ submissionId: Id, receivedAt: Time, windowId: Id }),
    {
      body: z.strictObject({
        horizonKey: Horizon,
        probability: Probability,
        evidenceIds: EvidenceIds,
        rationale: Text,
        agentVersion: Text,
      }),
      access: "forecast:write",
      status: 201,
    },
  ),
  operation("GET", "/v1/markets/:id/forecasts", list(Forecast), {
    query: ListQuery.extend({ deploymentId: DeploymentId, windowId: Id }),
    access: "public; own before deadline",
  }),
  operation(
    "POST",
    "/v1/transactions",
    z.strictObject({ trackingId: Id, status: z.literal("UNKNOWN") }),
    {
      body: z
        .strictObject({
          deploymentId: DeploymentId,
          txHash: Hash,
          action: z.enum(["APPROVE", "FILL", "REDEEM"]),
          quoteId: Hash.optional(),
        })
        .refine(
          (v) => v.action !== "FILL" || v.quoteId !== undefined,
          "FILL requires quoteId",
        ),
      status: 202,
      access: "verified-wallet",
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
    "/v1/accounts/:address/positions",
    list(
      z.strictObject({
        ...Ref,
        yesShares: Uint256,
        noShares: Uint256,
        payoutMicros: Uint256.nullable(),
        pendingIntentIds: z.array(Id),
        chainCursor: ChainCursor,
      }),
    ),
    { query: ListQuery.extend({ deploymentId: DeploymentId }) },
  ),
  operation("GET", "/v1/markets/:id/resolution", Resolution),
  operation(
    "GET",
    "/v1/metrics",
    z.strictObject({
      mode: Mode,
      eventCount: Uint256,
      missingCount: Uint256,
      invalidCount: Uint256,
      brier: z.number().min(0).max(1).nullable(),
    }),
    { query: z.strictObject({ mode: Mode }) },
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
    const responses: Record<string, unknown> = Object.fromEntries(
      [400, 401, 403, 404, 409, 429, 500, 501, 503].map((code) => [
        String(code),
        {
          description:
            code === 501
              ? "Planned operation; no business implementation"
              : "API error",
          content: { "application/json": { schema: json(ApiError) } },
        },
      ]),
    );
    responses[c.status] = {
      description: enabledPaths.includes(c.path)
        ? "Success"
        : "Planned success contract (not yet enabled)",
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
