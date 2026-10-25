import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ForecastStore,
  ForecastWindow,
  ForecasterStats,
  StoredForecast,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";

const windowColumns = `id,market_id::text AS "marketId",horizon_type AS "horizonType",scheduled_at AS "scheduledAt",open_at AS "openAt",deadline,
  CASE WHEN merkle_root IS NULL THEN NULL ELSE '0x'||encode(merkle_root,'hex') END AS "merkleRoot",root_at AS "rootAt"`;
const toWindow = (w: ForecastWindow): ForecastWindow => ({
  ...w,
  scheduledAt: new Date(w.scheduledAt),
  openAt: new Date(w.openAt),
  deadline: new Date(w.deadline),
  rootAt: w.rootAt ? new Date(w.rootAt) : null,
});
const submissionColumns = `s.id AS "submissionId",s.window_id AS "windowId",'0x'||encode(s.forecaster_address,'hex') AS forecaster,
  s.probability_bps AS "probabilityBps",'0x'||encode(s.content_hash,'hex') AS "contentHash",'0x'||encode(s.digest,'hex') AS digest,
  s.signature,s.verified_block::text AS "verifiedBlock",s.received_at AS "receivedAt",
  (SELECT min(a.created_at) FROM forecasts.annotations a WHERE a.submission_id=s.id AND a.kind='WITHDRAWN') AS "withdrawnAt"`;
type SubmissionRow = Omit<StoredForecast, "verifiedBlock" | "receivedAt" | "withdrawnAt"> & {
  verifiedBlock: string;
  receivedAt: Date;
  withdrawnAt: Date | null;
};
const toSubmission = (r: SubmissionRow): StoredForecast => ({
  ...r,
  verifiedBlock: Number(r.verifiedBlock),
  receivedAt: new Date(r.receivedAt),
  withdrawnAt: r.withdrawnAt ? new Date(r.withdrawnAt) : null,
});
const hex = (value: string) => value.slice(2).toLowerCase();

/** At most this many scored submissions count toward a forecaster's credit. */
const CREDIT_WINDOW = 50;

/**
 * Credit stats from the latest 50 scored LIVE AGENT submissions per forecaster: not withdrawn, not
 * contaminated, with a Brier score. With `at`, only scores recorded by then count. Shared by the API
 * (forecaster reads) and the worker (frozen consensus weights).
 */
export async function queryCreditStats(
  db: Pick<PoolClient, "query">,
  forecasters: string[] | null,
  at: Date | null,
): Promise<ForecasterStats[]> {
  const { rows } = await db.query<{ address: string; n: number; brier_sum: string | null }>(
    `WITH who AS (
       SELECT DISTINCT forecaster_address AS f FROM forecasts.submissions
       WHERE forecaster_address IS NOT NULL
         AND ($1::text[] IS NULL OR encode(forecaster_address,'hex')=ANY($1::text[]))
     ), scored AS (
       SELECT e.forecaster AS f,e.brier,
         row_number() OVER (PARTITION BY e.forecaster ORDER BY w.deadline DESC,e.window_id DESC) AS rn
       FROM analytics.score_entries e JOIN forecasts.windows w ON w.id=e.window_id
       WHERE e.scorer='AGENT' AND e.evaluation_version='v2' AND e.mode='LIVE'
         AND NOT e.missing AND NOT e.contaminated AND e.brier IS NOT NULL
         AND e.forecaster IN (SELECT f FROM who)
         AND ($2::timestamptz IS NULL OR e.created_at<=$2)
     ), credit AS (
       SELECT f,count(*)::int AS n,sum(brier)::text AS brier_sum FROM scored WHERE rn<=$3 GROUP BY f
     )
     SELECT '0x'||encode(who.f,'hex') AS address,COALESCE(credit.n,0) AS n,credit.brier_sum
     FROM who LEFT JOIN credit ON credit.f=who.f ORDER BY who.f`,
    [forecasters ? forecasters.map(hex) : null, at, CREDIT_WINDOW],
  );
  return rows.map((r) => ({ address: r.address, n: r.n, brierSum: r.brier_sum }));
}

export function postgresForecastStore(
  pool: Pool,
  deploymentId: string,
): ForecastStore {
  const uow = createUnitOfWork(pool);
  const tx = <T>(work: (db: PoolClient) => Promise<T>) =>
    uow.run((ctx) => work(uow.client(ctx)));
  const one = async (sql: string, params: unknown[]) => {
    const { rows } = await pool.query<ForecastWindow>(sql, params);
    return rows[0] ? toWindow(rows[0]) : null;
  };
  return {
    async now() {
      const { rows } = await pool.query("SELECT blink.now() AS now");
      return new Date(rows[0].now);
    },
    async windows(marketId, limit, after) {
      const { rows } = await pool.query<ForecastWindow>(
        `SELECT ${windowColumns} FROM forecasts.windows WHERE deployment_id=$1 AND market_id=$2
         AND ($4::timestamptz IS NULL OR (scheduled_at,horizon_type)>($4::timestamptz,$5::text))
         ORDER BY scheduled_at,horizon_type LIMIT $3`,
        [deploymentId, marketId, limit, after?.scheduledAt ?? null, after?.horizonType ?? null],
      );
      return rows.map(toWindow);
    },
    windowById: (id) =>
      one(`SELECT ${windowColumns} FROM forecasts.windows WHERE id=$1 AND deployment_id=$2`, [
        id,
        deploymentId,
      ]),
    windowFor: (marketId, horizonType, scheduledAt) =>
      one(
        `SELECT ${windowColumns} FROM forecasts.windows
         WHERE deployment_id=$1 AND market_id=$2 AND horizon_type=$3 AND scheduled_at=$4`,
        [deploymentId, marketId, horizonType, scheduledAt],
      ),
    async submissionOf(windowId, forecaster) {
      const { rows } = await pool.query<SubmissionRow>(
        `SELECT ${submissionColumns} FROM forecasts.submissions s
         WHERE s.window_id=$1 AND s.forecaster_address=decode($2,'hex')`,
        [windowId, hex(forecaster)],
      );
      return rows[0] ? toSubmission(rows[0]) : null;
    },
    submit: (input) =>
      tx(async (db) => {
        // The window lock serializes admission with the root: whoever holds it decides, by the
        // database clock, whether the window is still open.
        const locked = await db.query(
          "SELECT id FROM forecasts.windows WHERE id=$1 AND deployment_id=$2 FOR UPDATE",
          [input.windowId, deploymentId],
        );
        if (!locked.rows.length) return { state: "CLOSED" };
        const taken = await db.query(
          "SELECT 1 FROM forecasts.submissions WHERE window_id=$1 AND forecaster_address=decode($2,'hex')",
          [input.windowId, hex(input.forecaster)],
        );
        if (taken.rows.length) return { state: "DUPLICATE" };
        // One precise database timestamp at insertion: neither network or verification delay nor JS
        // millisecond truncation admits a late row.
        const inserted = await db.query<{ received_at: Date }>(
          `WITH stamp AS MATERIALIZED (SELECT blink.now() AS received_at)
           INSERT INTO forecasts.submissions(id,window_id,agent_id,operator_id,key_id,forecaster_address,digest,signature,
             content_hash,verified_block,probability_bps,received_at)
           SELECT $1,w.id,$3,$4,$5,decode($6,'hex'),decode($7,'hex'),$8,decode($9,'hex'),$10,$11,stamp.received_at
           FROM forecasts.windows w CROSS JOIN stamp
           WHERE w.id=$2 AND stamp.received_at>=w.open_at AND stamp.received_at<w.deadline
           RETURNING received_at`,
          [
            input.id,
            input.windowId,
            input.agentId,
            input.operatorId,
            input.keyId,
            hex(input.forecaster),
            hex(input.digest),
            input.signature,
            hex(input.contentHash),
            input.verifiedBlock.toString(),
            input.probabilityBps,
          ],
        );
        if (!inserted.rows[0]) return { state: "CLOSED" };
        await db.query(
          "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES($1,$2,'forecast.submitted',$3,'Immutable signed forecast submission',$4)",
          [randomUUID(), input.keyId, input.id, input.requestId],
        );
        return { state: "ADMITTED", receivedAt: new Date(inserted.rows[0].received_at) };
      }),
    withdraw: (submissionId, forecaster, keyId) =>
      tx(async (db) => {
        const found = await db.query<{ window_id: string }>(
          "SELECT window_id FROM forecasts.submissions WHERE id=$1 AND forecaster_address=decode($2,'hex') AND key_id=$3",
          [submissionId, hex(forecaster), keyId],
        );
        if (!found.rows[0]) return { state: "NOT_FOUND" };
        await db.query("SELECT id FROM forecasts.windows WHERE id=$1 FOR UPDATE", [
          found.rows[0].window_id,
        ]);
        const first = await db.query<{ created_at: Date }>(
          "SELECT min(created_at) AS created_at FROM forecasts.annotations WHERE submission_id=$1 AND kind='WITHDRAWN'",
          [submissionId],
        );
        if (first.rows[0]?.created_at)
          return { state: "WITHDRAWN", withdrawnAt: new Date(first.rows[0].created_at) };
        const stamped = await db.query<{ created_at: Date }>(
          `WITH stamp AS MATERIALIZED (SELECT blink.now() AS at)
           INSERT INTO forecasts.annotations(id,submission_id,kind,reason,actor,created_at)
           SELECT $2,$1,'WITHDRAWN','Withdrawn by the forecaster',$3,stamp.at
           FROM forecasts.windows w CROSS JOIN stamp WHERE w.id=$4 AND stamp.at<w.deadline
           RETURNING created_at`,
          [submissionId, randomUUID(), forecaster, found.rows[0].window_id],
        );
        if (!stamped.rows[0]) return { state: "CLOSED" };
        return { state: "WITHDRAWN", withdrawnAt: new Date(stamped.rows[0].created_at) };
      }),
    async submissions(windowId, forecaster, limit, after) {
      const { rows } = await pool.query<SubmissionRow>(
        `SELECT ${submissionColumns} FROM forecasts.submissions s
         WHERE s.window_id=$1 AND s.forecaster_address IS NOT NULL
           AND ($2::text IS NULL OR s.forecaster_address=decode($2,'hex')) AND ($4::uuid IS NULL OR s.id>$4)
         ORDER BY s.id LIMIT $3`,
        [windowId, forecaster === null ? null : hex(forecaster), limit, after],
      );
      return rows.map(toSubmission);
    },
    async digests(windowId) {
      const { rows } = await pool.query<{ digest: string }>(
        `SELECT '0x'||encode(s.digest,'hex') AS digest FROM forecasts.submissions s
         WHERE s.window_id=$1 AND s.digest IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id AND a.kind='WITHDRAWN')
         ORDER BY s.digest`,
        [windowId],
      );
      return rows.map((r) => r.digest);
    },
    async answers(windowId) {
      const { rows } = await pool.query<{ forecaster: string; probabilityBps: number }>(
        `SELECT '0x'||encode(s.forecaster_address,'hex') AS forecaster,s.probability_bps AS "probabilityBps"
         FROM forecasts.submissions s WHERE s.window_id=$1 AND s.forecaster_address IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM forecasts.annotations a WHERE a.submission_id=s.id AND a.kind='WITHDRAWN')
         ORDER BY s.id`,
        [windowId],
      );
      return rows;
    },
    creditStats: (forecasters, at) => queryCreditStats(pool, forecasters, at),
    async addWindow(w) {
      const result = await pool.query(
        `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
         SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $7::timestamptz>blink.now()
         ON CONFLICT DO NOTHING RETURNING id`,
        [randomUUID(), deploymentId, w.marketId, w.horizonType, w.scheduledAt, w.openAt, w.deadline],
      );
      return result.rows.length > 0;
    },
    async dueWindows(limit) {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM forecasts.windows WHERE deployment_id=$1 AND root_at IS NULL AND deadline<=blink.now()
         ORDER BY deadline,id LIMIT $2`,
        [deploymentId, limit],
      );
      return rows.map((r) => r.id);
    },
    closeWindow: (id, rootOf) =>
      tx(async (db) => {
        // Anyone admitting an answer holds this lock until it commits, so the digests read below
        // are complete: an answer that was admitted before the deadline is in, a later one cannot be.
        const locked = await db.query(
          `SELECT id FROM forecasts.windows WHERE id=$1 AND deployment_id=$2 AND root_at IS NULL
             AND deadline<=blink.now() FOR UPDATE`,
          [id, deploymentId],
        );
        if (!locked.rows.length) return false;
        const { rows } = await db.query<{ digest: string }>(
          // The worker sees digests only through the view of closed windows (never an open window's).
          "SELECT digest FROM forecasts.closed_digests WHERE window_id=$1 AND NOT withdrawn",
          [id],
        );
        const root = rootOf(rows.map((r) => r.digest));
        await db.query(
          "UPDATE forecasts.windows SET merkle_root=CASE WHEN $2::text IS NULL THEN NULL ELSE decode($2,'hex') END,root_at=blink.now() WHERE id=$1",
          [id, root === null ? null : hex(root)],
        );
        return true;
      }),
  };
}
