import { brierExact } from "@blink/domain";
import type {
  EvaluationStore,
  EvaluationWindow,
  EvaluationForecast,
  ScoreEntry,
  JobHandler,
  MetricsReader,
  BudgetLedger,
} from "@blink/ports";

import type { RouteService } from "./route-service.js";

const EVALUATION_VERSION = "v1";
function scoreWindow(window: EvaluationWindow): ScoreEntry[] {
  function entry(
    scorer: ScoreEntry["scorer"],
    forecasts: (EvaluationForecast | undefined)[],
    agentId: string | null = null,
  ): ScoreEntry {
    const missing = forecasts.some((f) => !f || f.withdrawn);
    const contaminated = forecasts.some((f) => f?.contaminated);
    const x = missing
      ? null
      : scorer === "ENSEMBLE"
        ? forecasts[0]!.probabilityMillionths +
          forecasts[1]!.probabilityMillionths
        : 2 * forecasts[0]!.probabilityMillionths;
    const { forecasts: _, ...ref } = window;
    return {
      ...ref,
      scorer,
      agentId,
      probabilityMillionthsTimes2: x,
      missing,
      contaminated,
      brier:
        x === null || window.outcome === "INVALID"
          ? null
          : brierExact(BigInt(x), window.outcome === "YES" ? 1 : 0),
      evaluationVersion: EVALUATION_VERSION,
    };
  }
  const role = (r: EvaluationForecast["role"]) =>
    window.forecasts.find((f) => f.role === r);
  return [
    entry("ENSEMBLE", [role("FORECASTER_A"), role("FORECASTER_B")]),
    entry("BASELINE", [role("BASELINE")]),
    ...window.forecasts
      .filter((f) => f.role === null)
      .map((f) => entry("AGENT", [f], f.agentId)),
  ];
}
export function createEvaluationHandler(store: EvaluationStore): JobHandler {
  return async ({ signal }) => {
    if (signal.aborted) throw new Error("OPERATION_ABORTED");
    await store.scoreFinalWindows(scoreWindow, signal);
  };
}

export function createMetricsService(deps: {
  store: MetricsReader;
  budgets: Pick<BudgetLedger, "totals">;
}): RouteService {
  return {
    paths: ["/v1/metrics"],
    async handle(request) {
      const mode = request.query.mode as "LIVE" | "REPLAY";
      const [metrics, costs] = await Promise.all([
        deps.store.metrics(mode),
        deps.budgets.totals(),
      ]);
      return {
        status: 200,
        headers: { "Cache-Control": "public, max-age=60" },
        body: {
          mode,
          ...metrics,
          spentUsdMicros: costs.spentUsdMicros.toString(),
          reservedUsdMicros: costs.reservedUsdMicros.toString(),
          unknownUsdMicros: costs.unknownUsdMicros.toString(),
        },
      };
    },
  };
}
