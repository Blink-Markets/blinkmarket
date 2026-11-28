// The model's only view of the vault (spec I-25: the generation accounts in vault shares and never redeems them).
// The port exposes the share price and share transfers. It has no way to deposit into, mint from, withdraw
// from or redeem a vault, so a model action cannot be written that does.

export interface VaultPort {
  /** The price of one whole share, in the unit of account, as a WAD value. */
  sharePrice(): bigint;
  /** Moves `amount` base units of shares between two accounts. */
  transferShares(from: string, to: string, amount: bigint): void;
}

/** The members of `VaultPort`, kept as a runtime list so a test can assert both stay in step. */
export const VAULT_PORT_KEYS = ["sharePrice", "transferShares"] as const satisfies readonly (keyof VaultPort)[];
