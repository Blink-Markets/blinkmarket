export type EconomicIntent = {
  id: string;
  deploymentId: string;
  kind: "CREATE_MARKET" | "FILL" | "REDEEM" | "MINT" | "FINALIZE";
  payloadHash: string;
  state:
    | "PREPARED"
    | "SIGNED"
    | "SUBMITTED"
    | "UNKNOWN"
    | "INCLUDED"
    | "FINALIZED"
    | "FAILED";
};
export type NonceAllocation = {
  chainId: 84532;
  sender: string;
  nonce: string;
  intentId: string;
};
export type QuoteStatus =
  | "DRAFT"
  | "SIGN_REQUESTED"
  | "SIGNED"
  | "SIGN_UNKNOWN"
  | "EXPIRED"
  | "CANCELLED"
  | "CONSUMED";
export type Reservation = {
  id: string;
  intentId: string;
  amountMicros: string;
  state: "HELD" | "RECONCILE_REQUIRED" | "ACCOUNTED" | "RELEASED";
  accountedBlockHash: string | null;
  unit: "USD" | "bUSD" | "wei";
};
export const signerScopes = {
  "quote-api": ["maker-quote"],
  "trader-execution": ["approveExact", "fillQuote", "redeem"],
  "keeper-execution": ["finalizeUnchallenged", "finalizeTimeout"],
  "faucet-execution": ["mint"],
  "research-worker": [],
} as const;
