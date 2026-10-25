import type { TrackedTransaction } from "./tx-tracking.js";
import type { ChainCursor } from "@blink/schemas";

// What remains of the v0.1 market-read store is the tracked-transaction read; hints are written by
// the tx-tracking service. Market reads go through ProtocolReader.
export interface MarketReadStore {
  transaction(
    deploymentId: string,
    hash: string,
  ): Promise<(TrackedTransaction & { chainCursor: ChainCursor | null }) | null>;
}
