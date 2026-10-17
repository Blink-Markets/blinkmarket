import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  checkGasCaps,
  keeperDueSince,
  GLOBAL_ALERT_SCOPE,
  type AlertEpisode,
  type AlertEvaluateStore,
  type AlertFamily,
  type AlertObservation,
  type AlertObserved,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import {
  DAILY_BUDGET_CLOSED_SQL,
  INDEXER_FRESH_SQL,
  INDEXER_LAGGING_SQL,
  POOL_GATE_CLOSED_SQL,
  QUESTION_GATES_CLOSED_SQL,
} from "./health-reader.js";
import { postgresKeeperStore } from "./keeper-store.js";
import { postgresOperatorStatusStore } from "./operator-status-store.js";

// Every gas-cap refusal code; a code added to checkGasCaps fails to compile until it is listed here.
const GAS_CAP_CODES: Record<
  NonNullable<ReturnType<typeof checkGasCaps>>,
  true
> = { GAS_CAP_EXCEEDED: true, GAS_DAILY_CAP_EXCEEDED: true };
const MAX_DEPLOYMENTS = 10;
const MAX_JOB_TYPES = 10;
/** Per-market families report at most this many subjects per tick (the rest is flagged truncated). */
export const MAX_SUBJECTS_PER_FAMILY = 100;
const FAMILY_TIMEOUT_MS = 3000;
const PRUNE_BATCH = 100;
const code = /^[A-Z0-9_]{1,64}$/;
const jobType = /^[a-z][a-z0-9_.]{0,63}$/;
/** Free text from the database never reaches an alert: anything outside the code format is replaced. */
const reasonOf = (value: unknown, fallback: string) =>
  typeof value === "string" && code.test(value) ? value : fallback;
const byMarketId = (a: string, b: string) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

type FamilyResult = { observations: AlertObservation[]; truncated?: boolean };

export function postgresAlertEvaluateStore(
  pool: Pool,
  options: {
    onError?: ((code: string) => void) | undefined;
    /** Set false for a single-connection test pool, where a held lock connection would deadlock. */
    jobLock?: boolean | undefined;
  } = {},
): AlertEvaluateStore {
  const uow = createUnitOfWork(pool);
  /** One family's reads in a transaction with its own statement timeout. */
  async function bounded<T>(run: (db: Pool) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      // One snapshot per family: the cursor check and the reads that depend on it agree.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${FAMILY_TIMEOUT_MS}`);
      const result = await run(client as unknown as Pool);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  /** The keeper acts, and the projection is trustworthy, only on a readable, ungated cursor. */
  const cursorReadable = async (db: Pool, deploymentId: string) =>
    (
      await db.query<{ ok: boolean }>(
        `SELECT c.gate_reason IS NULL AND d.enabled AS ok FROM chain.cursors c
         JOIN markets.deployments d ON d.id=c.deployment_id WHERE c.deployment_id=$1`,
        [deploymentId],
      )
    ).rows[0]?.ok === true;

  const families = {
    // Global: today's daily gate (the health SQL) and closed question gates.
    async budgetGlobal(db: Pool): Promise<FamilyResult> {
      const found: AlertObservation[] = [];
      const daily = await db.query<{ reason: string }>(
        `SELECT COALESCE(d.gate_closed_reason,'DAILY_CAP_REACHED') AS reason FROM budgets.daily d
         WHERE ${DAILY_BUDGET_CLOSED_SQL} LIMIT 1`,
      );
      if (daily.rows[0])
        found.push({
          family: "budget",
          subject: "daily",
          reason: reasonOf(daily.rows[0].reason, "DAILY_GATE_CLOSED"),
        });
      const questions = (
        await db.query<{ count: string }>(QUESTION_GATES_CLOSED_SQL)
      ).rows[0]!.count;
      if (questions !== "0")
        found.push({
          family: "budget",
          subject: "questions",
          reason: "QUESTION_GATE_CLOSED",
          fields: { count: questions },
          monotonic: true,
        });
      return { observations: found };
    },
    // Signer refusals by the gas caps in the last 24 hours: "over the cap stops and alerts".
    async budgetDeployment(
      db: Pool,
      deploymentId: string,
    ): Promise<FamilyResult> {
      const gas = await db.query<{
        role: string;
        reason: string;
        count: string;
      }>(
        `SELECT r.role,max(r.reject_code) AS reason,count(*)::text AS count
         FROM signing.sign_requests r JOIN signing.economic_intents i ON i.id=r.intent_id
         WHERE i.deployment_id=$1 AND r.state='REJECTED' AND r.reject_code=ANY($2::text[])
           AND r.updated_at>=blink.now()-interval '24 hours'
         GROUP BY r.role ORDER BY r.role LIMIT 4`,
        [deploymentId, Object.keys(GAS_CAP_CODES)],
      );
      return {
        observations: gas.rows.map((row) => ({
          family: "budget",
          subject: "role:" + row.role,
          reason: reasonOf(row.reason, "GAS_CAP_EXCEEDED"),
          fields: { count: row.count },
        })),
      };
    },
    // The indexed pause projection (A3 operator status) for markets still open to trading.
    // Unknown while the cursor is gated or missing.
    async pauseProjection(
      db: Pool,
      deploymentId: string,
    ): Promise<FamilyResult | null> {
      if (!(await cursorReadable(db, deploymentId))) return null;
      const found: AlertObservation[] = [];
      const projection = await postgresOperatorStatusStore(
        db,
        deploymentId,
      ).pause();
      if (projection.globalPaused === true)
        found.push({
          family: "pause",
          subject: "global",
          reason: "GLOBAL_PAUSED",
        });
      const paused = projection.markets
        .filter((market) => market.paused)
        .map((market) => market.marketId);
      let live: string[] = [];
      if (paused.length)
        // A resolved market stays flagged paused until an admin unpauses it; it is no longer an incident.
        live = (
          await db.query<{ id: string }>(
            `SELECT market_id::text AS id FROM chain.markets
             WHERE deployment_id=$1 AND state<>'FINAL' AND market_id::text=ANY($2::text[])`,
            [deploymentId, paused],
          )
        ).rows
          .map((row) => row.id)
          .sort(byMarketId);
      const truncated = live.length > MAX_SUBJECTS_PER_FAMILY;
      for (const id of live.slice(0, MAX_SUBJECTS_PER_FAMILY))
        found.push({
          family: "pause",
          subject: "market:" + id,
          reason: "MARKET_PAUSED",
        });
      return { observations: found, truncated };
    },
    // The maker pool gate is database state, not the chain projection: it is judged even while the
    // cursor is gated (a reorg is when it tends to close).
    async poolGate(db: Pool, deploymentId: string): Promise<FamilyResult> {
      const poolGate = await db.query<{ gate_reason: string }>(
        POOL_GATE_CLOSED_SQL + " LIMIT 1",
        [deploymentId],
      );
      return {
        observations: poolGate.rows[0]
          ? [
              {
                family: "pause",
                subject: "pool",
                reason: reasonOf(
                  poolGate.rows[0].gate_reason,
                  "POOL_GATE_CLOSED",
                ),
              },
            ]
          : [],
      };
    },
    // The health INDEXER_LAG freshness rule. A gated or missing cursor is itself the condition.
    async indexerLag(db: Pool, deploymentId: string): Promise<FamilyResult> {
      const cursor = (
        await db.query<{
          block_number: string;
          head_number: string;
          fresh: boolean;
          gate_reason: string | null;
          lagging: boolean;
        }>(
          `SELECT block_number::text,head_number::text,gate_reason,${INDEXER_FRESH_SQL} AS fresh,
             ${INDEXER_LAGGING_SQL} AS lagging FROM chain.cursors c WHERE deployment_id=$1`,
          [deploymentId],
        )
      ).rows[0];
      if (!cursor)
        return {
          observations: [
            {
              family: "indexer_lag",
              subject: "indexer",
              reason: "CURSOR_MISSING",
            },
          ],
        };
      if (cursor.fresh) return { observations: [] };
      return {
        observations: [
          {
            family: "indexer_lag",
            subject: "indexer",
            reason: reasonOf(
              cursor.gate_reason,
              cursor.lagging ? "LAG_BLOCKS" : "STALE_CURSOR",
            ),
            fields: {
              blockNumber: cursor.block_number,
              headNumber: cursor.head_number,
            },
          },
        ],
      };
    },
    // Due by the keeper's own rule for longer than the threshold. Unknown while the keeper could not
    // act on a readable cursor (its candidate query is empty then, which is not "finalized").
    async keeperOverdue(
      db: Pool,
      deploymentId: string,
      keeperOverdueSeconds: number,
    ): Promise<FamilyResult | null> {
      if (!(await cursorReadable(db, deploymentId))) return null;
      const overdue: { id: string; seconds: bigint }[] = [];
      for (const market of await postgresKeeperStore(db).candidates(
        deploymentId,
      )) {
        const dueSince = keeperDueSince(market);
        if (dueSince === null) continue;
        const seconds = market.nowChain - dueSince;
        if (seconds > BigInt(keeperOverdueSeconds))
          overdue.push({ id: market.marketId, seconds });
      }
      overdue.sort((a, b) => byMarketId(a.id, b.id));
      return {
        observations: overdue
          .slice(0, MAX_SUBJECTS_PER_FAMILY)
          .map((market) => ({
            family: "keeper_overdue",
            subject: "market:" + market.id,
            reason: "KEEPER_OVERDUE",
            fields: { overdueSeconds: market.seconds.toString() },
          })),
        truncated: overdue.length > MAX_SUBJECTS_PER_FAMILY,
      };
    },
    // Jobs that went DEAD in the last 24 hours (finished_at: set by the queue when it dead-letters
    // a job). A job left DEAD forever must not hold the episode open, so the window decides.
    async jobsDead(db: Pool): Promise<FamilyResult> {
      const dead = await db.query<{
        type: string;
        total: string;
      }>(
        `SELECT type,sum(count(*)) OVER ()::text AS total FROM operations.jobs
         WHERE state='DEAD' AND finished_at>=blink.now()-interval '24 hours'
         GROUP BY type ORDER BY type COLLATE "C" LIMIT ${MAX_JOB_TYPES}`,
      );
      if (!dead.rows.length) return { observations: [] };
      return {
        observations: [
          {
            family: "jobs_dead",
            subject: "jobs",
            reason: "DEAD_JOBS",
            monotonic: true,
            fields: {
              count: dead.rows[0]!.total,
              jobTypes: dead.rows
                .map((row) => row.type)
                .filter((type) => jobType.test(type)),
            },
          },
        ],
      };
    },
  };

  return {
    async tryLock() {
      if (options.jobLock === false) return { release: async () => {} };
      const client = await pool.connect();
      try {
        const { rows } = await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended('alert.evaluate:job',0)) AS locked",
        );
        if (rows[0].locked !== true) {
          client.release();
          return null;
        }
      } catch (error) {
        client.release();
        throw error;
      }
      return {
        async release() {
          try {
            await client.query(
              "SELECT pg_advisory_unlock(hashtextextended('alert.evaluate:job',0))",
            );
            client.release();
          } catch {
            // The session lock dies with a broken connection.
            client.release(true);
          }
        },
      };
    },
    async deployments() {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM markets.deployments WHERE enabled ORDER BY id COLLATE "C" LIMIT ${MAX_DEPLOYMENTS}`,
      );
      return rows.map((row) => row.id);
    },
    async observe(scope, { keeperOverdueSeconds }) {
      const result: AlertObserved = {
        observations: [],
        unknown: [],
        truncated: [],
      };
      // A family that fails or times out is unknown: it neither opens nor clears anything.
      const attempt = async (
        family: AlertFamily,
        run: (db: Pool) => Promise<FamilyResult | null>,
        covers: (subject: string) => boolean = () => true,
      ) => {
        try {
          const found = await bounded(run);
          if (found === null)
            return void result.unknown.push({ family, covers });
          for (const observation of found.observations)
            result.observations.push(
              found.truncated
                ? {
                    ...observation,
                    fields: { ...observation.fields, truncated: true },
                  }
                : observation,
            );
          if (found.truncated) result.truncated.push(family);
        } catch {
          result.unknown.push({ family, covers });
          options.onError?.("ALERT_EVALUATE_FAMILY_FAILED:" + family);
        }
      };
      if (scope === GLOBAL_ALERT_SCOPE) {
        await attempt("budget", families.budgetGlobal);
        await attempt("jobs_dead", families.jobsDead);
        return result;
      }
      await attempt("budget", (db) => families.budgetDeployment(db, scope));
      await attempt(
        "pause",
        (db) => families.pauseProjection(db, scope),
        (subject) => subject !== "pool",
      );
      await attempt(
        "pause",
        (db) => families.poolGate(db, scope),
        (subject) => subject === "pool",
      );
      await attempt("indexer_lag", (db) => families.indexerLag(db, scope));
      await attempt("keeper_overdue", (db) =>
        families.keeperOverdue(db, scope, keeperOverdueSeconds),
      );
      return result;
    },
    transition: (scope, scopeFamilies, observed, decide) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        // Two evaluators (or a retried job) serialize here, so one transition is emitted once.
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "alert.evaluate:" + scope,
        ]);
        const now = new Date(
          (await db.query("SELECT blink.now() AS now")).rows[0].now,
        );
        // Long-inactive episodes go away, a bounded batch per tick.
        await db.query(
          `DELETE FROM operations.alert_episodes WHERE (deployment_id,family,subject) IN (
             SELECT deployment_id,family,subject FROM operations.alert_episodes
             WHERE deployment_id=$1 AND NOT active AND consecutive_failures=0
               AND last_alert_at<blink.now()-interval '30 days'
             ORDER BY last_alert_at LIMIT ${PRUNE_BATCH})`,
          [scope],
        );
        // Everything decide may need: active episodes, the rpc streak row, the observed subjects.
        const { rows } = await db.query(
          `SELECT family,subject,active,reason,opened_at,last_alert_at,consecutive_failures,last_count::text
           FROM operations.alert_episodes WHERE deployment_id=$1 AND family=ANY($2::text[])
             AND (active OR family='rpc' OR (family,subject) IN (SELECT * FROM unnest($3::text[],$4::text[])))`,
          [
            scope,
            scopeFamilies,
            observed.map((o) => o.family),
            observed.map((o) => o.subject),
          ],
        );
        const episodes: AlertEpisode[] = rows.map((row) => ({
          family: row.family as AlertFamily,
          subject: row.subject,
          active: row.active,
          reason: row.reason,
          openedAt: row.opened_at && new Date(row.opened_at),
          lastAlertAt: row.last_alert_at && new Date(row.last_alert_at),
          consecutiveFailures: row.consecutive_failures,
          lastCount: Number(row.last_count),
        }));
        const changes = decide({ episodes, now });
        for (const change of changes) {
          const saved = await db.query(
            `INSERT INTO operations.alert_episodes(deployment_id,family,subject,active,reason,opened_at,last_alert_at,consecutive_failures,last_count,alert_seq)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (deployment_id,family,subject) DO UPDATE SET active=EXCLUDED.active,reason=EXCLUDED.reason,
               opened_at=EXCLUDED.opened_at,last_alert_at=EXCLUDED.last_alert_at,
               consecutive_failures=EXCLUDED.consecutive_failures,last_count=EXCLUDED.last_count,
               alert_seq=operations.alert_episodes.alert_seq+$10
             RETURNING alert_seq::text`,
            [
              scope,
              change.family,
              change.subject,
              change.active,
              change.reason,
              change.openedAt,
              change.lastAlertAt,
              change.consecutiveFailures,
              change.lastCount,
              change.emit ? 1 : 0,
            ],
          );
          if (!change.emit) continue;
          await db.query(
            "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,$2,$3,$4,$5)",
            [
              randomUUID(),
              "alert." + change.family,
              // The episode's opening time is part of the identity: a pruned subject that recurs
              // can never collide with an older episode's alerts.
              JSON.stringify([
                "alert",
                scope,
                change.family,
                change.subject,
                (change.openedAt ?? now).getTime(),
              ]),
              saved.rows[0].alert_seq,
              {
                ...change.emit.fields,
                ...(scope === GLOBAL_ALERT_SCOPE
                  ? {}
                  : { deploymentId: scope }),
                family: change.family,
                state: change.emit.state,
                subject: change.subject,
                reason: change.reason,
                since: Math.floor(
                  (change.openedAt ?? now).getTime() / 1000,
                ).toString(),
              },
            ],
          );
        }
        return changes;
      }),
  };
}
