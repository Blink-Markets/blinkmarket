import type { TransactionHint, TrackedTransaction } from "./tx-tracking.js";
import type { ChainCursor } from "@blink/schemas";
import type { IdentityPrincipal, IdentityResponse } from "./identity.js";

// What remains of the v0.1 market-read store is the transaction-hint path; Task 9 replaces it with
// protocol transaction tracking. Market reads now go through ProtocolReader.
export interface MarketReadStore {
  hint(
    principal: IdentityPrincipal & { wallet: string | null },
    body: TransactionHint,
    key: string,
  ): Promise<IdentityResponse>;
  transaction(
    deploymentId: string,
    hash: string,
  ): Promise<(TrackedTransaction & { chainCursor: ChainCursor | null }) | null>;
}
