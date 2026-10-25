import { z } from "zod";
import { Address, Hash, Uint256 } from "./core.ts";

// Read-model types for the P1 protocol. Times are unix seconds as number; uint256 values are
// decimal strings; addresses are lowercase 0x hex.
const Uint = Uint256;

export const RoleName = z.enum([
  "CREATOR",
  "MAKER",
  "TAKER",
  "FORECASTER",
  "PROPOSER",
  "CHALLENGER",
  "JUROR",
]); // index = P1 Role enum value
export type RoleName = z.infer<typeof RoleName>;
export const MarketStateName = z.enum([
  "PENDING",
  "OPEN",
  "PROPOSED",
  "DISPUTED",
  "FINAL",
  "CANCELLED",
]);
export type MarketStateName = z.infer<typeof MarketStateName>;
export const OutcomeName = z.enum(["YES", "NO", "INVALID"]);
export type OutcomeName = z.infer<typeof OutcomeName>;
export const ClassName = z.enum(["A", "B", "C"]);
export type ClassName = z.infer<typeof ClassName>;

export const IndexHealth = z.object({
  headBlock: z.number(),
  indexedBlock: z.number(),
  lagSeconds: z.number(),
  stale: z.boolean(),
});
export type IndexHealth = z.infer<typeof IndexHealth>;

export const ProtocolAccount = z.object({
  address: Address,
  registered: z.boolean(),
  roles: z.record(
    RoleName,
    z.object({
      stakeMicros: Uint,
      active: z.boolean(),
      exitRequestedAt: z.number().nullable(),
      openObligations: z.number(),
    }),
  ),
  // Stored value; decay is applied by ProtocolReader.creditAt().
  credit: z.record(
    RoleName,
    z.object({ value: z.number(), updatedAt: z.number() }),
  ),
});
export type ProtocolAccount = z.infer<typeof ProtocolAccount>;

export const ProtocolMarket = z.object({
  marketId: Uint,
  creator: Address,
  class: ClassName,
  state: MarketStateName,
  templateId: Hash,
  specHash: Hash,
  specUri: z.string(),
  replay: z.boolean(),
  openAt: z.number(),
  closeAt: z.number(),
  proposalDeadline: z.number(),
  hardDeadline: z.number(),
  maxPairs: Uint,
  mintedPairs: Uint,
  escrowMicros: Uint,
  feePoolMicros: Uint,
  finalOutcome: OutcomeName.nullable(),
  feesDistributed: z.boolean(),
  creationChallenged: z.boolean(),
});
export type ProtocolMarket = z.infer<typeof ProtocolMarket>;

export const MakerState = z.object({
  address: Address,
  freeMicros: Uint,
  epoch: Uint,
});
export type MakerState = z.infer<typeof MakerState>;

export const DigestStatus = z.enum(["UNUSED", "CONSUMED", "CANCELLED"]);
export type DigestStatus = z.infer<typeof DigestStatus>;

export const Anchor = z.object({
  root: Hash,
  by: Address,
  anchoredAt: z.number(),
});
export type Anchor = z.infer<typeof Anchor>;

// ---- Resolution, jurors and fees (read models of BlinkResolution, BlinkJurors, BlinkMarkets) ----

/** A dispute choice as the contract stores it: 0 is YES and 1 is NO; in a creation dispute 1 upholds the challenge. */
export const Choice = z.union([z.literal(0), z.literal(1)]);
export type Choice = z.infer<typeof Choice>;
export const DisputeKindName = z.enum(["CREATION", "RESULT"]);
export type DisputeKindName = z.infer<typeof DisputeKindName>;

export const ProtocolProposal = z.object({
  marketId: Uint,
  proposer: Address,
  outcome: OutcomeName,
  bondMicros: Uint,
  challengeEnd: z.number(),
  evidenceHash: Hash,
  evidenceUri: z.string(),
  proposedAt: z.number(),
});
export type ProtocolProposal = z.infer<typeof ProtocolProposal>;

export const ProtocolDispute = z.object({
  disputeId: Uint,
  marketId: Uint,
  kind: DisputeKindName,
  ground: z.number(),
  challenger: Address,
  evidenceHash: Hash,
  /** Unique attempt number: restarts count, so it can exceed the appeal level. */
  currentRound: z.number(),
  appealRound: z.number(),
  settled: z.boolean(),
  timedOut: z.boolean(),
  /** The final round's leading choice; null while open and after a timeout. */
  finalChoice: Choice.nullable(),
});
export type ProtocolDispute = z.infer<typeof ProtocolDispute>;

export const ProtocolRound = z.object({
  disputeId: Uint,
  round: z.number(),
  level: z.number(),
  snapshotAt: z.number(),
  commitEnd: z.number(),
  revealEnd: z.number(),
  appealEnd: z.number(),
  committedWeight: Uint,
  /** Revealed weight per choice: [YES, NO]. */
  revealedWeight: z.tuple([Uint, Uint]),
  committers: z.number(),
  revealers: z.number(),
  /** Meaningful once `settled` and not `restarted`; 0 before that, as in the contract. */
  leadingChoice: Choice,
  restarted: z.boolean(),
  settled: z.boolean(),
  creditThreshold: z.number(),
});
export type ProtocolRound = z.infer<typeof ProtocolRound>;

export const ProtocolVote = z.object({
  disputeId: Uint,
  round: z.number(),
  juror: Address,
  weight: Uint,
  revealed: z.boolean(),
  /** null until the VoteRevealed event. */
  choice: Choice.nullable(),
  settled: z.boolean(),
  /** Juror tokens slashed by VoteSettled events. */
  slashed: Uint,
  /** Juror tokens rewarded by VoteSettled events. */
  reward: Uint,
});
export type ProtocolVote = z.infer<typeof ProtocolVote>;

export const JurorState = z.object({
  address: Address,
  /** Juror tokens staked and counted for weight. */
  staked: Uint,
  /** Juror tokens in the unstake cooldown (still slashable). */
  pendingUnstake: Uint,
  /** Unix seconds when the pending unstake can be withdrawn; 0 when nothing is pending. */
  unstakeReadyAt: z.number(),
  openVotes: z.number(),
  /** bUSD reward-stream earnings settled to the juror and not yet claimed. */
  rewardsOwed: Uint,
});
export type JurorState = z.infer<typeof JurorState>;

export const FeeBreakdown = z.object({
  marketId: Uint,
  poolMicros: Uint,
  /** Includes all share-rounding dust (R32). */
  treasury: Uint,
  /** Paid to the market creator; 0 when the market ended INVALID. */
  creator: Uint,
  /** Paid to the proposer, after the keeper tip; 0 when the proposal did not win. */
  resolution: Uint,
  keeperTip: Uint,
  keeper: Address,
  /** Juror share plus every share redirected to jurors. */
  jurors: Uint,
  bounty: Uint,
  /** The bounty recipient; null when no bounty was paid. */
  bountyWinner: Address.nullable(),
});
export type FeeBreakdown = z.infer<typeof FeeBreakdown>;
