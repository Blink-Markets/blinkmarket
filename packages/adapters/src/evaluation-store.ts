import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  EvaluationStore,
  EvaluationWindow,
  MetricsReader,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";

export function postgresEvaluationStore(
  pool: Pool,
): EvaluationStore & MetricsReader {
  const uow = createUnitOfWork(pool);
  return {
    async metrics(mode) {
      const { rows } = await pool.query<{
        event_count: string;
        missing_count: string;
        invalid_count: string;
        brier: string | null;
      }>(
        `WITH scores AS (
        SELECT s.* FROM analytics.score_entries s
        JOIN protocol.market_reads m USING(deployment_id,market_id)
        WHERE s.mode=$1 AND m.mode=$1 AND m.state='FINAL'
          AND s.outcome=m.final_outcome AND s.scorer='AGENT' AND s.evaluation_version='v1'
      ), events AS (
        SELECT deployment_id,market_id,AVG(brier) AS brier FROM scores
        WHERE outcome IN ('YES','NO') AND NOT missing AND NOT contaminated
        GROUP BY deployment_id,market_id
      )
      SELECT (SELECT count(*)::text FROM events) AS event_count,
        (SELECT count(*)::text FROM scores WHERE missing) AS missing_count,
        (SELECT count(*)::text FROM protocol.market_reads WHERE mode=$1 AND state='FINAL' AND final_outcome='INVALID') AS invalid_count,
        (SELECT round(AVG(brier),6)::text FROM events) AS brier`,
        [mode],
      );
      const r = rows[0]!;
      return {
        eventCount: r.event_count,
        missingCount: r.missing_count,
        invalidCount: r.invalid_count,
        brier: r.brier === null ? null : Number(r.brier),
      };
    },
    async scoreFinalWindows(score, signal) {
      await uow.run(async (tx) => {
        const db = uow.client(tx);
        const { rows } = await db.query<{
          window_id: string;
          deployment_id: string;
          market_id: string;
          mode: EvaluationWindow["mode"];
          outcome: EvaluationWindow["outcome"];
          agent_id: string | null;
          probability_millionths: number;
          withdrawn: boolean;
          contaminated: boolean;
        }>(
          "SELECT * FROM analytics.final_forecasts ORDER BY window_id,agent_id",
        );
        const windows = new Map<string, EvaluationWindow>();
        for (const r of rows) {
          let window = windows.get(r.window_id);
          if (!window) {
            window = {
              windowId: r.window_id,
              deploymentId: r.deployment_id,
              marketId: r.market_id,
              mode: r.mode,
              outcome: r.outcome,
              forecasts: [],
            };
            windows.set(r.window_id, window);
          }
          if (r.agent_id)
            window.forecasts.push({
              agentId: r.agent_id,
              probabilityMillionths: r.probability_millionths,
              withdrawn: r.withdrawn,
              contaminated: r.contaminated,
            });
        }
        for (const window of windows.values()) {
          if (signal?.aborted) throw new Error("OPERATION_ABORTED");
          for (const s of score(window)) {
            const x = s.probabilityMillionthsTimes2;
            await db.query(
              `INSERT INTO analytics.score_entries
              (id,deployment_id,market_id,window_id,mode,scorer,agent_id,probability_millionths,probability_millionths_times2,outcome,brier,missing,contaminated,evaluation_version)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
              ON CONFLICT (window_id,scorer,agent_id,evaluation_version) DO NOTHING`,
              [
                randomUUID(),
                s.deploymentId,
                s.marketId,
                s.windowId,
                s.mode,
                s.scorer,
                s.agentId,
                x !== null && x % 2 === 0 ? x / 2 : null,
                x,
                s.outcome,
                s.brier,
                s.missing,
                s.contaminated,
                s.evaluationVersion,
              ],
            );
          }
        }
      }, signal);
    },
  };
}
