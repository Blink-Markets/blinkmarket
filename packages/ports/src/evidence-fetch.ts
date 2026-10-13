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
export interface FetchSource {
  sourceUrl: string;
  /** Source allow-listed (`enabled`) and fetching reviewed (`fetch_enabled`). */
  fetchable: boolean;
  allowedMime: string[];
  redirectPrefixes: string[];
  accessPolicy: "PUBLIC" | "PRIVATE";
}
export interface EvidenceFetchStore {
  source(sourceId: string): Promise<FetchSource | null>;
  /** One transaction: the evidence record and its SUCCEEDED attempt. */
  recordSuccess(input: {
    sourceId: string;
    jobId: string;
    operatorId: string;
    contentHash: string;
    objectUri: string;
    finalUrl: string;
    accessPolicy: "PUBLIC" | "PRIVATE";
  }): Promise<{ evidenceId: string }>;
  /** FAILED for a retryable error; MANUAL for one that needs a person, which also writes an audit row. */
  recordFailure(input: {
    sourceId: string;
    jobId: string;
    state: "FAILED" | "MANUAL";
    errorCode: string;
  }): Promise<void>;
}
