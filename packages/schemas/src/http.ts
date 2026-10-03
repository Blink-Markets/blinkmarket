import { z } from "zod";
import {
  CandidateInput,
  CandidateRevisionInput,
  CandidateRecord,
  EvidenceMetadata,
  CandidateApprovalRequest,
} from "./preparation.js";
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
export const RfqRequest = z.strictObject({
  deploymentId: DeploymentId,
  marketId: PositiveUint256,
  side: Side,
  quantity: Uint64.refine((v) => BigInt(v) > 0n && BigInt(v) <= 100n),
  maxCostMicros: Uint256,
});
export const ConfigResponse = z.strictObject({
  chainId: z.literal(84532),
  stage: z.enum([
    "architecture",
    "m2-identity",
    "m2-preparation",
    "m2-approval",
  ]),
  tradingEnabled: z.literal(false),
  deployment: z.null(),
  asset: z.strictObject({
    name: z.literal("Blink Test USD"),
    symbol: z.literal("bUSD"),
    decimals: z.literal(6),
    hasValue: z.literal(false),
  }),
});
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
  storedState: z.enum(["OPEN", "PROPOSED", "DISPUTED", "FINAL"]),
  effectiveState: z.enum(["OPEN", "CLOSED", "PROPOSED", "DISPUTED", "FINAL"]),
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
const Candidate = CandidateRecord;
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
};
function operation(
  method: "GET" | "POST",
  path: string,
  response: z.ZodType,
  options: Partial<Omit<HttpContract, "method" | "path" | "response">> = {},
): HttpContract {
  const params: Record<string, z.ZodType> = {};
  for (const [, name] of path.matchAll(/:([A-Za-z]+)/g)) {
    params[name!] =
      name === "address"
        ? Address
        : name === "txHash" || name === "quoteId" || name === "specHash"
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
  };
}
export const apiContracts: readonly HttpContract[] = [
  operation("GET", "/v1/specs/:specHash", MarketSpec),
  operation(
    "GET",
    "/v1/admin/creation-intents/:id",
    z.strictObject({
      creationIntentId: Id,
      approvalId: Id,
      deploymentId: DeploymentId,
      state: z.literal("AWAITING_ADMIN_SIGNATURE"),
      chainId: z.literal(84532),
      to: Address,
      requiredSender: Address,
      value: z.literal("0"),
      specHash: Hash,
      specUri: z.url(),
      calldata: z.string().regex(/^0x[0-9a-f]+$/),
    }),
    { access: "admin" },
  ),
  operation("POST", "/v1/auth/wallet-challenges", WalletChallengeResponse, {
    body: WalletChallengeRequest,
    access: "invited-key",
    status: 201,
  }),
  operation(
    "POST",
    "/v1/auth/wallet-verifications",
    WalletVerificationResponse,
    {
      body: WalletVerificationRequest,
      access: "invited-key",
    },
  ),
  operation(
    "POST",
    "/v1/candidates",
    Candidate.pick({ candidateId: true, revision: true, state: true }),
    {
      body: CandidateInput,
      access: "candidate:write",
      status: 201,
    },
  ),
  operation(
    "GET",
    "/v1/candidates/:id",
    z.strictObject({ candidate: Candidate, revisions: z.array(Candidate) }),
    { access: "owner/admin; approved public" },
  ),
  operation(
    "POST",
    "/v1/candidates/:id/revisions",
    Candidate.pick({ candidateId: true, revision: true, state: true }),
    {
      body: CandidateRevisionInput,
      access: "candidate:write",
    },
  ),
  operation(
    "POST",
    "/v1/admin/candidates/:id/approve",
    z.strictObject({
      approvalId: Id,
      specHash: Hash,
      creationIntentId: Id,
      state: z.literal("DEPLOY_PENDING"),
    }),
    {
      body: CandidateApprovalRequest,
      access: "admin",
      status: 202,
    },
  ),
  operation(
    "POST",
    "/v1/admin/candidates/:id/reject",
    Candidate.pick({ candidateId: true, revision: true, state: true }),
    {
      body: z.strictObject({
        expectedRevision: z.number().int().positive(),
        reasonCode: Text,
        reason: Text,
      }),
      access: "admin",
    },
  ),
  operation("GET", "/v1/markets", list(Summary), {
    query: ListQuery.extend({
      deploymentId: DeploymentId.optional(),
      mode: Mode.optional(),
      status: z
        .enum(["OPEN", "CLOSED", "PROPOSED", "DISPUTED", "FINAL"])
        .optional(),
      entity: z.string().optional(),
    }),
  }),
  operation(
    "GET",
    "/v1/markets/:id",
    Summary.extend({
      spec: MarketSpec,
      resolution: Resolution,
      forecastSnapshotId: Id.nullable(),
      costMicros: Uint256,
    }),
  ),
  operation("GET", "/v1/markets/:id/spec", MarketSpec),
  operation("GET", "/v1/evidence/:id", EvidenceMetadata, {
    access: "access-policy",
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
  operation("POST", "/v1/rfqs", SignedQuoteResponse, {
    body: RfqRequest,
    access: "trade:quote + wallet",
  }),
  operation(
    "GET",
    "/v1/quotes/:quoteId",
    z.strictObject({
      quote: SignedQuoteResponse,
      status: z.enum([
        "SIGNED",
        "SIGN_UNKNOWN",
        "EXPIRED",
        "CANCELLED",
        "CONSUMED",
      ]),
      chainCursor: ChainCursor,
    }),
    { access: "taker/admin" },
  ),
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
  operation(
    "POST",
    "/v1/markets/:id/resolution-reports",
    z.strictObject({ reportId: Id, state: z.literal("RECEIVED") }),
    {
      body: z.strictObject({
        outcome: Outcome,
        evidenceIds: EvidenceIds,
        reason: Text,
      }),
      access: "report:write",
      status: 202,
    },
  ),
  operation("GET", "/v1/markets/:id/resolution", Resolution),
  operation(
    "POST",
    "/v1/faucet/claims",
    z.strictObject({ claimId: Id, intentId: Id, state: z.literal("QUEUED") }),
    {
      body: z.strictObject({ deploymentId: DeploymentId }),
      access: "allowed-wallet",
      status: 202,
    },
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
      spentUsdMicros: Uint256,
      reservedUsdMicros: Uint256,
      unknownUsdMicros: Uint256,
    }),
    { query: z.strictObject({ mode: Mode }) },
  ),
];
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
      ...(c.method === "POST"
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
      content: { "application/json": { schema: json(c.response) } },
    };
    (paths[path] ??= {})[c.method.toLowerCase()] = {
      operationId:
        c.method.toLowerCase() + c.path.replace(/[^a-zA-Z0-9]/g, "_"),
      "x-status": enabledPaths.includes(c.path) ? "enabled" : "not-implemented",
      "x-planned-access": c.access,
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
        : {}),
      responses,
    };
  }
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
