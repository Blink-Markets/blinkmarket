import {
  FORECAST_MAX_OUTPUT_TOKENS,
  JobError,
  PLATFORM_ROLES,
  forecastPrompt,
  type PlatformRole,
} from "@blink/domain";
import { ForecastOutput, MarketView, SubmissionReceipt } from "@blink/schemas";
import type {
  ForecastApi,
  ImmutableObjectStore,
  JobQueue,
  LeasedJob,
  PlatformRunStore,
} from "@blink/ports";
import { apiFailure, apiJobError } from "./api-failure.js";
import type { createBudgetedModelCaller } from "./budgeted-model.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
// One model call and its single retry after a schema error.
const MAX_ATTEMPTS = 2;

type Handler = (ctx: {
  job: Pick<LeasedJob, "id" | "payload">;
  signal: AbortSignal;
}) => Promise<void>;

function parseOutput(
  text: string,
  allowed: ReadonlySet<string>,
): ForecastOutput | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ForecastOutput.safeParse(json);
  if (!parsed.success) return null;
  const evidenceIds = [
    ...new Set(parsed.data.evidenceIds.map((id) => id.toLowerCase())),
  ];
  // A forecast may cite only the evidence it was shown.
  return evidenceIds.every((id) => allowed.has(id))
    ? { ...parsed.data, evidenceIds }
    : null;
}

/**
 * `forecast.run` / `baseline.run`: one platform agent's forecast for one window. Every input is
 * fixed by the window (data cutoff, evidence, registered prompt), each model call is a recorded
 * run with its own reservation, and the answer is submitted through the public API with the
 * agent's own key. The runner never reads other agents' answers.
 */
export function createForecastRunHandler(deps: {
  /** The roles this job type may run. */
  roles: readonly PlatformRole[];
  store: PlatformRunStore;
  objects: ImmutableObjectStore;
  model: Pick<ReturnType<typeof createBudgetedModelCaller>, "call">;
  apis: Partial<Record<PlatformRole, ForecastApi>>;
  hash(bytes: Uint8Array): string;
  newId(): string;
}): Handler {
  const { store } = deps;
  return async ({ job, signal }) => {
    const { windowId, role } = job.payload;
    if (
      typeof windowId !== "string" ||
      !uuid.test(windowId) ||
      typeof role !== "string" ||
      !PLATFORM_ROLES.includes(role as PlatformRole) ||
      !deps.roles.includes(role as PlatformRole)
    )
      throw new JobError("INVALID_PAYLOAD", false);
    const platformRole = role as PlatformRole;
    const api = deps.apis[platformRole];
    if (!api) throw new JobError("PLATFORM_API_NOT_CONFIGURED", false);
    const agent = await store.platformAgent(platformRole);
    if (!agent) throw new JobError("PLATFORM_AGENT_NOT_REGISTERED", false);
    const window = await store.window(windowId);
    if (!window) throw new JobError("WINDOW_NOT_FOUND", false);
    // Delivery is at-least-once: a window this agent already answered (or missed) is done.
    if (await store.settled(agent.agentId, window.windowId)) return;
    if (!window.approval) throw new JobError("APPROVAL_NOT_FOUND", false);

    const market = MarketView.parse(
      await api
        .getMarket({
          deploymentId: window.deploymentId,
          marketId: window.marketId,
          mode: window.mode,
        })
        .catch((error: unknown) => {
          throw apiJobError(error);
        }),
    );
    // data_cutoff is the window's opening: later evidence does not exist for this forecast.
    const ids = market.spec.sourceEvidenceIds.filter((id) => uuid.test(id));
    const evidence: { evidenceId: string; text: string }[] = [];
    for (const record of await store.evidence(ids, window.openAt)) {
      const bytes = await deps.objects.read(record.objectUri);
      if (deps.hash(bytes).toLowerCase() !== record.contentHash.toLowerCase())
        throw new JobError("EVIDENCE_HASH_MISMATCH", false);
      evidence.push({
        evidenceId: record.evidenceId,
        text: new TextDecoder().decode(bytes),
      });
    }
    if (evidence.length === 0)
      throw new JobError("NO_EVIDENCE_BEFORE_CUTOFF", false);
    const prompt = forecastPrompt(platformRole, market.spec, evidence);
    const promptHash = deps.hash(encoder.encode(prompt.system));
    if (promptHash.toLowerCase() !== agent.promptHash.toLowerCase())
      throw new JobError("PROMPT_MISMATCH", false);
    const inputHash = deps.hash(encoder.encode(prompt.input));
    const allowed = new Set(
      evidence.map((item) => item.evidenceId.toLowerCase()),
    );
    const closed = window.now < window.openAt || window.now >= window.deadline;
    const { candidateId, budgetMicros } = window.approval;

    for (let attempt = 1; ; attempt++) {
      const runId = deps.newId();
      await store.startRun({
        id: runId,
        agentId: agent.agentId,
        windowId: window.windowId,
        purpose: platformRole === "BASELINE" ? "BASELINE" : "FORECAST",
        model: agent.model,
        promptHash,
        sampling: { maxOutputTokens: FORECAST_MAX_OUTPUT_TOKENS },
        toolPolicy: "none",
        inputHash,
        dataCutoff: window.openAt,
      });
      // The database decides lateness again at submission; this only saves a doomed model call.
      if (closed) return store.updateRun(runId, { state: "LATE" });
      let result: Awaited<ReturnType<typeof deps.model.call>>;
      try {
        result = await deps.model.call({
          runId,
          questionKey: "candidate:" + candidateId,
          questionCapUsdMicros: budgetMicros,
          model: agent.model,
          promptHash,
          system: prompt.system,
          input: prompt.input,
          maxOutputTokens: FORECAST_MAX_OUTPUT_TOKENS,
          jobId: job.id,
          signal,
        });
      } catch (error) {
        await store.updateRun(runId, { state: "FAILED" });
        throw error;
      }
      const provenance = {
        reservationId: result.reservationId,
        providerRequestId: result.providerRequestId,
      };
      const answer = parseOutput(result.output, allowed);
      if (!answer) {
        await store.updateRun(runId, {
          state: "SCHEMA_INVALID",
          ...provenance,
        });
        if (attempt >= MAX_ATTEMPTS)
          throw new JobError("SCHEMA_INVALID", false);
        continue;
      }
      let receipt: unknown;
      try {
        receipt = await api.submitForecast(
          { deploymentId: window.deploymentId, marketId: window.marketId },
          {
            horizonKey: {
              horizonType: window.horizonType,
              scheduledAt: window.scheduledAt.toISOString(),
            },
            probability: answer.probability,
            evidenceIds: answer.evidenceIds,
            rationale: answer.rationale,
            agentVersion: `${agent.model}#${agent.promptHash}`,
          },
          runId,
        );
      } catch (error) {
        // The window closed while the model worked: a recorded miss, never retried.
        if (apiFailure(error)?.code === "FORECAST_WINDOW_CLOSED")
          return store.updateRun(runId, { state: "LATE", ...provenance });
        await store.updateRun(runId, { state: "FAILED", ...provenance });
        throw apiJobError(error);
      }
      return store.updateRun(runId, {
        state: "SUBMITTED",
        submissionId: SubmissionReceipt.parse(receipt).submissionId,
        ...provenance,
      });
    }
  };
}

/**
 * `forecast.dispatch`: queues each configured platform role once per open window of an open
 * market. The dedupe key makes the periodic dispatch safe to repeat every minute.
 */
export function createForecastDispatchHandler(deps: {
  store: PlatformRunStore;
  queue: JobQueue;
  roles: readonly PlatformRole[];
}): Handler {
  return async ({ signal }) => {
    for (const windowId of await deps.store.openWindows())
      for (const role of deps.roles) {
        if (signal.aborted) throw new JobError("OPERATION_ABORTED", true);
        await deps.queue.enqueue({
          type: role === "BASELINE" ? "baseline.run" : "forecast.run",
          dedupeKey: `forecast.run:${windowId}:${role}`,
          payload: { windowId, role },
          maxAttempts: 2,
        });
      }
  };
}
