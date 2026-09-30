import { z } from "zod";

export const CHAIN_ID = 84532 as const;
export const DecimalInteger = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/);
export const Uint256 = DecimalInteger.pipe(
  z.string().refine((v) => BigInt(v) < 2n ** 256n, "uint256 overflow"),
);
export const Uint64 = DecimalInteger.pipe(
  z.string().refine((v) => BigInt(v) < 2n ** 64n, "uint64 overflow"),
);
export const PositiveUint256 = Uint256.refine((v) => v !== "0");
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const Mode = z.enum(["LIVE", "REPLAY"]);
export const Outcome = z.enum(["YES", "NO", "INVALID"]);
export const MarketState = z.enum(["OPEN", "PROPOSED", "DISPUTED", "FINAL"]);
export const TransactionState = z.enum([
  "CREATED",
  "SIGNED",
  "SUBMITTED",
  "PRECONFIRMED",
  "INCLUDED",
  "FINALIZED",
  "REVERTED",
  "REPLACED",
  "UNKNOWN",
  "REORGED",
]);

export const MarketSpecV01 = z
  .strictObject({
    schemaVersion: z.literal("blink.market.v0.1"),
    mode: Mode,
    templateId: z.literal("GM_LT_V1"),
    entityId: z.string().min(1),
    fiscalPeriod: z.string().min(1),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    metric: z.literal("quarterly_gaap_reported_gross_margin"),
    thresholdBps: z.number().int().min(0).max(10000),
    comparator: z.literal("LT"),
    sourceAllowlist: z.array(z.url()).min(1),
    valueVersion: z.literal("FIRST_QUALIFYING_RELEASE"),
    missingValueOutcome: z.literal("INVALID"),
    invalidYesPayoutMicros: z.literal(500000),
    invalidNoPayoutMicros: z.literal(500000),
    closeAt: Uint64,
    proposalDeadline: Uint64,
    hardDeadline: Uint64,
    challengeSeconds: z.union([z.literal(86400), z.literal(120)]),
    fundingType: z.literal("PLATFORM_RESEARCH_SUBSIDY"),
    sourceEvidenceIds: z.array(z.string().min(1)).min(1),
  })
  .superRefine((s, ctx) => {
    if (
      ![s.closeAt, s.proposalDeadline, s.hardDeadline].every((v) =>
        /^(0|[1-9][0-9]*)$/.test(v),
      )
    )
      return;
    if (!(
      BigInt(s.closeAt) < BigInt(s.proposalDeadline) &&
      BigInt(s.proposalDeadline) < BigInt(s.hardDeadline) &&
      BigInt(s.hardDeadline) - BigInt(s.proposalDeadline) >
        BigInt(s.challengeSeconds)
    )) {
      ctx.addIssue({ code: "custom", message: "Invalid resolution deadlines" });
    }
    if (s.challengeSeconds !== (s.mode === "LIVE" ? 86400 : 120)) {
      ctx.addIssue({
        code: "custom",
        message: "Challenge duration must match mode",
      });
    }
    if (s.periodStart > s.periodEnd)
      ctx.addIssue({ code: "custom", message: "Invalid fiscal period" });
  });
export const ResolutionPolicy = z.strictObject({
  hardDeadlineOutcome: z.literal("INVALID"),
  unfinalizedProposalAtHardDeadline: z.literal("INVALID"),
  invalidPayoutRule: z.literal("HALF_PER_SIDE_NOT_PURCHASE_REFUND"),
  authorityModel: z.literal("TEAM_OPERATED_WHITELISTED_ROLES"),
});
export const MarketSpecV011 = z
  .strictObject({
    ...MarketSpecV01.shape,
    schemaVersion: z.literal("blink.market.v0.1.1"),
    resolutionPolicy: ResolutionPolicy,
  })
  .superRefine((s, ctx) => {
    const { resolutionPolicy: _policy, ...legacy } = s;
    const result = MarketSpecV01.safeParse({
      ...legacy,
      schemaVersion: "blink.market.v0.1",
    });
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
  });
export const MarketSpec = z.union([MarketSpecV01, MarketSpecV011]);
export type MarketSpec = z.infer<typeof MarketSpec>;
export type NewMarketSpec = z.infer<typeof MarketSpecV011>;

// 此 schema 是 wire shape；now、核准來源、公告污染與 cap 由 application policy 驗證。
export const Quote = z
  .strictObject({
    marketId: Uint256,
    specHash: Hash,
    maker: Address,
    taker: Address,
    side: z.enum(["0", "1"]),
    quantity: Uint64,
    priceBps: DecimalInteger.pipe(
      z.string().refine((v) => BigInt(v) >= 1n && BigInt(v) <= 9999n),
    ),
    validAfter: Uint64,
    expiresAt: Uint64,
    nonce: Uint256,
    epoch: Uint256,
  })
  .superRefine((q, ctx) => {
    if (
      ![q.quantity, q.validAfter, q.expiresAt].every((v) =>
        /^(0|[1-9][0-9]*)$/.test(v),
      )
    )
      return;
    if (
      BigInt(q.quantity) === 0n ||
      BigInt(q.expiresAt) <= BigInt(q.validAfter) ||
      BigInt(q.expiresAt) - BigInt(q.validAfter) > 60n
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid quantity or quote lifetime",
      });
    }
  });
export type Quote = z.infer<typeof Quote>;
export const quoteTypes = {
  Quote: [
    { name: "marketId", type: "uint256" },
    { name: "specHash", type: "bytes32" },
    { name: "maker", type: "address" },
    { name: "taker", type: "address" },
    { name: "side", type: "uint8" },
    { name: "quantity", type: "uint64" },
    { name: "priceBps", type: "uint16" },
    { name: "validAfter", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "epoch", type: "uint256" },
  ],
} as const;
export const ErrorCode = z.enum([
  "UNAUTHORIZED",
  "SCOPE_DENIED",
  "WALLET_NOT_VERIFIED",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_IN_PROGRESS",
  "INVALID_REQUEST",
  "INVALID_SPEC",
  "DEPLOYMENT_MISMATCH",
  "DUPLICATE_CANDIDATE",
  "FORECAST_WINDOW_CLOSED",
  "FORECAST_ALREADY_SUBMITTED",
  "BUDGET_EXHAUSTED",
  "MARKET_CLOSED",
  "TRADING_PAUSED",
  "NO_QUOTE",
  "STALE_FORECAST",
  "INDEXER_LAG",
  "INSUFFICIENT_MAKER_BALANCE",
  "PRICE_LIMIT_EXCEEDED",
  "QUOTE_EXPIRED",
  "QUOTE_CANCELLED",
  "QUOTE_CONSUMED",
  "TX_PENDING",
  "CHAIN_UNAVAILABLE",
  "SERVICE_NOT_READY",
  "NOT_FOUND",
  "NOT_IMPLEMENTED",
  "INTERNAL_ERROR",
]);
export const ApiError = z.strictObject({
  code: ErrorCode,
  message: z.string(),
  requestId: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
});
export type ApiError = z.infer<typeof ApiError>;
export const DeploymentId = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const PublicMarketRef = z.strictObject({
  deploymentId: DeploymentId,
  marketId: PositiveUint256,
  mode: Mode,
});
export type PublicMarketRef = z.infer<typeof PublicMarketRef>;
export type MarketRef = z.infer<typeof PublicMarketRef>;
export const MarketRecordId = z.uuid().brand<"MarketRecordId">();
export type MarketRecordId = z.infer<typeof MarketRecordId>;
export const ChainCursor = z.strictObject({
  blockNumber: Uint256,
  blockHash: Hash,
  finality: z.enum(["INCLUDED", "FINALIZED", "UNKNOWN"]),
});
export type ChainCursor = z.infer<typeof ChainCursor>;
