import { z } from "zod";
import { Address, Hash, Uint256 } from "./core.ts";

// Read-model types for the P1 protocol. Times are unix seconds as number; uint256 values are
// decimal strings; addresses are lowercase 0x hex. Task 7 appends proposals, disputes, rounds,
// votes, juror state and the fee breakdown.
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
