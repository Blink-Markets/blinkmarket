import { keeperDecision, JobError } from "@blink/domain";
import type {
  KeeperStore,
  RestrictedSigner,
  ExecutionChainReader,
} from "@blink/ports";

export function createKeeperHandler(deps: {
  store: KeeperStore;
  deploymentId: string;
  reader: Pick<ExecutionChainReader, "marketState">;
  signer: RestrictedSigner;
}) {
  return async (ctx: {
    job: { id: string; payload: Record<string, unknown> };
    signal: AbortSignal;
  }): Promise<void> => {
    for (const market of await deps.store.candidates(deps.deploymentId)) {
      if (ctx.signal.aborted) throw new JobError("OPERATION_ABORTED", true);
      const decision = keeperDecision(market, market.nowChain);
      if (decision)
        await deps.store.prepare(deps.deploymentId, market.marketId, decision);
    }
    // Retry persisted work even when the projection has moved on; UNKNOWN always names the same request.
    for (const request of await deps.store.pending(deps.deploymentId)) {
      if (ctx.signal.aborted) throw new JobError("OPERATION_ABORTED", true);
      if ((await deps.reader.marketState(request.marketId)) === "FINAL") {
        await deps.store.cancel(request);
        continue;
      }
      let result;
      try {
        result = await deps.signer.sign({
          signRequestId: request.signRequestId,
          expectedRequestHash: request.requestHash,
        });
      } catch {
        result = { state: "UNKNOWN" as const, code: "SIGNER_ERROR" };
      }
      await deps.store.signed(request, result);
    }
  };
}
