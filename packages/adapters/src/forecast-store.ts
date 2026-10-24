import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ForecastStore,
  ForecastTransaction,
  ForecastWindow,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import { identityTransaction } from "./identity-store.js";

const windowColumns = `id,deployment_id AS "deploymentId",market_id::text AS "marketId",horizon_type AS "horizonType",scheduled_at AS "scheduledAt",open_at AS "openAt",deadline`;
const dates = (w: ForecastWindow): ForecastWindow => ({
  ...w,
  scheduledAt: new Date(w.scheduledAt),
  openAt: new Date(w.openAt),
  deadline: new Date(w.deadline),
});

export function postgresForecastStore(pool: Pool): ForecastStore {
  const uow = createUnitOfWork(pool);
  return {
    run: (work) => uow.run((ctx) => work(forecastTransaction(uow.client(ctx)))),
  };
}
function forecastTransaction(db: PoolClient): ForecastTransaction {
  return {
    ...identityTransaction(db),
    async now() {
      return new Date(
        (await db.query("SELECT blink.now() AS now")).rows[0].now,
      );
    },
    async windows(deploymentId, marketId, limit, after) {
      const result = await db.query<ForecastWindow>(
        `SELECT ${windowColumns} FROM forecasts.windows WHERE deployment_id=$1 AND market_id=$2 AND ($4::timestamptz IS NULL OR (scheduled_at,horizon_type)>($4::timestamptz,$5::text)) ORDER BY scheduled_at,horizon_type LIMIT $3`,
        [
          deploymentId,
          marketId,
          limit,
          after?.scheduledAt ?? null,
          after?.horizonType ?? null,
        ],
      );
      return result.rows.map(dates);
    },
    async window(deploymentId, marketId, selector, lock) {
      const byId = typeof selector === "string";
      const result = await db.query<ForecastWindow>(
        `SELECT ${windowColumns} FROM forecasts.windows WHERE deployment_id=$1 AND market_id=$2 AND ${byId ? "id=$3" : "horizon_type=$3 AND scheduled_at=$4"} ${lock ? "FOR UPDATE" : ""}`,
        [
          deploymentId,
          marketId,
          ...(byId ? [selector] : [selector.horizonType, selector.scheduledAt]),
        ],
      );
      return result.rows[0] ? dates(result.rows[0]) : null;
    },
    async marketOpen(deploymentId, marketId, now) {
      return (
        (
          await db.query(
            "SELECT 1 FROM chain.markets WHERE deployment_id=$1 AND market_id=$2 AND state='OPEN' AND close_at>extract(epoch from $3::timestamptz)",
            [deploymentId, marketId, now],
          )
        ).rows.length === 1
      );
    },
    async evidenceAllowed(ids, operatorId) {
      const result = await db.query(
        "SELECT id FROM evidence.records WHERE id=ANY($1::uuid[]) AND (access_policy IN ('PUBLIC','EXCERPT') OR operator_id=$2)",
        [ids, operatorId],
      );
      // UUIDs are case-insensitive: count distinct ids the way PostgreSQL does.
      return (
        result.rows.length ===
        new Set(ids.map((id) => id.toLowerCase())).size
      );
    },
    async submitted(windowId, agentId) {
      return (
        (
          await db.query(
            "SELECT 1 FROM forecasts.submissions WHERE window_id=$1 AND agent_id=$2",
            [windowId, agentId],
          )
        ).rows.length > 0
      );
    },
    async submit(id, window, principal, input) {
      // The window lock is already held. Capture one precise DB timestamp at insertion,
      // so neither network/validation delay nor JS millisecond truncation admits a late row.
      const result = await db.query(
        `WITH stamp AS MATERIALIZED (SELECT blink.now() AS received_at)
    INSERT INTO forecasts.submissions(id,window_id,agent_id,operator_id,key_id,probability,evidence_ids,rationale,agent_version,received_at)
    SELECT $1,w.id,$3,$4,$5,$6,$7,$8,$9,stamp.received_at FROM forecasts.windows w CROSS JOIN stamp
    WHERE w.id=$2 AND stamp.received_at>=w.open_at AND stamp.received_at<w.deadline
    RETURNING received_at`,
        [
          id,
          window.id,
          principal.agentId,
          principal.operatorId,
          principal.keyId,
          input.probability,
          input.evidenceIds,
          input.rationale,
          input.agentVersion,
        ],
      );
      return result.rows[0] ? new Date(result.rows[0].received_at) : null;
    },
    async auditForecast(actor, submissionId, requestId) {
      await db.query(
        "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES($1,$2,'forecast.submitted',$3,'Immutable forecast submission',$4)",
        [randomUUID(), actor, submissionId, requestId],
      );
    },
    async submissions(windowId, agentId, limit, after) {
      const result = await db.query(
        `SELECT s.id AS "submissionId",agent_id AS "agentId",window_id AS "windowId",probability::float8 AS probability,
    received_at AS "receivedAt",evidence_ids AS "evidenceIds",rationale,agent_version AS "agentVersion",
    (SELECT min(created_at) FROM forecasts.annotations a WHERE a.submission_id=s.id AND kind='WITHDRAWN') AS "withdrawnAt",
    EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id AND kind IN ('OUTCOME_ALREADY_PUBLIC','WINDOW_CONTAMINATED')) AS contaminated
    FROM forecasts.submissions s WHERE window_id=$1 AND ($2::uuid IS NULL OR agent_id=$2) AND ($4::uuid IS NULL OR s.id>$4)
    ORDER BY s.id LIMIT $3`,
        [windowId, agentId, limit, after],
      );
      return result.rows.map((r) => ({
        ...r,
        receivedAt: new Date(r.receivedAt).toISOString(),
        withdrawnAt: r.withdrawnAt
          ? new Date(r.withdrawnAt).toISOString()
          : null,
      }));
    },
    async openMarkets() {
      const result = await db.query(
        `SELECT deployment_id AS "deploymentId",market_id::text AS "marketId",to_timestamp(close_at::double precision) AS "closeAt" FROM chain.markets WHERE state='OPEN' AND close_at>extract(epoch from blink.now())`,
      );
      return result.rows.map((r) => ({
        deploymentId: String(r.deploymentId),
        marketId: String(r.marketId),
        closeAt: new Date(r.closeAt),
      }));
    },
    async addWindow(w) {
      const result = await db.query(
        `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $7::timestamptz>blink.now()
    ON CONFLICT DO NOTHING RETURNING id`,
        [
          randomUUID(),
          w.deploymentId,
          w.marketId,
          w.horizonType,
          w.scheduledAt,
          w.openAt,
          w.deadline,
        ],
      );
      return result.rows.length > 0;
    },
  };
}
