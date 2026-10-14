import type { Pool } from "pg";
import type { EvidenceDocument, PlatformRunStore } from "@blink/ports";

// Runs as blink_worker. It reads windows, platform agents, approvals' budget columns and evidence,
// and writes model runs. It has no grant on forecasts.submissions or forecasts.snapshots.
export function postgresPlatformRunStore(pool: Pool): PlatformRunStore {
  const evidenceColumns = `id,object_uri,'0x'||encode(content_hash,'hex') AS content_hash`;
  const document = (row: Record<string, unknown>): EvidenceDocument => ({
    evidenceId: String(row.id),
    objectUri: String(row.object_uri),
    contentHash: String(row.content_hash),
  });
  return {
    async platformAgent(role) {
      const { rows } = await pool.query(
        `SELECT agent_id,model,'0x'||encode(prompt_hash,'hex') AS prompt_hash
         FROM forecasts.platform_agents WHERE role=$1`,
        [role],
      );
      const row = rows[0];
      return row
        ? {
            agentId: String(row.agent_id),
            model: String(row.model),
            promptHash: String(row.prompt_hash),
          }
        : null;
    },
    async window(windowId) {
      const { rows } = await pool.query(
        `WITH stamp AS MATERIALIZED (SELECT blink.now() AS now)
         SELECT w.id,w.deployment_id,w.market_id::text AS market_id,w.horizon_type,
                w.scheduled_at,w.open_at,w.deadline,m.mode,stamp.now,
                a.candidate_id,a.budget_micros::text AS budget_micros
         FROM forecasts.windows w CROSS JOIN stamp
         JOIN chain.markets m ON m.deployment_id=w.deployment_id AND m.market_id=w.market_id
         LEFT JOIN LATERAL (
           SELECT candidate_id,budget_micros FROM markets.approvals a
           WHERE a.deployment_id=w.deployment_id AND a.spec_hash=m.spec_hash
           ORDER BY a.created_at LIMIT 1
         ) a ON true
         WHERE w.id=$1::uuid`,
        [windowId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        windowId: String(row.id),
        deploymentId: String(row.deployment_id),
        marketId: String(row.market_id),
        mode: row.mode,
        horizonType: row.horizon_type,
        scheduledAt: new Date(row.scheduled_at),
        openAt: new Date(row.open_at),
        deadline: new Date(row.deadline),
        now: new Date(row.now),
        approval: row.candidate_id
          ? {
              candidateId: String(row.candidate_id),
              budgetMicros: BigInt(row.budget_micros),
            }
          : null,
      };
    },
    async openWindows() {
      const { rows } = await pool.query(
        `WITH stamp AS MATERIALIZED (SELECT blink.now() AS now)
         SELECT w.id FROM forecasts.windows w CROSS JOIN stamp
         JOIN chain.markets m ON m.deployment_id=w.deployment_id AND m.market_id=w.market_id
         WHERE m.state='OPEN' AND m.close_at>extract(epoch from stamp.now)
           AND stamp.now>=w.open_at AND stamp.now<w.deadline
         ORDER BY w.deadline,w.id`,
      );
      return rows.map((row) => String(row.id));
    },
    async settled(agentId, windowId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM forecasts.model_runs
         WHERE agent_id=$1 AND window_id=$2 AND state IN ('SUBMITTED','LATE') LIMIT 1`,
        [agentId, windowId],
      );
      return rows.length > 0;
    },
    async evidence(ids, cutoff) {
      const { rows } = await pool.query(
        `SELECT ${evidenceColumns} FROM evidence.records
         WHERE id=ANY($1::uuid[]) AND observed_at<=$2::timestamptz
         ORDER BY observed_at,id`,
        [ids, cutoff.toISOString()],
      );
      return rows.map(document);
    },
    async startRun(input) {
      await pool.query(
        `INSERT INTO forecasts.model_runs
           (id,agent_id,window_id,purpose,model,prompt_hash,sampling,tool_policy,input_hash,data_cutoff,state)
         VALUES ($1,$2,$3,$4,$5,decode($6,'hex'),$7,$8,decode($9,'hex'),$10,'STARTED')`,
        [
          input.id,
          input.agentId,
          input.windowId,
          input.purpose,
          input.model,
          input.promptHash.slice(2),
          input.sampling,
          input.toolPolicy,
          input.inputHash.slice(2),
          input.dataCutoff.toISOString(),
        ],
      );
    },
    async updateRun(id, update) {
      // Only the columns being set are named: the worker may not read the others.
      const values: unknown[] = [id, update.state];
      const sets = ["state=$2", "updated_at=blink.now()"];
      for (const [column, value] of [
        ["reservation_id", update.reservationId],
        ["provider_request_id", update.providerRequestId],
        ["submission_id", update.submissionId],
      ] as const)
        if (value !== undefined) {
          values.push(value);
          sets.push(`${column}=$${values.length}`);
        }
      await pool.query(
        `UPDATE forecasts.model_runs SET ${sets.join(",")} WHERE id=$1`,
        values,
      );
    },
  };
}
