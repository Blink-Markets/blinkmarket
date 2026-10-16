import type { Pool } from "pg";
import type { OperatorStatusStore } from "@blink/ports";
import {
  AdminCandidatesResponse,
  AdminPauseState,
  AdminResolutionsResponse,
  AdminJobsResponse,
  AdminBudgetsResponse,
} from "@blink/schemas";
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
        `SELECT d.id AS "deploymentId",s.global_paused AS "globalPaused",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('marketId',m.market_id::text,'paused',m.paused) ORDER BY m.market_id)
        FROM chain.markets m WHERE m.deployment_id=d.id),'[]'::jsonb) AS markets
        FROM markets.deployments d LEFT JOIN chain.maker_state s ON s.deployment_id=d.id WHERE d.id=$1`,
        [deploymentId],
      );
      return AdminPauseState.parse(
        rows[0] ?? { deploymentId, globalPaused: null, markets: [] },
      );
    },
    async resolutions(operatorId) {
      const { rows } = await pool.query(
        `SELECT m.market_id::text AS "marketId",m.state,m.close_at::text AS "closeAt",
        m.proposal_deadline::text AS "proposalDeadline",m.hard_deadline::text AS "hardDeadline",
        (m.proposed_at+m.challenge_seconds)::text AS "challengeEndsAt",
        (SELECT count(*)::text FROM resolution.reports r WHERE r.deployment_id=m.deployment_id AND r.market_id=m.market_id AND r.operator_id=$2
        AND COALESCE((SELECT e.state FROM resolution.report_events e WHERE e.report_id=r.id ORDER BY e.sequence DESC LIMIT 1),'RECEIVED') IN ('RECEIVED','TRIAGED')) AS "openReports"
        FROM chain.markets m WHERE m.deployment_id=$1 AND (m.state IN ('PROPOSED','DISPUTED') OR (m.state='OPEN' AND m.close_at<=extract(epoch FROM blink.now())))
        ORDER BY m.market_id DESC LIMIT ${LIST_LIMIT + 1}`,
        [deploymentId, operatorId],
      );
      return AdminResolutionsResponse.parse(page(rows));
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
    async budgets() {
      const { rows } =
        await pool.query(`SELECT (blink.now() AT TIME ZONE 'UTC')::date::text AS day,
        COALESCE((SELECT cap_usd_micros FROM budgets.daily WHERE day=(blink.now() AT TIME ZONE 'UTC')::date),20000000)::text AS "capUsdMicros",
        COALESCE(SUM(actual_usd_micros) FILTER (WHERE state='RECONCILED'),0)::text AS "spentUsdMicros",
        COALESCE(SUM(max_usd_micros) FILTER (WHERE state='RESERVED'),0)::text AS "reservedUsdMicros",
        COALESCE(SUM(max_usd_micros) FILTER (WHERE state='UNKNOWN'),0)::text AS "unknownUsdMicros"
        FROM budgets.reservations WHERE day=(blink.now() AT TIME ZONE 'UTC')::date`);
      return AdminBudgetsResponse.parse({ daily: rows[0] });
    },
    async candidates(operatorId, status) {
      const { rows } = await pool.query(
        `SELECT c.id AS "candidateId",c.current_revision AS revision,r.snapshot->>'state' AS status,
        CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('approvalId',a.id,'deploymentId',a.deployment_id,
        'budgetMicros',a.budget_micros::text,'creationIntentId',i.id,'state',i.state) END AS approval
        FROM discovery.candidates c JOIN discovery.candidate_revisions r ON r.candidate_id=c.id AND r.revision=c.current_revision
        LEFT JOIN LATERAL (SELECT id,deployment_id,budget_micros FROM markets.approvals WHERE candidate_id=c.id ORDER BY revision DESC LIMIT 1) a ON true
        LEFT JOIN markets.creation_intents i ON i.approval_id=a.id
        WHERE c.operator_id=$1 AND ($2::text IS NULL OR r.snapshot->>'state'=$2) ORDER BY c.created_at DESC,c.id DESC LIMIT ${LIST_LIMIT + 1}`,
        [operatorId, status ?? null],
      );
      return AdminCandidatesResponse.parse(page(rows));
    },
  };
}
