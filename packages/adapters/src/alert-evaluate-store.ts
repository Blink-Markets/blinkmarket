import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  checkGasCaps,
  keeperDueSince,
  type AlertEpisode,
  type AlertEvaluateStore,
  type AlertFamily,
  type AlertObservation,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import {
  DAILY_BUDGET_CLOSED_SQL,
  INDEXER_FRESH_SQL,
  POOL_GATE_CLOSED_SQL,
} from "./health-reader.js";
import { postgresKeeperStore } from "./keeper-store.js";
import { postgresOperatorStatusStore } from "./operator-status-store.js";

const GAS_CAP_CODES: readonly NonNullable<ReturnType<typeof checkGasCaps>>[] = [
  "GAS_CAP_EXCEEDED",
  "GAS_DAILY_CAP_EXCEEDED",
];
const MAX_DEPLOYMENTS = 10;
const MAX_JOB_TYPES = 10;
const code = /^[A-Z0-9_]{1,64}$/;
const jobType = /^[a-z][a-z0-9_.]{0,63}$/;
/** Free text from the database never reaches an alert: anything outside the code format is replaced. */
const reasonOf = (value: unknown, fallback: string) =>
  typeof value === "string" && code.test(value) ? value : fallback;

export function postgresAlertEvaluateStore(pool: Pool): AlertEvaluateStore {
  const uow = createUnitOfWork(pool);
  return {
    async deployments() {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM markets.deployments WHERE enabled ORDER BY id COLLATE "C" LIMIT ${MAX_DEPLOYMENTS}`,
      );
      return rows.map((row) => row.id);
    },
    async observe(deploymentId, { keeperOverdueSeconds }) {
      const found: AlertObservation[] = [];
      const add = (observation: AlertObservation) => found.push(observation);

      // alert.budget: the daily research gate (the same SQL as health BUDGET_GATE_CLOSED).
      const daily = await pool.query<{ reason: string }>(
        `SELECT COALESCE(d.gate_closed_reason,'DAILY_CAP_REACHED') AS reason FROM budgets.daily d
         WHERE d.day=(blink.now() AT TIME ZONE 'UTC')::date AND ${DAILY_BUDGET_CLOSED_SQL} LIMIT 1`,
      );
      if (daily.rows[0])
        add({
          family: "budget",
          subject: "daily",
          reason: reasonOf(daily.rows[0].reason, "DAILY_GATE_CLOSED"),
        });
      const questions = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM budgets.questions WHERE gate_closed_reason IS NOT NULL",
      );
      if (questions.rows[0]!.count !== "0")
        add({
          family: "budget",
          subject: "questions",
          reason: "QUESTION_GATE_CLOSED",
          fields: { count: questions.rows[0]!.count },
        });
      // Signer refusals by the gas caps in the last 24 hours: "over the cap stops and alerts".
      const gas = await pool.query<{
        role: string;
        reason: string;
        count: string;
      }>(
        `SELECT r.role,max(r.reject_code) AS reason,count(*)::text AS count
         FROM signing.sign_requests r JOIN signing.economic_intents i ON i.id=r.intent_id
         WHERE i.deployment_id=$1 AND r.state='REJECTED' AND r.reject_code=ANY($2::text[])
           AND r.updated_at>=blink.now()-interval '24 hours'
         GROUP BY r.role ORDER BY r.role LIMIT 4`,
        [deploymentId, GAS_CAP_CODES],
      );
      for (const row of gas.rows)
        add({
          family: "budget",
          subject: "role:" + row.role,
          reason: reasonOf(row.reason, "GAS_CAP_EXCEEDED"),
          fields: { count: row.count },
        });

      // alert.pause: the indexed pause projection (A3 operator status), then the maker pool gate.
      const pause = await postgresOperatorStatusStore(
        pool,
        deploymentId,
      ).pause();
      if (pause.globalPaused === true)
        add({ family: "pause", subject: "global", reason: "GLOBAL_PAUSED" });
      for (const market of pause.markets)
        if (market.paused)
          add({
            family: "pause",
            subject: "market:" + market.marketId,
            reason: "MARKET_PAUSED",
          });
      const poolGate = await pool.query<{ gate_reason: string }>(
        POOL_GATE_CLOSED_SQL + " LIMIT 1",
        [deploymentId],
      );
      if (poolGate.rows[0])
        add({
          family: "pause",
          subject: "pool",
          reason: reasonOf(poolGate.rows[0].gate_reason, "POOL_GATE_CLOSED"),
        });

      // alert.indexer_lag: the health INDEXER_LAG freshness rule.
      const cursor = (
        await pool.query<{
          block_number: string;
          head_number: string;
          fresh: boolean;
          gate_reason: string | null;
          lagging: boolean;
        }>(
          `SELECT block_number::text,head_number::text,gate_reason,${INDEXER_FRESH_SQL} AS fresh,
             head_number-block_number>3 AS lagging FROM chain.cursors c WHERE deployment_id=$1`,
          [deploymentId],
        )
      ).rows[0];
      if (!cursor)
        add({
          family: "indexer_lag",
          subject: "indexer",
          reason: "CURSOR_MISSING",
        });
      else if (!cursor.fresh)
        add({
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
        });

      // alert.keeper_overdue: due by the keeper's own rule, for longer than the threshold.
      for (const market of await postgresKeeperStore(pool).candidates(
        deploymentId,
      )) {
        const dueSince = keeperDueSince(market);
        if (dueSince === null) continue;
        const overdue = market.nowChain - dueSince;
        if (overdue > BigInt(keeperOverdueSeconds))
          add({
            family: "keeper_overdue",
            subject: "market:" + market.marketId,
            reason: "KEEPER_OVERDUE",
            fields: { overdueSeconds: overdue.toString() },
          });
      }

      // alert.jobs_dead: counts and job types only, never payloads or errors.
      const dead = await pool.query<{ type: string; count: string }>(
        `SELECT type,count(*)::text AS count FROM operations.jobs WHERE state='DEAD'
         GROUP BY type ORDER BY type COLLATE "C" LIMIT ${MAX_JOB_TYPES}`,
      );
      if (dead.rows.length)
        add({
          family: "jobs_dead",
          subject: "jobs",
          reason: "DEAD_JOBS",
          fields: {
            count: dead.rows
              .reduce((sum, row) => sum + BigInt(row.count), 0n)
              .toString(),
            jobTypes: dead.rows
              .map((row) => row.type)
              .filter((type) => jobType.test(type)),
          },
        });
      return found;
    },
    transition: (deploymentId, families, decide) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        // Two evaluators (or a retried job) serialize here, so one transition is emitted once.
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "alert.evaluate:" + deploymentId,
        ]);
        const now = new Date(
          (await db.query("SELECT blink.now() AS now")).rows[0].now,
        );
        const { rows } = await db.query(
          `SELECT family,subject,active,reason,opened_at,last_alert_at,consecutive_failures
           FROM operations.alert_episodes WHERE deployment_id=$1 AND family=ANY($2::text[])
           ORDER BY family,subject LIMIT 1000`,
          [deploymentId, families],
        );
        const episodes: AlertEpisode[] = rows.map((row) => ({
          family: row.family as AlertFamily,
          subject: row.subject,
          active: row.active,
          reason: row.reason,
          openedAt: row.opened_at && new Date(row.opened_at),
          lastAlertAt: row.last_alert_at && new Date(row.last_alert_at),
          consecutiveFailures: row.consecutive_failures,
        }));
        const changes = decide({ episodes, now });
        for (const change of changes) {
          const saved = await db.query(
            `INSERT INTO operations.alert_episodes(deployment_id,family,subject,active,reason,opened_at,last_alert_at,consecutive_failures,alert_seq)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (deployment_id,family,subject) DO UPDATE SET active=EXCLUDED.active,reason=EXCLUDED.reason,
               opened_at=EXCLUDED.opened_at,last_alert_at=EXCLUDED.last_alert_at,
               consecutive_failures=EXCLUDED.consecutive_failures,
               alert_seq=operations.alert_episodes.alert_seq+$9
             RETURNING alert_seq::text`,
            [
              deploymentId,
              change.family,
              change.subject,
              change.active,
              change.reason,
              change.openedAt,
              change.lastAlertAt,
              change.consecutiveFailures,
              change.emit ? 1 : 0,
            ],
          );
          if (!change.emit) continue;
          await db.query(
            "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,$2,$3,$4,$5)",
            [
              randomUUID(),
              "alert." + change.family,
              JSON.stringify([
                "alert",
                deploymentId,
                change.family,
                change.subject,
              ]),
              saved.rows[0].alert_seq,
              {
                ...change.emit.fields,
                deploymentId,
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
