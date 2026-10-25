import { z } from "zod";
import { Address, Hash, PositiveUint256, Uint256 } from "./core.ts";
import { ProtocolDeployment } from "./deployment.ts";
import { MarketSpecV02 } from "./market-spec.ts";
import {
  ClassName,
  FeeBreakdown,
  IndexHealth,
  JurorState,
  MarketStateName,
  OutcomeName,
  ProtocolDispute,
  ProtocolMarket,
  ProtocolProposal,
  ProtocolRound,
  ProtocolVote,
  RoleName,
} from "./protocol.ts";

// Public, key-less read API over the protocol index (Task 7). Every body carries the index health the
// answer was read at; a client decides for itself whether a stale index is good enough.
const Index = { index: IndexHealth };
const Next = z.string().nullable();

/** Keyset paging: `after` is the `next` of the previous page. */
export const ReadPageQuery = z.strictObject({
  after: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const PAGE_MAX = 100;

/** What parseMarketSpec made of the stored bytes, or why there is none: never absent. */
export const SpecResult = z.union([
  z.strictObject({ ok: z.literal(true), spec: MarketSpecV02 }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type SpecResult = z.infer<typeof SpecResult>;
export const MarketListItem = z.strictObject({
  market: ProtocolMarket,
  spec: SpecResult,
});
export const MarketDetail = z.strictObject({
  market: ProtocolMarket,
  spec: SpecResult,
  proposal: ProtocolProposal.nullable(),
  ...Index,
});
export const MarketsPage = z.strictObject({
  items: z.array(MarketListItem),
  next: Next,
  ...Index,
});
export const DeploymentResponse = z.strictObject({
  deployment: ProtocolDeployment,
  ...Index,
});
export const DisputesPage = z.strictObject({
  items: z.array(ProtocolDispute),
  next: Next,
  ...Index,
});
export const DisputeDetail = z.strictObject({
  dispute: ProtocolDispute,
  rounds: z.array(ProtocolRound),
  votes: z.array(ProtocolVote),
  next: Next,
  ...Index,
});
export const FeesResponse = z.strictObject({
  marketId: PositiveUint256,
  fees: FeeBreakdown.nullable(),
  ...Index,
});
export const AccountRole = z.strictObject({
  hasRole: z.boolean(),
  stakeMicros: Uint256,
  active: z.boolean(),
  exitRequestedAt: z.number().nullable(),
  openObligations: z.number(),
  /** Stored credit decayed to `creditAt`, as BlinkRegistry.creditOf would report it. */
  credit: z.number(),
});
export const AccountResponse = z.strictObject({
  address: Address,
  registered: z.boolean(),
  /** Unix seconds the credit was decayed to: the request time, or the newest stored credit if later. */
  creditAt: z.number(),
  roles: z.record(RoleName, AccountRole),
  juror: JurorState.nullable(),
  ...Index,
});
export const PositionView = z.strictObject({
  marketId: PositiveUint256,
  account: Address,
  yesShares: Uint256,
  noShares: Uint256,
  takerBoughtShares: Uint256,
  redeemedPayoutMicros: Uint256,
  marketState: MarketStateName,
  finalOutcome: OutcomeName.nullable(),
  /** What redeeming now pays: set once the market is FINAL, null before. */
  payoutMicros: Uint256.nullable(),
});
export const PositionsPage = z.strictObject({
  items: z.array(PositionView),
  next: Next,
  ...Index,
});
export const TemplateView = z.strictObject({
  templateId: Hash,
  class: ClassName,
  parserHash: Hash,
  uri: z.string(),
});
export const TemplatesPage = z.strictObject({
  items: z.array(TemplateView),
  next: Next,
  ...Index,
});
