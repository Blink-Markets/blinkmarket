import type { DeploymentManifest } from "@blink/schemas";
import type {
  TrackedTransaction,
  TxTrackingStore,
  TxReceiptReader,
} from "@blink/ports";
const same = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
export function createTxTracker(deps: {
  store: TxTrackingStore;
  reader: TxReceiptReader;
  manifest(deploymentId: string): Promise<DeploymentManifest | null>;
}) {
  return {
    async trackOnce(limit = 50): Promise<number> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("INVALID_TRACKING_LIMIT");
      let updated = 0;
      let failure: unknown;
      for (const row of await deps.store.pending(limit)) {
        const next: Pick<
          TrackedTransaction,
          | "status"
          | "rejectReason"
          | "receiptBlockHash"
          | "receiptBlockNumber"
          | "marketId"
        > = {
          status: row.status,
          rejectReason: row.rejectReason,
          receiptBlockHash: row.receiptBlockHash,
          receiptBlockNumber: row.receiptBlockNumber,
          marketId: row.marketId,
        };
        try {
          const manifest = await deps.manifest(row.deploymentId);
          if (!manifest) throw new Error("DEPLOYMENT_NOT_VERIFIED");
          if (Number(manifest.chainId) === 8453)
            throw new Error("MAINNET_REFUSED");
          if (
            manifest.chainId !== 84532 ||
            manifest.deploymentId !== row.deploymentId
          )
            throw new Error("DEPLOYMENT_MISMATCH");
          const observation = await deps.reader.read(row, manifest);
          if (observation.chainId === 8453) throw new Error("MAINNET_REFUSED");
          if (observation.chainId !== 84532)
            throw new Error("DEPLOYMENT_MISMATCH");
          const tx = observation.transaction,
            receipt = observation.receipt;
          if (
            row.status === "INCLUDED" &&
            observation.previousCanonical === false
          )
            next.status = "REORGED";
          else if (tx) {
            if (!same(tx.from, row.wallet))
              next.rejectReason = "SENDER_MISMATCH";
            else if (
              !same(
                tx.to,
                row.action === "APPROVE"
                  ? manifest.contracts.BlinkTestUSD
                  : manifest.contracts.BlinkMarket,
              )
            )
              next.rejectReason = "TARGET_MISMATCH";
            else if (
              tx.action !== row.action ||
              (row.action === "APPROVE" &&
                !same(tx.spender, manifest.contracts.BlinkMarket))
            )
              next.rejectReason = "ACTION_MISMATCH";
            else if (
              row.action === "FILL" &&
              !same(tx.quoteDigest, row.quoteId)
            )
              next.rejectReason = "QUOTE_MISMATCH";
            else {
              if (row.action !== "APPROVE") next.marketId = tx.marketId ?? null;
              if (receipt?.canonical) {
                next.receiptBlockHash = receipt.blockHash;
                next.receiptBlockNumber = receipt.blockNumber;
                next.status = !receipt.success
                  ? "REVERTED"
                  : observation.finalizedNumber !== null &&
                      BigInt(receipt.blockNumber) <=
                        BigInt(observation.finalizedNumber)
                    ? "FINALIZED"
                    : "INCLUDED";
              } else if (receipt && !receipt.canonical && row.receiptBlockHash)
                next.status = "REORGED";
            }
          }
        } catch (error) {
          if (
            error instanceof Error &&
            ["MAINNET_REFUSED", "DEPLOYMENT_MISMATCH"].includes(error.message)
          )
            throw error;
          // Rotate transient failures too, so one unavailable hash cannot starve later hints.
          failure ??= error;
        }
        if (await deps.store.update(row, next)) updated++;
      }
      if (failure) throw failure;
      return updated;
    },
  };
}
