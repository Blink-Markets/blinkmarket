import {
  ModelCallError,
  usageCostUsdMicros,
  type ModelCallRequest,
  type ModelGateway,
  type ModelRate,
} from "@blink/ports";

/**
 * A deterministic stand-in for a paid provider (REPLAY and tests; no network).
 * Its reported cost is the usage cost at the model's rate, and the output side
 * is clamped to `maxOutputTokens`, so it never exceeds the reserved maximum.
 */
export function fixtureModelGateway(options: {
  provider?: string;
  rates: Record<string, ModelRate>;
  respond(request: ModelCallRequest): string | ModelCallError;
}): ModelGateway {
  const encoder = new TextEncoder();
  const rate = (model: string) =>
    Object.hasOwn(options.rates, model) ? options.rates[model]! : null;
  return {
    provider: options.provider ?? "fixture",
    rate,
    async call(request) {
      const modelRate = rate(request.model);
      if (!modelRate) throw new ModelCallError("NOT_SENT");
      const output = options.respond(request);
      if (output instanceof ModelCallError) throw output;
      return {
        output,
        providerRequestId: "fixture-" + request.runId,
        actualUsdMicros: usageCostUsdMicros({
          inputTokens: encoder.encode(request.system + request.input).length,
          outputTokens: Math.min(
            encoder.encode(output).length,
            request.maxOutputTokens,
          ),
          rate: modelRate,
        }),
      };
    },
  };
}
