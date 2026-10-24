import { brierExact } from "@blink/domain";
import type {
  EvaluationStore,
  EvaluationWindow,
  ScoreEntry,
  JobHandler,
  MetricsReader,
} from "@blink/ports";

import type { RouteService } from "./route-service.js";

const EVALUATION_VERSION = "v1";
// One entry per agent submission; a withdrawn submission is missing and has no score.
function scoreWindow(window: EvaluationWindow): ScoreEntry[] {
  const { forecasts, ...ref } = window;
  return forecasts.map((forecast) => {
    const missing = forecast.withdrawn;
    const x = missing ? null : 2 * forecast.probabilityMillionths;
    return {
      ...ref,
      scorer: "AGENT",
      agentId: forecast.agentId,
      probabilityMillionthsTimes2: x,
      missing,
      contaminated: forecast.contaminated,
      brier:
        x === null || window.outcome === "INVALID"
          ? null
          : brierExact(BigInt(x), window.outcome === "YES" ? 1 : 0),
      evaluationVersion: EVALUATION_VERSION,
    };
  });
}
export function createEvaluationHandler(store: EvaluationStore): JobHandler {
  return async ({ signal }) => {
    if (signal.aborted) throw new Error("OPERATION_ABORTED");
    await store.scoreFinalWindows(scoreWindow, signal);
  };
}

export function createMetricsService(deps: {
  store: MetricsReader;
}): RouteService {
  return {
    paths: ["/v1/metrics"],
    async handle(request) {
      const mode = request.query.mode as "LIVE" | "REPLAY";
      return {
        status: 200,
        headers: { "Cache-Control": "public, max-age=60" },
        body: { mode, ...(await deps.store.metrics(mode)) },
      };
    },
  };
}
