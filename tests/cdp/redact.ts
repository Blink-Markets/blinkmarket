// Turns any failure of a CDP step into an error that carries only fixed, safe text. The SDK copies
// API response text into its errors (and may keep the original as a cause), so nothing of the
// original value is passed on: no message, stack, cause or property, only its class name and status.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function safeName(thrown: unknown): string {
  try {
    const name: unknown = (thrown as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
    return typeof name === "string" && NAME_PATTERN.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

function safeStatus(thrown: unknown): number | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;
  for (const field of ["status", "statusCode"]) {
    try {
      const value: unknown = (thrown as Record<string, unknown>)[field];
      if (typeof value === "number" && Number.isInteger(value)) return value;
    } catch {
      // A getter that throws is as good as no status.
    }
  }
  return undefined;
}

/** Runs one stage of the CDP check; a failure becomes `CDP_CHECK_FAILED stage=<stage> error=<name>[ status=<n>]`. */
export async function redacted<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (thrown) {
    const status = safeStatus(thrown);
    throw new Error(
      `CDP_CHECK_FAILED stage=${stage} error=${safeName(thrown)}${status === undefined ? "" : ` status=${status}`}`,
    );
  }
}
