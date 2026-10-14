import {
  DISCOVERY_MAX_OUTPUT_TOKENS,
  JobError,
  SCAN_QUESTION_CAP_USD_MICROS,
  discoveryPrompt,
} from "@blink/domain";
import { CandidateCreated, DiscoveryOutput } from "@blink/schemas";
import type {
  DiscoveryApi,
  DiscoveryStore,
  ImmutableObjectStore,
  JobQueue,
  ScanAnswer,
  ScanRun,
} from "@blink/ports";
import { apiFailure, lastAttempt, type RunningJob } from "./api-failure.js";
import type { createBudgetedModelCaller } from "./budgeted-model.js";
import { schedulePeriodic } from "./worker-runtime.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
// One model call and its single retry: a scan never starts a third.
const MAX_MODEL_ATTEMPTS = 2;
const SLOT_MS = 12 * 3_600_000;
// Design 05: a discovery job gets two attempts.
const SCAN_JOB_ATTEMPTS = 2;

type Handler = (ctx: { job: RunningJob; signal: AbortSignal }) => Promise<void>;

function parseOutput(text: string): DiscoveryOutput | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = DiscoveryOutput.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * `discovery.scan`: turns one source's newest document into at most one candidate. The model only
 * proposes entity, period, threshold and thesis; the evidence a candidate cites is always the
 * record this run fetched, and the candidate is created through the public API like any agent's.
 * The validated proposal is stored with the day's slot before the API is called, so a redelivery
 * replays the same request under the same idempotency key instead of asking the model again.
 */
export function createDiscoveryHandler(deps: {
  store: DiscoveryStore;
  /** Task 3's fetch handler as a function; `jobId` makes a redelivered fetch a no-op. */
  fetchEvidence(input: {
    jobId: string;
    sourceId: string;
    signal: AbortSignal;
  }): Promise<void>;
  objects: ImmutableObjectStore;
  model: Pick<ReturnType<typeof createBudgetedModelCaller>, "call">;
  modelName: string;
  api: DiscoveryApi;
  hash(bytes: Uint8Array): string;
  newId(): string;
}): Handler {
  const { store } = deps;

  async function resolveEvidence(
    run: ScanRun,
    sourceId: string,
    day: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (run.evidenceId) return run.evidenceId;
    let evidenceId: string | null;
    try {
      await deps.fetchEvidence({ jobId: run.id, sourceId, signal });
      evidenceId = await store.fetchedEvidence(run.id);
    } catch (error) {
      // A source that may not be fetched stays unused; any other failure may still leave
      // today's earlier document to scan.
      if (!(error instanceof JobError) || error.code === "SOURCE_NOT_FETCHABLE")
        throw error;
      evidenceId = await store.newestEvidence(sourceId, day);
      if (!evidenceId) throw error;
    }
    if (!evidenceId) throw new JobError("EVIDENCE_NOT_FOUND", true);
    await store.recordEvidence(run.id, evidenceId);
    return evidenceId;
  }

  // Asks the model until it gives a valid proposal, then takes a slot and stores the answer in
  // one step. Returns null when the run ended instead (declined, review, no slot left).
  async function propose(
    run: ScanRun,
    sourceId: string,
    day: string,
    job: RunningJob,
    signal: AbortSignal,
  ): Promise<{ evidenceId: string; answer: ScanAnswer } | null> {
    const manual = async (errorCode: string) => {
      await store.finish(run.id, {
        state: "MANUAL_REVIEW",
        errorCode,
        audit: "discovery.manual_review",
      });
      return null;
    };
    const evidenceId = await resolveEvidence(run, sourceId, day, signal);
    const evidence = await store.evidence(evidenceId);
    if (!evidence) throw new JobError("EVIDENCE_NOT_FOUND", false);
    const bytes = await deps.objects.read(evidence.objectUri);
    if (deps.hash(bytes).toLowerCase() !== evidence.contentHash.toLowerCase())
      return manual("EVIDENCE_HASH_MISMATCH");
    const prompt = discoveryPrompt(new TextDecoder().decode(bytes));
    const promptHash = deps.hash(encoder.encode(prompt.system));

    for (;;) {
      const attempt = await store.beginModelAttempt(run.id);
      if (attempt === null) return manual("ATTEMPTS_EXHAUSTED");
      let output: string;
      try {
        ({ output } = await deps.model.call({
          // The first call is the scan itself; a retry is a new run with its own reservation.
          runId: attempt === 1 ? run.id : deps.newId(),
          questionKey: "scan:" + run.id,
          questionCapUsdMicros: SCAN_QUESTION_CAP_USD_MICROS,
          model: deps.modelName,
          promptHash,
          system: prompt.system,
          input: prompt.input,
          maxOutputTokens: DISCOVERY_MAX_OUTPUT_TOKENS,
          jobId: job.id,
          signal,
        }));
      } catch (error) {
        if (error instanceof JobError && !error.retryable)
          await store.finish(run.id, {
            state: "FAILED",
            errorCode: error.code,
          });
        throw error;
      }
      const parsed = parseOutput(output);
      if (!parsed) {
        if (attempt >= MAX_MODEL_ATTEMPTS) return manual("SCHEMA_INVALID");
        continue;
      }
      if ("candidate" in parsed) {
        await store.finish(run.id, { state: "NO_CANDIDATE" });
        return null;
      }
      const taken = await store.takeSlot(run.id, parsed);
      if (taken === "CAP") {
        await store.finish(run.id, { state: "SKIPPED_DAILY_CAP" });
        return null;
      }
      // Another delivery of this run stored its own answer meanwhile; retry with that one.
      if (taken === "ALREADY") throw new JobError("SCAN_IN_PROGRESS", true);
      return { evidenceId, answer: parsed };
    }
  }

  return async ({ job, signal }) => {
    const { sourceId, day, slot } = job.payload;
    if (
      typeof sourceId !== "string" ||
      !uuid.test(sourceId) ||
      typeof day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      Number.isNaN(Date.parse(day)) ||
      (slot !== 0 && slot !== 1)
    )
      throw new JobError("INVALID_PAYLOAD", false);
    const run = await store.startRun({ sourceId, day, slot });
    // The unique (source, day, slot) run makes a rerun or redelivery of a settled scan a no-op.
    if (run.state !== "STARTED") return;
    // A stored answer means an earlier delivery took the slot: replay it, never re-ask the model.
    if (run.answer && !run.evidenceId)
      throw new JobError("EVIDENCE_NOT_FOUND", false);
    const replay = run.answer !== null && run.answer !== undefined;
    const proposal = replay
      ? { evidenceId: run.evidenceId!, answer: run.answer! }
      : await propose(run, sourceId, day, job, signal);
    if (!proposal) return;

    try {
      const { candidateId } = CandidateCreated.parse(
        await deps.api.createCandidate(
          {
            templateId: "GM_LT_V1",
            entityId: proposal.answer.entityId,
            fiscalPeriod: proposal.answer.fiscalPeriod,
            thresholdBps: proposal.answer.thresholdBps,
            evidenceIds: [proposal.evidenceId],
            thesis: proposal.answer.thesis,
          },
          run.id,
        ),
      );
      return await store.finish(run.id, {
        state: "CANDIDATE_CREATED",
        candidateId,
      });
    } catch (error) {
      const failure = apiFailure(error);
      const code = failure?.code ?? "API_UNAVAILABLE";
      // The API refused this candidate for good. On a first delivery none exists, so the slot
      // goes back; on a replay an earlier delivery may have created it, so the slot stays counted.
      if (failure && !failure.retryable)
        return store.finish(run.id, {
          state: "MANUAL_REVIEW",
          errorCode: code,
          audit: "discovery.manual_review",
          ...(replay ? { keepSlot: true } : {}),
        });
      // Out of attempts with the outcome unknown (a candidate may exist): a person checks, and
      // the slot stays counted so the day's cap can never be exceeded.
      if (lastAttempt(job))
        return store.finish(run.id, {
          state: "MANUAL_REVIEW",
          errorCode: code,
          audit: "discovery.manual_review",
          keepSlot: true,
        });
      // The next delivery resumes from the stored answer.
      throw new JobError(code, true);
    }
  };
}

/** Enqueues one `discovery.scan` per fetch-enabled source for the current UTC day and slot. */
export function createDiscoveryScheduler(deps: {
  store: DiscoveryStore;
  queue: JobQueue;
}) {
  return {
    async scheduleOnce(): Promise<number> {
      const now = await deps.store.now();
      const day = now.toISOString().slice(0, 10);
      const slot = now.getUTCHours() < 12 ? 0 : 1;
      const sources = await deps.store.fetchableSources();
      for (const sourceId of sources)
        await schedulePeriodic(
          deps.queue,
          "discovery.scan",
          SLOT_MS,
          { sourceId, day, slot },
          now,
          SCAN_JOB_ATTEMPTS,
        );
      return sources.length;
    },
  };
}
