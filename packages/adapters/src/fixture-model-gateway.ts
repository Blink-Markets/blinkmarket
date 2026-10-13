import {
  ModelCallError,
  usageCostUsdMicros,
  type ModelCallRequest,
  type ModelGateway,
  type ModelRate,
} from "@blink/ports";

/**
 * A deterministic stand-in for a paid provider (REPLAY and tests; no network).
 * Like the worst-case reservation, it treats one UTF-8 byte as one token: the
 * response is cut to `maxOutputTokens` bytes (never inside a character) and the
 * reported cost is the usage cost of exactly the bytes returned, so it never
 * exceeds the reserved maximum.
 */
export function fixtureModelGateway(options: {
  provider?: string;
  rates: Record<string, ModelRate>;
  respond(request: ModelCallRequest): string | ModelCallError;
}): ModelGateway {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const rate = (model: string) =>
    Object.hasOwn(options.rates, model) ? options.rates[model]! : null;
  return {
    provider: options.provider ?? "fixture",
    rate,
    async call(request) {
      const modelRate = rate(request.model);
      if (!modelRate) throw new ModelCallError("NOT_SENT");
      const response = options.respond(request);
      if (response instanceof ModelCallError) throw response;
      const bytes = encoder.encode(response);
      let end = Math.min(bytes.length, request.maxOutputTokens);
      // Step back over continuation bytes so the cut does not split a character.
      while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80)
        end -= 1;
      return {
        output: decoder.decode(bytes.subarray(0, end)),
        providerRequestId: "fixture-" + request.runId,
        actualUsdMicros: usageCostUsdMicros({
          inputTokens: encoder.encode(request.system + request.input).length,
          outputTokens: end,
          rate: modelRate,
        }),
      };
    },
  };
}
