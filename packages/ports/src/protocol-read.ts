import type {
  Address,
  Anchor,
  DigestStatus,
  FeeBreakdown,
  Hash,
  IndexHealth,
  JurorState,
  MakerState,
  MarketStateName,
  ProtocolAccount,
  ProtocolDispute,
  ProtocolMarket,
  ProtocolProposal,
  ProtocolRound,
  ProtocolVote,
  RoleName,
} from "@blink/schemas";
import type { ProtocolPosition, ProtocolTemplate } from "./chain-index.js";

/** A keyset page: `next` is the `after` value of the following page, null on the last one. */
export type Page<T> = { items: T[]; next: string | null };
export type PageQuery = { after?: string; limit: number };

// Read side of the multi-contract protocol index, implemented over the indexed store by
// postgresProtocolReader; tests that need no database use fakeProtocolReader
// (tests/helpers/protocol-reader.ts). Every page is keyset-ordered, so it is stable while the
// index grows.
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
  proposal(marketId: string): Promise<ProtocolProposal | null>;
  /** A market's disputes in dispute-id order; `after` is a dispute id. */
  disputes(marketId: string, q: PageQuery): Promise<Page<ProtocolDispute>>;
  dispute(disputeId: string): Promise<ProtocolDispute | null>;
  /** Every round of a dispute, restarts included, in round order. */
  rounds(disputeId: string): Promise<ProtocolRound[]>;
  /**
   * Votes in (round, juror) order; `after` is `round:juror`. A vote's `choice` is null until its
   * VoteRevealed event, whatever is stored.
   */
  votes(
    disputeId: string,
    q: PageQuery & { round?: number },
  ): Promise<Page<ProtocolVote>>;
  juror(address: Address): Promise<JurorState | null>;
  /** The recomputed split of the market's fee pool; null until distributeFees ran. */
  fees(marketId: string): Promise<FeeBreakdown | null>;
  /** Registered templates in template-id order; `after` is a template id. */
  templates(q: PageQuery): Promise<Page<ProtocolTemplate>>;
  /** An account's positions in market-id order; `after` is a market id. */
  positions(
    address: Address,
    q: PageQuery,
  ): Promise<Page<ProtocolPosition>>;
}
