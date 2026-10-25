import {
  brierExact,
  consensus,
  forecasterWeight,
  windowContaminated,
} from "@blink/domain";
import type {
  EvaluationStore,
  EvaluationWindow,
  ScoreEntry,
  JobHandler,
  MetricsReader,
  ProtocolReader,
} from "@blink/ports";

import type { RouteService } from "./route-service.js";

/** v2: per wallet, plus the consensus per window. v1 rows (per agent id) stay as they were. */
export const EVALUATION_VERSION = "v2";
const MARKET_PAGE = 100;

/**
 * One entry per submitted answer (a withdrawn answer is missing and has no score), and one for the
 * window's credit-weighted consensus when any answer stands. Exact Brier on integer millionths.
 */
export function scoreWindow(window: EvaluationWindow): ScoreEntry[] {
  const { forecasts, weights, deadline: _deadline, ...ref } = window;
  const entry = (
    scorer: ScoreEntry["scorer"],
    forecaster: string | null,
    missing: boolean,
    bps: number | null,
  ): ScoreEntry => {
    // bps / 10000 is bps * 100 millionths; the stored value is twice that.
    const x = missing || bps === null ? null : bps * 200;
    return {
      ...ref,
      scorer,
      forecaster,
      probabilityMillionthsTimes2: x,
      missing,
      brier:
        x === null || window.outcome === "INVALID"
          ? null
          : brierExact(BigInt(x), window.outcome === "YES" ? 1 : 0),
      evaluationVersion: EVALUATION_VERSION,
    };
  };
  const entries = forecasts.map((f) =>
    entry("AGENT", f.forecaster, f.withdrawn, f.probabilityBps),
  );
  const standing = forecasts.filter((f) => !f.withdrawn);
  const bps = consensus(standing, weights);
  if (bps !== null) entries.push(entry("CONSENSUS", null, false, bps));
  return entries;
}

/**
 * Scores the windows of every FINAL market once. The market state, mode, outcome and the proposal
 * (for contamination) all come from the ProtocolReader; the store only knows windows and answers.
 */
export function createEvaluationHandler(deps: {
  store: EvaluationStore;
  reader: Pick<ProtocolReader, "markets" | "proposal">;
  deploymentId: string;
}): JobHandler {
  const { store, reader, deploymentId } = deps;
  return async ({ signal }) => {
    let after: string | undefined;
    do {
      if (signal.aborted) throw new Error("OPERATION_ABORTED");
      const page = await reader.markets({
        states: ["FINAL"],
        limit: MARKET_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      for (const market of page.items) {
        if (signal.aborted) throw new Error("OPERATION_ABORTED");
        if (market.finalOutcome === null) continue;
        const windows = await store.unscoredWindows(market.marketId);
        if (!windows.length) continue;
        const proposal = await reader.proposal(market.marketId);
        for (const w of windows) {
          const forecasters = [...new Set(w.forecasts.map((f) => f.forecaster))];
          // Credit as it stood at the deadline, so later scores never change an earlier consensus.
          const stats = await store.creditStats(forecasters, w.deadline);
          await store.saveScores(
            scoreWindow({
              windowId: w.windowId,
              deploymentId,
              marketId: market.marketId,
              mode: market.replay ? "REPLAY" : "LIVE",
              outcome: market.finalOutcome,
              deadline: Math.floor(w.deadline.getTime() / 1000),
              contaminated: windowContaminated(
                proposal,
                Math.floor(w.deadline.getTime() / 1000),
              ),
              forecasts: w.forecasts,
              weights: Object.fromEntries(
                stats.map((s) => [s.address, forecasterWeight(s)]),
              ),
            }),
          );
        }
      }
      after = page.next ?? undefined;
    } while (after !== undefined);
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
