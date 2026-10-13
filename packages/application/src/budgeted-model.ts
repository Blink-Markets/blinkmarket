import { JobError, ModelCallError, maxCostUsdMicros } from "@blink/domain";
import type { BudgetLedger, ModelCallResult, ModelGateway } from "@blink/ports";

export { ModelCallError };

const encoder = new TextEncoder();

/**
 * Pays for nothing it has not reserved: the worst-case cost is reserved first,
 * then the provider is called, then the reservation is settled with what really
 * happened. It never retries; a retry is a new run with its own reservation, and
 * an UNKNOWN earlier attempt keeps its reservation.
 */
export function createBudgetedModelCaller(deps: {
  ledger: BudgetLedger;
  gateway: ModelGateway;
}) {
  const { ledger, gateway } = deps;
  return {
    async call(input: {
      runId: string;
      questionKey: string;
      questionCapUsdMicros: bigint;
      model: string;
      promptHash: string;
      system: string;
      input: string;
      maxOutputTokens: number;
      jobId?: string;
      signal?: AbortSignal;
    }): Promise<ModelCallResult & { reservationId: string }> {
      const rate = gateway.rate(input.model);
      if (!rate) throw new JobError("MODEL_RATE_UNKNOWN", false);
      const maxUsdMicros = maxCostUsdMicros({
        inputBytes: encoder.encode(input.system + input.input).length,
        maxOutputTokens: input.maxOutputTokens,
        rate,
      });
      const { reservationId } = await ledger.reserve({
        runId: input.runId,
        questionKey: input.questionKey,
        questionCapUsdMicros: input.questionCapUsdMicros,
        provider: gateway.provider,
        model: input.model,
        maxUsdMicros,
        ...(input.jobId ? { jobId: input.jobId } : {}),
      });
      let result: ModelCallResult;
      try {
        result = await gateway.call({
          runId: input.runId,
          model: input.model,
          promptHash: input.promptHash,
          system: input.system,
          input: input.input,
          maxOutputTokens: input.maxOutputTokens,
          reservationId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        // Anything that is not an explicit "never sent" or a billed failure may
        // have reached the provider, so it is never treated as free.
        const failure =
          error instanceof ModelCallError
            ? error
            : new ModelCallError("UNKNOWN");
        if (failure.kind === "NOT_SENT") await ledger.release(reservationId);
        else if (
          failure.kind === "FAILED_WITH_USAGE" &&
          failure.actualUsdMicros !== undefined &&
          failure.providerRequestId
        )
          await ledger.reconcile(
            reservationId,
            failure.actualUsdMicros,
            failure.providerRequestId,
          );
        else
          await ledger.markUnknown(
            reservationId,
            failure.providerRequestId ?? null,
          );
        throw new JobError("MODEL_CALL_FAILED", failure.kind !== "UNKNOWN");
      }
      await ledger.reconcile(
        reservationId,
        result.actualUsdMicros ?? maxUsdMicros,
        result.providerRequestId,
      );
      return { ...result, reservationId };
    },
  };
}
