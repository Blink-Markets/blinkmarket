import { FetchError, JobError } from "@blink/domain";
import type {
  EvidenceFetchStore,
  ImmutableObjectStore,
  LeasedJob,
  SourceFetcher,
} from "@blink/ports";

// Needs only the job id and payload, so it is assignable to the worker's JobHandler.
export type EvidenceFetchHandler = (ctx: {
  job: Pick<LeasedJob, "id" | "payload">;
  signal: AbortSignal;
}) => Promise<void>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetches one reviewed source and archives it as evidence. Document bytes are data only: they are
 * hashed and stored, never parsed, and nothing in them can choose a URL, policy or side effect.
 */
export function createEvidenceFetchHandler(deps: {
  store: EvidenceFetchStore;
  fetcher: SourceFetcher;
  objects: ImmutableObjectStore;
  hash(bytes: Uint8Array): string;
  platformOperatorId: string;
}): EvidenceFetchHandler {
  return async ({ job, signal }) => {
    const sourceId = job.payload["sourceId"];
    if (typeof sourceId !== "string" || !uuid.test(sourceId))
      throw new JobError("INVALID_PAYLOAD", false);
    // Delivery is at-least-once: a redelivered job that already succeeded must not fetch again.
    if (await deps.store.hasSucceeded(job.id)) return;
    // A failure a person must look at: one MANUAL attempt and one audit row, no more retries.
    const manual = async (errorCode: string): Promise<never> => {
      await deps.store.recordFailure({
        sourceId,
        jobId: job.id,
        state: "MANUAL",
        errorCode,
      });
      throw new JobError(errorCode, false);
    };
    const source = await deps.store.source(sourceId);
    if (!source) throw new JobError("SOURCE_NOT_FETCHABLE", false);
    if (!source.fetchable) return manual("SOURCE_NOT_FETCHABLE");
    let fetched: Awaited<ReturnType<SourceFetcher["fetch"]>>;
    try {
      fetched = await deps.fetcher.fetch(
        {
          exactUrl: source.sourceUrl,
          redirectPrefixes: source.redirectPrefixes,
          allowedMime: source.allowedMime,
        },
        signal,
      );
    } catch (error) {
      // Anything but a FetchError (including cancellation) is not ours to classify.
      if (!(error instanceof FetchError)) throw error;
      if (!error.retryable) return manual(error.code);
      await deps.store.recordFailure({
        sourceId,
        jobId: job.id,
        state: "FAILED",
        errorCode: error.code,
      });
      throw new JobError(error.code, true);
    }
    const contentHash = deps.hash(fetched.bytes);
    const { uri } = await deps.objects.putIfAbsent(fetched.bytes, contentHash);
    // Archive IO precedes SQL: a failed transaction may leave an unreferenced immutable object, never a dangling reference.
    if (deps.hash(await deps.objects.read(uri)) !== contentHash)
      return manual("EVIDENCE_HASH_MISMATCH");
    // Null means a duplicate delivery of this job recorded its success first; that record stands.
    await deps.store.recordSuccess({
      sourceId,
      jobId: job.id,
      operatorId: deps.platformOperatorId,
      contentHash,
      objectUri: uri,
      finalUrl: fetched.finalUrl,
      accessPolicy: source.accessPolicy,
    });
  };
}
