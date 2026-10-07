import { Hash } from "@blink/schemas";
import type { CreationReceiptReader, CreationTrackerStore } from "@blink/ports";

export function createCreationTracker(
  store: CreationTrackerStore,
  reader: CreationReceiptReader,
) {
  return {
    async reconcile(id: string, hash: string) {
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
      const observation = await reader.observe(creation, txHash);
      return store.save(id, creation.status.version, observation);
    },
  };
}
