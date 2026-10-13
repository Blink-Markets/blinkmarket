/** Provider price per model, in USD micros (1 USD = 1000000). */
export interface ModelRate {
  inputUsdMicrosPerMillionTokens: bigint;
  outputUsdMicrosPerMillionTokens: bigint;
  perRequestUsdMicros: bigint;
}

const MILLION = 1_000_000n;
const ceilDiv = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - 1n) / denominator;

function count(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`INVALID_${name}`);
  return BigInt(value);
}

/** Cost of a known token usage; every component rounds up so a total is never understated. */
export function usageCostUsdMicros(input: {
  inputTokens: number;
  outputTokens: number;
  rate: ModelRate;
}): bigint {
  const { rate } = input;
  return (
    ceilDiv(
      count("INPUT_TOKENS", input.inputTokens) *
        rate.inputUsdMicrosPerMillionTokens,
      MILLION,
    ) +
    ceilDiv(
      count("OUTPUT_TOKENS", input.outputTokens) *
        rate.outputUsdMicrosPerMillionTokens,
      MILLION,
    ) +
    rate.perRequestUsdMicros
  );
}

/**
 * Worst-case cost to reserve before a request is sent. A token is at least one
 * UTF-8 byte of text, so `tokens <= bytes` is the conservative bound for input.
 */
export function maxCostUsdMicros(input: {
  inputBytes: number;
  maxOutputTokens: number;
  rate: ModelRate;
}): bigint {
  return usageCostUsdMicros({
    inputTokens: input.inputBytes,
    outputTokens: input.maxOutputTokens,
    rate: input.rate,
  });
}

/** How a model call ended when it did not return output. */
export type ModelCallErrorKind = "NOT_SENT" | "UNKNOWN" | "FAILED_WITH_USAGE";

/** Thrown by a ModelGateway: `NOT_SENT` never reached the provider, `UNKNOWN` may have, `FAILED_WITH_USAGE` was billed. */
export class ModelCallError extends Error {
  constructor(
    readonly kind: ModelCallErrorKind,
    readonly actualUsdMicros?: bigint,
    readonly providerRequestId?: string,
  ) {
    super(kind);
  }
}
