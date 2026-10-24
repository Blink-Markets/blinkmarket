// Adapters may not import @blink/domain, so the pure fetch policy is re-exported here.
export {
  FetchError,
  MAX_REDIRECTS,
  checkFetchUrl,
  isPublicAddress,
} from "@blink/domain";

export interface FetchPolicy {
  exactUrl: string;
  redirectPrefixes: readonly string[];
  allowedMime: readonly string[];
}
// Connects to the already validated address; the URL's host stays the TLS name. Header names are lower-case.
export interface FetchTransport {
  request(input: {
    ip: string;
    family: 4 | 6;
    url: URL;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: AsyncIterable<Uint8Array>;
  }>;
}
// Throws FetchError(code, retryable). The returned bytes are the original, decoded document bytes.
export interface SourceFetcher {
  fetch(
    policy: FetchPolicy,
    signal: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    finalUrl: string;
    mime: string;
    observedAt: Date;
  }>;
}
