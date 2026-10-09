import { Hash } from "@blink/schemas";
import type {
  CreationReceiptReader,
  CreationTrackerStore,
  CreationTrackingLease,
} from "@blink/ports";

export function createCreationTracker(
  store: CreationTrackerStore,
  reader: CreationReceiptReader,
) {
  const assertNotAborted = (signal?: AbortSignal) => {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(signal.reason.message))
      throw signal.reason;
    throw new Error("CREATION_RECONCILIATION_ABORTED");
  };
  return {
    async reconcile(
      id: string,
      hash: string,
      lease?: CreationTrackingLease,
      signal?: AbortSignal,
    ) {
      assertNotAborted(signal);
      if (
        lease &&
        (lease.intentId !== id || lease.txHash.toLowerCase() !== hash.toLowerCase())
      )
        throw new Error("CREATION_POLL_LEASE_MISMATCH");
      const txHash = Hash.parse(hash).toLowerCase();
      const creation = await store.load(id);
      if (!creation) throw new Error("CREATION_INTENT_NOT_FOUND");
      // This slice follows a single validated transaction, including its re-inclusion.
      // Replacement transactions need a separate, explicit reconciliation workflow.
      if (
        creation.status.txHash &&
        creation.status.txHash.toLowerCase() !== txHash
      )
        throw new Error("TRACKED_TRANSACTION_CONFLICT");
      const observation = await reader.observe(creation, txHash, signal);
      assertNotAborted(signal);
      return store.save(id, creation.status.version, observation, lease, signal);
    },
  };
}
