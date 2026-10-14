import {
  applyEvent,
  ChainProjectionError,
  compareEvents,
  foldEvents,
  projectionChanges,
  type ChainProjection,
  type DecodedEvent,
} from "@blink/domain";
import type {
  ChainBlock,
  ChainGateReason,
  ChainIndexStore,
  ChainLease,
  ChainLogReader,
  IndexCursor,
  ProjectionChanges,
} from "@blink/ports";

export interface ChainIndexHealth {
  deploymentId: string;
  blockNumber: string;
  headNumber: string;
  lagBlocks: string;
  syncedAt: string | null;
  ageMs: number | null;
  gateReason: string | null;
  ready: boolean;
}

export interface ChainSyncResult {
  advancedTo: bigint | null;
  reorgedTo: bigint | null;
  gateReason: string | null;
}

// RFQ gate thresholds (spec 14.2): more than 3 blocks behind or no update for 10 s closes quoting.
const MAX_LAG_BLOCKS = 3n;
const MAX_AGE_MS = 10_000;

export function chainIndexHealth(
  deploymentId: string,
  cursor: IndexCursor | null,
  now: Date,
): ChainIndexHealth {
  if (!cursor)
    return {
      deploymentId,
      blockNumber: "0",
      headNumber: "0",
      lagBlocks: "0",
      syncedAt: null,
      ageMs: null,
      gateReason: null,
      ready: false,
    };
  const lag = cursor.headNumber - cursor.blockNumber;
  const ageMs = Math.max(0, now.getTime() - cursor.syncedAt.getTime());
  return {
    deploymentId,
    blockNumber: cursor.blockNumber.toString(),
    headNumber: cursor.headNumber.toString(),
    lagBlocks: lag.toString(),
    syncedAt: cursor.syncedAt.toISOString(),
    ageMs,
    gateReason: cursor.gateReason,
    ready: lag <= MAX_LAG_BLOCKS && ageMs <= MAX_AGE_MS && !cursor.gateReason,
  };
}

export function assertBaseSepolia(chainId: number) {
  if (chainId === 8453) throw new Error("MAINNET_REFUSED");
  if (chainId !== 84532) throw new Error("CHAIN_ID_MISMATCH");
}

const sameHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const eventKey = (e: DecodedEvent) =>
  `${e.blockHash}:${e.txHash}:${e.logIndex}`.toLowerCase();

// A contradiction between events and projection is a gate condition, not a crash.
function tryFold(events: readonly DecodedEvent[]): ChainProjection | null {
  try {
    return foldEvents(events);
  } catch (error) {
    if (error instanceof ChainProjectionError) return null;
    throw error;
  }
}
function tryAdvance(
  base: ChainProjection,
  events: readonly DecodedEvent[],
): ChainProjection | null {
  const next = structuredClone(base);
  try {
    for (const event of events) applyEvent(next, event);
    return next;
  } catch (error) {
    if (error instanceof ChainProjectionError) return null;
    throw error;
  }
}

export function createChainIndexer(deps: {
  store: ChainIndexStore;
  reader: ChainLogReader;
  deploymentId: string;
  marketAddress: string;
  deploymentBlock: bigint;
  workerId: string;
  rangeSize?: number;
  leaseMs?: number;
}) {
  const { store, reader, deploymentId, marketAddress, workerId } = deps;
  const rangeSize = BigInt(deps.rangeSize ?? 500);
  const leaseMs = deps.leaseMs ?? 30_000;
  if (rangeSize < 1n) throw new Error("INVALID_CHAIN_INDEXER_RANGE_SIZE");
  // The cursor starts at the block before the deployment block, so that block must exist.
  if (deps.deploymentBlock < 1n)
    throw new Error("INVALID_CHAIN_INDEXER_DEPLOYMENT_BLOCK");
  const baselineNumber = deps.deploymentBlock - 1n;
  let chainVerified = false;

  const result = (
    gateReason: string | null,
    progress: Partial<ChainSyncResult> = {},
  ): ChainSyncResult => ({
    advancedTo: null,
    reorgedTo: null,
    gateReason,
    ...progress,
  });
  const finalizedOf = (cursor: IndexCursor, fresh: bigint | null) =>
    cursor.finalizedNumber === null ||
    (fresh !== null && fresh > cursor.finalizedNumber)
      ? fresh
      : cursor.finalizedNumber;

  async function reorg(
    lease: ChainLease,
    cursor: IndexCursor,
    head: bigint,
    freshFinalized: bigint | null,
  ): Promise<ChainSyncResult> {
    // Close the gate before anything else; it stays closed until a sync reaches the head.
    const version = await store.setGate(
      lease,
      cursor.version,
      "REORG_IN_PROGRESS",
    );
    const finalized = finalizedOf(cursor, freshFinalized);
    const stop = async (reason: ChainGateReason) => {
      await store.setGate(lease, version, reason);
      return result(reason);
    };
    let ancestor: ChainBlock | null = null;
    for (let probe = cursor.blockNumber; ancestor === null;) {
      const stored = await store.canonicalBlockAtOrBelow(deploymentId, probe);
      if (!stored) break;
      const live = await reader.block(stored.number);
      if (live && sameHash(live.hash, stored.hash)) ancestor = stored;
      else if (stored.number === 0n) break;
      else probe = stored.number - 1n;
    }
    // History at or below finality never changes; no automatic recovery from a conflict.
    if (!ancestor || (finalized !== null && ancestor.number < finalized))
      return stop("FINALIZED_CONFLICT");
    const projection = tryFold(
      (await store.loadCanonicalEvents(deploymentId)).filter(
        (e) => e.blockNumber <= ancestor!.number,
      ),
    );
    if (!projection) return stop("PROJECTION_MISMATCH");
    await store.commitReorg(lease, {
      expectedVersion: version,
      ancestor,
      projection,
      headNumber: head,
      finalizedNumber: finalized,
    });
    return result("REORG_IN_PROGRESS", { reorgedTo: ancestor.number });
  }

  // Compares the projection with contract reads pinned to the block the range ends at.
  async function agreesWithChain(
    projection: ChainProjection,
    marketIds: readonly string[],
    blockHash: string,
  ) {
    const views = await reader.views(
      marketAddress,
      blockHash,
      marketIds.map((id) => BigInt(id)),
    );
    if (
      views.makerFreeMicros !== projection.maker.freeMicros ||
      views.epoch !== projection.maker.epoch
    )
      return false;
    return marketIds.every((id) => {
      const chain = views.markets.get(id);
      const mine = projection.markets.get(id);
      return (
        !!chain &&
        !!mine &&
        chain.totalPairs === mine.totalPairs &&
        chain.escrowMicros === mine.escrowMicros &&
        chain.state === mine.state
      );
    });
  }

  return {
    async syncOnce(signal?: AbortSignal): Promise<ChainSyncResult> {
      const checkpoint = () => {
        if (signal?.aborted)
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("CHAIN_SYNC_ABORTED");
      };
      checkpoint();
      if (!chainVerified) {
        assertBaseSepolia(await reader.chainId());
        chainVerified = true;
      }
      if (!(await store.loadCursor(deploymentId))) {
        const first = await reader.head();
        const baseline =
          first.number >= baselineNumber
            ? await reader.block(baselineNumber)
            : null;
        if (!baseline) return result(null);
        await store.initializeCursor({
          deploymentId,
          baseline,
          headNumber: first.number,
          finalizedNumber: await reader.finalized(),
        });
      }
      const lease = await store.claimLease(deploymentId, workerId, leaseMs);
      // Read after the claim: the version to fence on is the one the lease holder sees.
      const cursor = (await store.loadCursor(deploymentId))!;
      if (!lease || cursor.gateReason === "FINALIZED_CONFLICT")
        return result(cursor.gateReason);
      checkpoint();

      const head = await reader.head();
      const finalized = finalizedOf(cursor, await reader.finalized());
      // A provider behind our cursor is lagging, not reorganized: change nothing.
      if (head.number < cursor.blockNumber) return result(cursor.gateReason);
      const live = await reader.block(cursor.blockNumber);
      if (!live || !sameHash(live.hash, cursor.blockHash))
        return reorg(lease, cursor, head.number, finalized);

      const to =
        head.number < cursor.blockNumber + rangeSize
          ? head.number
          : cursor.blockNumber + rangeSize;
      const atHead = to === head.number;
      // The reorg gate lifts once a verified sync reaches the head; a mismatch lifts on any clean sync.
      const gateReason: ChainGateReason | null =
        cursor.gateReason === "REORG_IN_PROGRESS" && !atHead
          ? "REORG_IN_PROGRESS"
          : null;
      if (to === cursor.blockNumber) {
        await store.refreshCursor(lease, cursor.version, {
          headNumber: head.number,
          finalizedNumber: finalized,
          gateReason,
        });
        return result(gateReason);
      }

      const events: DecodedEvent[] = [];
      const seen = new Set<string>();
      for (const event of await reader.logs(
        marketAddress,
        cursor.blockNumber + 1n,
        to,
      )) {
        // Logs at or below the cursor were already folded; repeats of one log count once.
        if (event.blockNumber <= cursor.blockNumber) continue;
        if (event.blockNumber > to) throw new Error("CHAIN_LOG_OUT_OF_RANGE");
        if (seen.has(eventKey(event))) continue;
        seen.add(eventKey(event));
        events.push(event);
      }
      events.sort(compareEvents);
      checkpoint();

      const heights = [
        ...new Set([to, ...events.map((e) => e.blockNumber)]),
      ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const headers = new Map<bigint, ChainBlock>();
      for (const height of heights) {
        const header = await reader.block(height);
        if (!header) return result(cursor.gateReason);
        headers.set(height, header);
      }
      const end = headers.get(to)!;
      // A log whose block is no longer the header at its height came from another branch.
      if (
        events.some(
          (e) => !sameHash(headers.get(e.blockNumber)!.hash, e.blockHash),
        )
      )
        return result(cursor.gateReason);
      const [liveCursor, liveEnd] = [
        await reader.block(cursor.blockNumber),
        await reader.block(to),
      ];
      if (
        !liveCursor ||
        !liveEnd ||
        !sameHash(liveCursor.hash, cursor.blockHash) ||
        !sameHash(liveEnd.hash, end.hash)
      )
        return result(cursor.gateReason);

      const before = await store.loadProjection(deploymentId);
      let after = before;
      let changes: ProjectionChanges | null = projectionChanges(before, before);
      if (events.length) {
        const next = tryAdvance(before, events);
        const nextChanges = next && projectionChanges(before, next);
        if (
          next &&
          nextChanges &&
          (await agreesWithChain(next, nextChanges.markets, end.hash))
        ) {
          after = next;
          changes = nextChanges;
        } else {
          // The stored projection may have drifted: refold every canonical event and compare again.
          const refolded = tryFold([
            ...(await store.loadCanonicalEvents(deploymentId)),
            ...events,
          ]);
          const wide = refolded && projectionChanges(before, refolded);
          if (
            !refolded ||
            !wide ||
            !(await agreesWithChain(refolded, wide.markets, end.hash))
          ) {
            if (cursor.gateReason !== "PROJECTION_MISMATCH")
              await store.setGate(lease, cursor.version, "PROJECTION_MISMATCH");
            return result("PROJECTION_MISMATCH");
          }
          after = refolded;
          changes = null;
        }
      }

      await store.commitRange(lease, {
        expectedVersion: cursor.version,
        block: end,
        blocks: heights.map((height) => headers.get(height)!),
        events,
        projection: after,
        changes,
        headNumber: head.number,
        finalizedNumber: finalized,
        gateReason,
        newMarketIds: events
          .filter((e) => e.name === "MarketCreated")
          .map((e) => BigInt(e.args.marketId as string).toString()),
      });
      return result(gateReason, { advancedTo: to });
    },

    async health(): Promise<ChainIndexHealth> {
      return chainIndexHealth(
        deploymentId,
        await store.loadCursor(deploymentId),
        await store.now(),
      );
    },
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(message) ? message : "CHAIN_SYNC_FAILED";
}

export function startChainIndexer(options: {
  indexer: ReturnType<typeof createChainIndexer>;
  pollIntervalMs: number;
  signal?: AbortSignal;
  onError?: (code: string) => void;
}) {
  if (
    !Number.isSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs < 1
  )
    throw new Error("INVALID_CHAIN_INDEXER_POLL_INTERVAL_MS");
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  else
    options.signal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  let wake: (() => void) | null = null;
  const pause = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const loop = (async () => {
    while (!controller.signal.aborted) {
      let progressed = false;
      try {
        const synced = await options.indexer.syncOnce(controller.signal);
        // Keep reading without waiting while a range or a rollback just made progress.
        progressed = synced.advancedTo !== null || synced.reorgedTo !== null;
      } catch (error) {
        if (!controller.signal.aborted) options.onError?.(errorCode(error));
      }
      if (!progressed && !controller.signal.aborted) await pause();
    }
  })();
  return {
    async stop() {
      controller.abort();
      wake?.();
      await loop;
    },
    health: () => options.indexer.health(),
  };
}

export interface ChainRebuildReport {
  deploymentId: string;
  eventCount: number;
  /** Entries whose stored projection differs from the fold of the canonical events. */
  differences: string[];
  rewritten: boolean;
}

// Recomputes the projections from the canonical events. With `verify` it only compares; otherwise it
// takes the cursor lease (so no running indexer can commit meanwhile) and rewrites any difference.
export async function rebuildChainProjection(
  store: ChainIndexStore,
  deploymentId: string,
  options: { verify: boolean; workerId: string; leaseMs?: number },
): Promise<ChainRebuildReport> {
  if (!(await store.loadCursor(deploymentId)))
    throw new Error("CHAIN_CURSOR_NOT_FOUND");
  const lease = options.verify
    ? null
    : await store.claimLease(
        deploymentId,
        options.workerId,
        options.leaseMs ?? 60_000,
      );
  if (!options.verify && !lease) throw new Error("CHAIN_INDEX_LEASE_HELD");
  try {
    const snapshot = await store.loadSnapshot(deploymentId);
    const rebuilt = tryFold(snapshot.events);
    if (!rebuilt) throw new Error("INCONSISTENT_EVENT");
    const changes = projectionChanges(snapshot.projection, rebuilt);
    const differences = [
      ...(changes.maker ? ["maker"] : []),
      ...changes.markets.map((key) => `market:${key}`),
      ...changes.positions.map((key) => `position:${key}`),
      ...changes.digests.map((key) => `digest:${key}`),
      ...changes.takers.map((key) => `taker:${key}`),
      ...changes.removed,
    ];
    if (lease && differences.length)
      await store.replaceProjection(lease, snapshot.cursor.version, rebuilt);
    return {
      deploymentId,
      eventCount: snapshot.events.length,
      differences,
      rewritten: !!lease && differences.length > 0,
    };
  } finally {
    if (lease) await store.releaseLease(lease);
  }
}
