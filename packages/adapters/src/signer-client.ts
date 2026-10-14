import type { RestrictedSigner, SignResult } from "@blink/ports";

/**
 * HTTP client for the private signer. A timeout or network failure is UNKNOWN, never REJECTED:
 * the signer may have signed and committed before the connection dropped, so the caller keeps its
 * reservation and asks again with the same signRequestId.
 */
export function signerClient(options: {
  url: string;
  token: string;
  timeoutMs?: number;
}): RestrictedSigner {
  const endpoint = new URL("/internal/sign", options.url);
  return {
    async sign(input): Promise<SignResult> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: "Bearer " + options.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            signRequestId: input.signRequestId,
            expectedRequestHash: input.expectedRequestHash,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
      } catch {
        return { state: "UNKNOWN", code: "SIGNER_TIMEOUT" };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { state: "UNKNOWN", code: "SIGNER_BAD_RESPONSE" };
      }
      const record =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      if (response.status === 200 && record.state === "SIGNED")
        return signed(record);
      if (response.status === 422 && record.state === "REJECTED")
        return rejected(record);
      // Authentication, authorization, validation and not-found answers: nothing was signed.
      if (
        [400, 401, 403, 404].includes(response.status) &&
        typeof record.code === "string"
      )
        return { state: "REJECTED", code: record.code };
      return {
        state: "UNKNOWN",
        code: typeof record.code === "string" ? record.code : "SIGNER_ERROR",
      };
    },
  };
}

function signed(record: Record<string, unknown>): SignResult {
  if (
    typeof record.artifactId !== "string" ||
    typeof record.artifactHash !== "string"
  )
    return { state: "UNKNOWN", code: "SIGNER_BAD_RESPONSE" };
  return {
    state: "SIGNED",
    artifactId: record.artifactId,
    artifactHash: record.artifactHash,
    ...(typeof record.signature === "string"
      ? { signature: record.signature }
      : {}),
    ...(typeof record.txHash === "string" ? { txHash: record.txHash } : {}),
  };
}
function rejected(record: Record<string, unknown>): SignResult {
  return typeof record.code === "string"
    ? { state: "REJECTED", code: record.code }
    : { state: "UNKNOWN", code: "SIGNER_BAD_RESPONSE" };
}
