import type {
  ProtocolProjection,
  ProtocolEvent,
  ProjectionChanges,
} from "@blink/domain";

// Adapters reach domain types only through ports.
export type {
  ProtocolProjection,
  ProtocolEvent,
  ProtocolPosition,
  ProtocolTemplate,
  ProtocolFill,
  ProjectionChanges,
} from "@blink/domain";

export type ChainGateReason =
  "REORG_IN_PROGRESS" | "PROJECTION_MISMATCH" | "FINALIZED_CONFLICT";

export interface IndexCursor {
  deploymentId: string;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  headNumber: bigint;
  headTimestamp?: bigint;
  finalizedNumber: bigint | null;
  syncedAt: Date;
  gateReason: ChainGateReason | null;
  version: bigint;
}

export interface ChainBlock {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: bigint;
}

export interface ChainLogReader {
  chainId(): Promise<number>;
  head(): Promise<{ number: bigint; hash: string; timestamp: bigint }>;
  /** null when the provider does not support the tag (finality unknown). */
  finalized(): Promise<bigint | null>;
  block(number: bigint): Promise<ChainBlock | null>;
  /** Every generation log is decoded strictly; rejects removed and unknown logs. */
  logs(address: string, from: bigint, to: bigint): Promise<ProtocolEvent[]>;
  /** Contract reads pinned to one block hash. Omit events only for a full rebuild audit. */
  agrees(
    blockHash: string,
    projection: ProtocolProjection,
    events?: readonly ProtocolEvent[],
  ): Promise<boolean>;
}

/** Proof of one claim on a deployment's cursor; every write must present it. */
export interface ChainLease {
  deploymentId: string;
  workerId: string;
  token: bigint;
}

/** What one range commit writes. `changes: null` replaces the stored projections wholesale. */
export interface ChainRangeCommit {
  expectedVersion: bigint;
  block: ChainBlock;
  /** Headers of every block that holds events, plus `block` itself. */
  blocks: readonly ChainBlock[];
  events: readonly ProtocolEvent[];
  projection: ProtocolProjection;
  changes: ProjectionChanges | null;
  headNumber: bigint;
  headTimestamp?: bigint;
  headObservedAt: Date;
  finalizedNumber: bigint | null;
  gateReason: ChainGateReason | null;
  newMarketIds: readonly string[];
}

export interface ChainReorgCommit {
  expectedVersion: bigint;
  ancestor: ChainBlock;
  /** Projection folded from the events that survive at or below the ancestor. */
  projection: ProtocolProjection;
  headNumber: bigint;
  headTimestamp?: bigint;
  finalizedNumber: bigint | null;
}

export interface ChainSnapshot {
  cursor: IndexCursor;
  events: ProtocolEvent[];
  projection: ProtocolProjection;
}

/**
 * Every mutating call is fenced by the lease token and the cursor version, and throws
 * CHAIN_LEASE_LOST or CHAIN_VERSION_CONFLICT when either is stale.
 */
export interface ChainIndexStore {
  creditHalfLife(deploymentId: string): Promise<number>;
  loadCursor(deploymentId: string): Promise<IndexCursor | null>;
  /** Database business clock (blink.now()). */
  now(): Promise<Date>;
  /** Idempotent: creates the cursor and its baseline block once. */
  initializeCursor(input: {
    deploymentId: string;
    baseline: ChainBlock;
    headNumber: bigint;
    headTimestamp?: bigint;
    finalizedNumber: bigint | null;
  }): Promise<void>;
  /** null while another worker holds an unexpired lease. */
  claimLease(
    deploymentId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<ChainLease | null>;
  releaseLease(lease: ChainLease): Promise<void>;
  loadProjection(deploymentId: string): Promise<ProtocolProjection>;
  /** Canonical events in (blockNumber, txIndex, logIndex) order. */
  loadCanonicalEvents(deploymentId: string): Promise<ProtocolEvent[]>;
  /** Cursor, canonical events and projections from one consistent snapshot. */
  loadSnapshot(deploymentId: string): Promise<ChainSnapshot>;
  /** Highest stored canonical block at or below `number`. */
  canonicalBlockAtOrBelow(
    deploymentId: string,
    number: bigint,
  ): Promise<ChainBlock | null>;
  commitRange(lease: ChainLease, commit: ChainRangeCommit): Promise<bigint>;
  /** Moves head, finality and the gate without moving the block cursor; records the head observation time in synced_at. */
  refreshCursor(
    lease: ChainLease,
    expectedVersion: bigint,
    refresh: {
      headNumber: bigint;
      headTimestamp?: bigint;
      headObservedAt: Date;
      finalizedNumber: bigint | null;
      gateReason: ChainGateReason | null;
    },
  ): Promise<bigint>;
  /** Sets or clears the gate alone (synced_at is not a sync); returns the new version. */
  setGate(
    lease: ChainLease,
    expectedVersion: bigint,
    reason: ChainGateReason | null,
  ): Promise<bigint>;
  /** Tombstones blocks and events above the ancestor and rewinds the cursor to it. */
  commitReorg(lease: ChainLease, commit: ChainReorgCommit): Promise<bigint>;
  /** Rewrites the projections at the cursor's block (rebuild tooling). */
  replaceProjection(
    lease: ChainLease,
    expectedVersion: bigint,
    projection: ProtocolProjection,
  ): Promise<bigint>;
}

export { hasRole, creditAt } from "@blink/domain";
