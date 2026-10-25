import { apiContracts, type ProtocolDeployment } from "@blink/schemas";
import type {
  IdentityPrincipal,
  KeyScope,
  ProtocolReader,
  TrackedTransaction,
  TrackedUpdate,
  TxTrackingStore,
  TxReceiptReader,
} from "@blink/ports";
import { IdentityError, readFreshIndex } from "./identity.js";
import type { RouteService } from "./route-service.js";
const same = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
export function createTxTracker(deps: {
  store: TxTrackingStore;
  reader: TxReceiptReader;
  manifest(deploymentId: string): Promise<ProtocolDeployment | null>;
}) {
  return {
    async trackOnce(limit = 50): Promise<number> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("INVALID_TRACKING_LIMIT");
      let updated = 0;
      let failure: unknown;
      for (const row of await deps.store.pending(limit)) {
        const next: TrackedUpdate = {
          action: row.action,
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
            else if (tx.contract === null)
              next.rejectReason = "TARGET_MISMATCH";
            else if (tx.action === null)
              next.rejectReason = "ACTION_MISMATCH";
            else {
              next.action = tx.action;
              next.marketId = tx.marketId ?? null;
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

export const txTrackingPaths = ["/v1/transactions"] as const;
const hintBody = apiContracts.find(
  (c) => c.method === "POST" && c.path === "/v1/transactions",
)!.body!;

/**
 * POST /v1/transactions: any API key registers a hash for tracking. Nothing is trusted here: the
 * tracker later decodes the transaction and rejects a sender other than the key's wallet or a
 * target outside the current generation, the faucet and the anchor.
 */
export function createTxTrackingService(deps: {
  store: Pick<TxTrackingStore, "track">;
  identity: {
    authenticate(
      authorization: string | undefined,
      scope?: KeyScope,
    ): Promise<IdentityPrincipal>;
  };
  /** A hint is written for an identity, so it is refused (503 INDEX_STALE) while the index lags. */
  reader: Pick<ProtocolReader, "health">;
  /** The registered protocol generation hints belong to. */
  deploymentId: string;
  newId?: () => string;
}): RouteService {
  return {
    paths: txTrackingPaths,
    async handle(req) {
      const principal = await deps.identity.authenticate(req.authorization);
      const body = hintBody.safeParse(req.body);
      if (!body.success) throw new IdentityError(400, "INVALID_REQUEST");
      if (!principal.address) throw new IdentityError(403, "NOT_REGISTERED");
      await readFreshIndex(deps.reader, async () => undefined);
      const row = await deps.store.track({
        id: (deps.newId ?? (() => crypto.randomUUID()))(),
        deploymentId: deps.deploymentId,
        txHash: (body.data as { txHash: string }).txHash.toLowerCase(),
        agentId: principal.agentId,
        wallet: principal.address.toLowerCase(),
      });
      if (row.agentId !== principal.agentId)
        throw new IdentityError(409, "TX_ALREADY_TRACKED");
      return { status: 202, body: { trackingId: row.id, status: row.status } };
    },
  };
}
