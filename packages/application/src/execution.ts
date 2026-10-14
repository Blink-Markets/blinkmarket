import { JobError } from "@blink/domain";
import type {
  DispatchStore,
  FaucetStore,
  RestrictedSigner,
  ExecutionChainReader,
} from "@blink/ports";
import type { DispatchResult } from "./tx-dispatcher.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createFaucetMintHandler(deps: {
  store: FaucetStore;
  signer: RestrictedSigner;
}) {
  return async (ctx: {
    job: { id: string; payload: Record<string, unknown> };
    signal: AbortSignal;
  }): Promise<void> => {
    const claimId = ctx.job.payload.claimId;
    if (typeof claimId !== "string" || !uuid.test(claimId))
      throw new JobError("INVALID_JOB_PAYLOAD", false);
    if (ctx.signal.aborted) throw new JobError("OPERATION_ABORTED", true);
    const request = await deps.store.mintRequest(claimId);
    if (!request) return;
    let result;
    try {
      result = await deps.signer.sign({
        signRequestId: request.signRequestId,
        expectedRequestHash: request.requestHash,
      });
    } catch {
      result = { state: "UNKNOWN" as const, code: "SIGNER_ERROR" };
    }
    await deps.store.signed(claimId, result);
    if (result.state === "UNKNOWN") throw new JobError("SIGN_UNKNOWN", true);
  };
}

/** Keep application outcomes in step with the dispatcher's persisted canonical observations. */
export function createExecutionDispatcher(deps: {
  dispatcher: {
    dispatch(intentId: string, signal?: AbortSignal): Promise<DispatchResult>;
  };
  store: DispatchStore;
  faucet: FaucetStore;
  reader: Pick<ExecutionChainReader, "blockTimestamp">;
}) {
  return {
    async dispatch(
      intentId: string,
      signal?: AbortSignal,
    ): Promise<DispatchResult> {
      try {
        return await deps.dispatcher.dispatch(intentId, signal);
      } finally {
        const snapshot = await deps.store.run((tx) => tx.snapshot(intentId));
        if (snapshot?.intent.kind === "MINT") {
          const mined = snapshot.attempts.find((a) =>
            ["INCLUDED", "FINALIZED", "REVERTED"].includes(a.status),
          );
          if (mined && mined.receiptBlockNumber !== null) {
            const succeeded = mined.receiptStatus === "success";
            await deps.faucet.settle(intentId, {
              state: succeeded ? "SUCCEEDED" : "FAILED",
              ...(succeeded
                ? {
                    succeededAt: new Date(
                      Number(
                        await deps.reader.blockTimestamp(
                          mined.receiptBlockNumber,
                        ),
                      ) * 1000,
                    ),
                  }
                : {}),
              attempt: { id: mined.id, version: mined.version },
            });
          } else if (snapshot.intent.state === "FAILED") {
            await deps.faucet.settle(intentId, { state: "FAILED" });
          } else if (snapshot.attempts.length) {
            const latest = snapshot.attempts.at(-1)!;
            await deps.faucet.settle(intentId, {
              state: latest.status === "UNKNOWN" ? "UNKNOWN" : "SUBMITTED",
              attempt: { id: latest.id, version: latest.version },
            });
          }
        }
      }
    },
  };
}
