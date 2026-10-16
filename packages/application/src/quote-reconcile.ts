import { JobError } from "@blink/domain";
import { indexerStatus } from "./rfq.js";
import type {
  JobHandler,
  OpenReservation,
  ReservationSettlement,
  TradingCursor,
  TradingStore,
} from "@blink/ports";

type Cursor = Pick<
  TradingCursor,
  "blockNumber" | "blockHash" | "blockTimestamp"
>;

/**
 * What the canonical state at the cursor says about one held reservation, or null for "not yet".
 * Only block time and indexed events decide: a local clock past the expiry changes nothing.
 */
export function decideReservation(input: {
  reservation: OpenReservation;
  cursor: Cursor;
  makerEpoch: bigint | null;
}): Omit<ReservationSettlement, "reservationId" | "quoteId"> | null {
  const { reservation: r, cursor: c } = input;
  const at = { blockNumber: c.blockNumber, blockHash: c.blockHash };
  // A fill the cursor has passed is final for this reservation, whatever else is true.
  if (r.digest?.state === "FILLED" && r.digest.blockNumber <= c.blockNumber)
    return {
      to: "ACCOUNTED",
      quoteStatus: "CONSUMED",
      blockNumber: r.digest.blockNumber,
      blockHash: r.digest.blockHash,
      reason: "FILL_INDEXED",
    };
  if (r.digest?.state === "CANCELLED")
    return {
      to: "RELEASED",
      quoteStatus: "CANCELLED",
      ...at,
      reason: "QUOTE_CANCELLED",
    };
  if (input.makerEpoch !== null && input.makerEpoch > r.quoteEpoch)
    return {
      to: "RELEASED",
      quoteStatus: "CANCELLED",
      ...at,
      reason: "EPOCH_INCREMENTED",
    };
  if (c.blockTimestamp >= r.expiresAt)
    return {
      to: "RELEASED",
      quoteStatus: "EXPIRED",
      ...at,
      reason: "EXPIRED_BY_BLOCK_TIME",
    };
  return null;
}

/**
 * Reconciles one deployment's reservations with the indexer's canonical state (spec 8.4, design 04):
 * reopen what a reorg took back, conclude what the cursor now shows, and gate the pool when the
 * maker's free balance no longer covers what is reserved. Everything runs under the pool lock.
 */
export function createQuoteReconciler(store: TradingStore) {
  return {
    reconcileOnce(deploymentId: string): Promise<{
      accounted: number;
      released: number;
      reopened: number;
      /** Set only when nothing was judged: the cursor was not fresh (the RFQ's INDEXER_LAG rule). */
      skipped?: "INDEXER_LAG";
    }> {
      return store.run(async (tx) => {
        const result: {
          accounted: number;
          released: number;
          reopened: number;
          skipped?: "INDEXER_LAG";
        } = { accounted: 0, released: 0, reopened: 0 };
        await tx.lockPool(deploymentId);
        const cursor = await tx.cursor(deploymentId);
        // A gated, stale or lagging projection is not evidence: keep every reservation and the
        // pool gate as they are. Clearing OVERCOMMITTED on a view that trails the chain could
        // reopen quoting against a balance the chain has already changed (after a restore, too).
        if (!cursor) return result;
        if (indexerStatus(cursor, cursor.headNumber) !== "FRESH")
          return { ...result, skipped: "INDEXER_LAG" };
        result.reopened = await tx.reopenOrphaned(deploymentId);
        const maker = await tx.makerState(deploymentId);
        for (const reservation of await tx.openReservations(deploymentId)) {
          const decision = decideReservation({
            reservation,
            cursor,
            makerEpoch: maker?.epoch ?? null,
          });
          if (!decision) continue;
          const moved = await tx.settle({
            reservationId: reservation.reservationId,
            quoteId: reservation.quoteId,
            ...decision,
          });
          if (!moved) continue;
          if (decision.to === "ACCOUNTED") result.accounted += 1;
          else result.released += 1;
        }
        if (maker)
          await tx.setPoolGate(
            deploymentId,
            (await tx.heldMicros(deploymentId)) > maker.freeMicros
              ? "OVERCOMMITTED"
              : null,
          );
        if (result.accounted + result.released + result.reopened > 0)
          await tx.bumpPool(deploymentId);
        return result;
      });
    },
  };
}

/** The `quote.reconcile` job: payload `{deploymentId}`. */
export function createQuoteReconcileHandler(
  reconciler: Pick<ReturnType<typeof createQuoteReconciler>, "reconcileOnce">,
): JobHandler {
  return async ({ job, signal }) => {
    const deploymentId = job.payload.deploymentId;
    if (typeof deploymentId !== "string" || deploymentId === "")
      throw new JobError("INVALID_QUOTE_RECONCILE_PAYLOAD", false);
    if (signal.aborted) throw new JobError("OPERATION_ABORTED", true);
    try {
      await reconciler.reconcileOnce(deploymentId);
    } catch {
      throw new JobError("QUOTE_RECONCILE_FAILED", true);
    }
  };
}
