import type {
  Address,
  Anchor,
  DigestStatus,
  Hash,
  IndexHealth,
  MakerState,
  MarketStateName,
  ProtocolAccount,
  ProtocolMarket,
  RoleName,
} from "@blink/schemas";

// Read side of the multi-contract protocol index. Task 5 implements it over the indexed store;
// until then tests use fakeProtocolReader (tests/helpers/protocol-reader.ts).
export interface ProtocolReader {
  health(): Promise<IndexHealth>;
  account(address: Address): Promise<ProtocolAccount | null>;
  /** Mirrors BlinkRegistry.hasRole exactly. */
  hasRole(address: Address, role: RoleName): Promise<boolean>;
  /** Mirrors the BlinkRegistry.creditOf decay exactly. */
  creditAt(address: Address, role: RoleName, at: number): Promise<number>;
  market(id: string): Promise<ProtocolMarket | null>;
  marketBySpecHash(specHash: Hash): Promise<ProtocolMarket | null>;
  markets(q: {
    states?: MarketStateName[];
    after?: string;
    limit: number;
  }): Promise<{ items: ProtocolMarket[]; next: string | null }>;
  maker(address: Address): Promise<MakerState>;
  digest(digest: Hash): Promise<DigestStatus>;
  anchor(root: Hash): Promise<Anchor | null>;
  // Task 7 appends: proposal(marketId), disputes(marketId), dispute(id), rounds(disputeId),
  // votes(disputeId, round), juror(address), fees(marketId)
}
