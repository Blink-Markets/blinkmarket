import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  EvaluationForecast,
  EvaluationStore,
  MetricsReader,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import { queryCreditStats } from "./forecast-store.js";

const hex = (value: string) => value.slice(2).toLowerCase();

export function postgresEvaluationStore(
  pool: Pool,
  deploymentId: string,
): EvaluationStore & MetricsReader {
  const uow = createUnitOfWork(pool);
  return {
    async metrics(mode) {
      const { rows } = await pool.query<{
        event_count: string;
        missing_count: string;
        invalid_count: string;
        brier: string | null;
        consensus_brier: string | null;
      }>(
        `WITH scores AS (
        SELECT s.* FROM analytics.score_entries s
        JOIN protocol.market_reads m USING(deployment_id,market_id)
        WHERE s.mode=$1 AND m.mode=$1 AND m.state='FINAL'
          AND s.outcome=m.final_outcome AND s.evaluation_version='v2'
      ), eligible AS (
        SELECT * FROM scores WHERE outcome IN ('YES','NO') AND NOT missing AND NOT contaminated
      ), events AS (
        SELECT deployment_id,market_id,AVG(brier) AS brier FROM eligible
        WHERE scorer='AGENT' GROUP BY deployment_id,market_id
      ), consensus AS (
        SELECT deployment_id,market_id,AVG(brier) AS brier FROM eligible
        WHERE scorer='CONSENSUS' GROUP BY deployment_id,market_id
      )
      SELECT (SELECT count(*)::text FROM events) AS event_count,
        (SELECT count(*)::text FROM scores WHERE scorer='AGENT' AND missing) AS missing_count,
        (SELECT count(*)::text FROM protocol.market_reads WHERE mode=$1 AND state='FINAL' AND final_outcome='INVALID') AS invalid_count,
        (SELECT round(AVG(brier),6)::text FROM events) AS brier,
        (SELECT round(AVG(brier),6)::text FROM consensus) AS consensus_brier`,
        [mode],
      );
      const r = rows[0]!;
      return {
        eventCount: r.event_count,
        missingCount: r.missing_count,
        invalidCount: r.invalid_count,
        brier: r.brier === null ? null : Number(r.brier),
        consensusBrier:
          r.consensus_brier === null ? null : Number(r.consensus_brier),
      };
    },
    async unscoredWindows(marketId) {
      const { rows } = await pool.query<{
        window_id: string;
        deadline: Date;
        forecaster: string;
        probability_bps: number;
        withdrawn: boolean;
      }>(
        `SELECT f.window_id,f.deadline,f.forecaster,f.probability_bps,f.withdrawn
         FROM analytics.closed_forecasts f
         WHERE f.deployment_id=$1 AND f.market_id=$2
           AND NOT EXISTS(SELECT 1 FROM analytics.score_entries e
                          JOIN protocol.market_reads m USING(deployment_id,market_id)
                          WHERE e.window_id=f.window_id AND e.evaluation_version='v2'
                            AND m.state='FINAL' AND e.outcome=m.final_outcome
                            AND e.mode=m.mode)
         ORDER BY f.deadline,f.window_id,f.forecaster`,
        [deploymentId, marketId],
      );
      const windows = new Map<
        string,
        { windowId: string; deadline: Date; forecasts: EvaluationForecast[] }
      >();
      for (const r of rows) {
        let window = windows.get(r.window_id);
        if (!window) {
          window = {
            windowId: r.window_id,
            deadline: new Date(r.deadline),
            forecasts: [],
          };
          windows.set(r.window_id, window);
        }
        window.forecasts.push({
          forecaster: r.forecaster,
          probabilityBps: r.probability_bps,
          withdrawn: r.withdrawn,
        });
      }
      return [...windows.values()];
    },
    creditStats: (forecasters, at) => queryCreditStats(pool, forecasters, at),
    async saveScores(entries) {
      if (!entries.length) return;
      await uow.run(async (tx) => {
        const db = uow.client(tx);
        for (const s of entries) {
          const x = s.probabilityMillionthsTimes2;
          await db.query(
            `INSERT INTO analytics.score_entries
              (id,deployment_id,market_id,window_id,mode,scorer,forecaster,probability_millionths,probability_millionths_times2,outcome,brier,missing,contaminated,evaluation_version)
              VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::text IS NULL THEN NULL ELSE decode($7,'hex') END,$8,$9,$10,$11,$12,$13,$14)
              ON CONFLICT DO NOTHING`,
            [
              randomUUID(),
              s.deploymentId,
              s.marketId,
              s.windowId,
              s.mode,
              s.scorer,
              s.forecaster === null ? null : hex(s.forecaster),
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
      });
    },
  };
}
