import { z } from "zod";
import { Hash, PositiveUint256, Uint256 } from "./core.ts";

export const CreationChainStatus = z.strictObject({
  creationIntentId: z.uuid(),
  state: z.enum([
    "NOT_TRACKED",
    "UNKNOWN",
    "INCLUDED",
    "CONFIRMED",
    "REVERTED",
    "REORGED",
  ]),
  txHash: Hash.nullable(),
  marketId: PositiveUint256.nullable(),
  blockNumber: Uint256.nullable(),
  blockHash: Hash.nullable(),
  headNumber: Uint256.nullable(),
  headHash: Hash.nullable(),
  confirmations: Uint256,
  requiredConfirmations: z.literal(12),
  version: z.number().int().nonnegative(),
  observedAt: z.iso.datetime().nullable(),
});
export type CreationChainStatus = z.infer<typeof CreationChainStatus>;
