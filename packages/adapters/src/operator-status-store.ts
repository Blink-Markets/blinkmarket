import type { Pool } from "pg";
import type { OperatorStatusStore } from "@blink/ports";
import { AdminPauseState, AdminJobsResponse } from "@blink/schemas";
const LIST_LIMIT = 100;
// Queries fetch one extra row to learn whether more rows matched.
function page<T>(rows: T[]) {
  return {
    items: rows.slice(0, LIST_LIMIT),
    truncated: rows.length > LIST_LIMIT,
  };
}
export function postgresOperatorStatusStore(
  pool: Pool,
  deploymentId: string,
): OperatorStatusStore {
  return {
    async pause() {
      const { rows } = await pool.query(
        `SELECT d.deployment_id AS "deploymentId",s.global_paused AS "globalPaused",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('marketId',m.market_id::text,'paused',m.paused) ORDER BY m.market_id)
        FROM protocol.market_reads m WHERE m.deployment_id=d.deployment_id),'[]'::jsonb) AS markets
        FROM markets.protocol_deployments d LEFT JOIN protocol.maker_reads s ON s.deployment_id=d.deployment_id WHERE d.deployment_id=$1`,
        [deploymentId],
      );
      return AdminPauseState.parse(
        rows[0] ?? { deploymentId, globalPaused: null, markets: [] },
      );
    },
    async jobs(state = "DEAD") {
      const { rows } = await pool.query(
        `SELECT id AS "jobId",state,attempt,max_attempts AS "maxAttempts",created_at AS "createdAt",finished_at AS "finishedAt"
        FROM operations.jobs WHERE state=$1 ORDER BY created_at DESC,id DESC LIMIT ${LIST_LIMIT + 1}`,
        [state],
      );
      const listed = page(rows);
      return AdminJobsResponse.parse({
        ...listed,
        items: listed.items.map((r) => ({
          ...r,
          createdAt: new Date(r.createdAt).toISOString(),
          finishedAt: r.finishedAt
            ? new Date(r.finishedAt).toISOString()
            : null,
        })),
      });
    },
  };
}
