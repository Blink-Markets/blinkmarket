import { randomUUID } from "node:crypto";
import { keccak256, stringToHex } from "viem";
import type { Pool, PoolClient } from "pg";
import {
  canonicalJson,
  mandateAdmission,
  SIGNING_POLICY_VERSION,
  type Hex,
  type MandateRefusal,
  type QuoteStatus,
  type TraderContext,
  type TraderIntentFact,
  type TraderMandate,
  type TraderMarketView,
  type TraderReservation,
  type TraderRole,
  type TraderStore,
  type TraderTrade,
  type TradingCursor,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import { indexerStaleSql } from "./market-read-store.js";
import { signingIntentWriter } from "./signing-store.js";

type Row = Record<string, any>;
const hex = (value: unknown) => String(value).replace(/^0x/i, "");
const big = (value: unknown) => BigInt(String(value));
const bigOrNull = (value: unknown) =>
  value === null || value === undefined ? null : big(value);

const mandateOf = (row: Row): TraderMandate => ({
  agentId: String(row.agent_id),
  wallet: ("0x" + row.wallet) as Hex,
  forecasterRole: row.forecaster_role as TraderRole,
  dailyNotionalCapMicros: big(row.daily_notional_cap_micros),
  openNotionalCapMicros: big(row.open_notional_cap_micros),
  maxFillShares: Number(row.max_fill_shares),
  sharesPerTrade: Number(row.shares_per_trade),
  edgeThresholdBps: Number(row.edge_threshold_bps),
  enabled: row.enabled === true,
  policyVersion: String(row.policy_version),
});
const mandateColumns = `agent_id, encode(wallet,'hex') AS wallet, forecaster_role, daily_notional_cap_micros::text,
  open_notional_cap_micros::text, max_fill_shares, shares_per_trade, edge_threshold_bps, enabled, policy_version`;

// The newest attempt of an intent that a block holds: its receipt says whether the call took effect.
const minedOf = (intent: string) =>
  `(SELECT t.receipt_status FROM signing.tx_attempts t WHERE t.intent_id=${intent}.id
    AND t.status IN ('INCLUDED','FINALIZED','REVERTED') ORDER BY t.created_at DESC, t.id DESC LIMIT 1)`;
const intentFactOf = (row: Row, prefix: string): TraderIntentFact | null =>
  row[prefix + "_id"] === null || row[prefix + "_id"] === undefined
    ? null
    : {
        intentId: String(row[prefix + "_id"]),
        state: row[prefix + "_state"],
        mined:
          (row[prefix + "_mined"] as "success" | "reverted" | null) ?? null,
      };

const tradeColumns = `r.id, r.agent_id, r.intent_id, r.day::text AS day, r.notional_micros::text AS notional_micros,
  r.state, r.deployment_id, r.market_id::text AS market_id, r.window_id, r.side, r.shares, r.ask_bps,
  r.own_probability_millionths, floor(extract(epoch from blink.now()-r.created_at))::int AS age_seconds,
  encode(q.digest,'hex') AS quote_digest, q.status AS quote_status, q.expires_at::text AS quote_expires_at,
  q.epoch::text AS quote_epoch, q.envelope AS quote_envelope,
  d.state AS digest_state, ms.epoch::text AS maker_epoch,
  ai.id AS approve_id, ai.state AS approve_state, ${minedOf("ai")} AS approve_mined,
  fi.id AS fill_id, fi.state AS fill_state, ${minedOf("fi")} AS fill_mined,
  c.block_number::text AS c_block_number, encode(c.block_hash,'hex') AS c_block_hash,
  c.block_timestamp::text AS c_block_timestamp, c.head_number::text AS c_head_number,
  c.finalized_number::text AS c_finalized_number, c.gate_reason AS c_gate_reason,
  (${indexerStaleSql("c")}) AS c_stale`;
// One statement, so the digest, the cursor and the transactions are all read at one snapshot.
const tradeJoins = `FROM trading.risk_reservations r
  LEFT JOIN trading.quotes q ON q.agent_id=r.agent_id AND q.idempotency_key='trader-'||r.intent_id::text
  LEFT JOIN chain.quote_digests d ON d.deployment_id=r.deployment_id AND d.digest=q.digest
  LEFT JOIN chain.maker_state ms ON ms.deployment_id=r.deployment_id
  LEFT JOIN chain.cursors c ON c.deployment_id=r.deployment_id
  LEFT JOIN signing.economic_intents ai ON ai.dedupe_key='trader:approve:'||r.intent_id::text
  LEFT JOIN signing.economic_intents fi ON fi.dedupe_key='trader:fill:'||r.intent_id::text`;
const reservationOf = (row: Row): TraderReservation => ({
  id: String(row.id),
  agentId: String(row.agent_id),
  intentId: String(row.intent_id),
  day: String(row.day),
  notionalMicros: big(row.notional_micros),
  state: row.state,
  deploymentId: String(row.deployment_id),
  marketId: String(row.market_id),
  windowId: String(row.window_id),
  side: row.side,
  shares: Number(row.shares),
  askBps: Number(row.ask_bps),
  ownProbabilityMillionths: Number(row.own_probability_millionths),
  ageSeconds: Number(row.age_seconds),
});
const tradeOf = (row: Row): TraderTrade => ({
  reservation: reservationOf(row),
  quote:
    row.quote_digest === null
      ? null
      : {
          digest: ("0x" + row.quote_digest) as Hex,
          status: row.quote_status as QuoteStatus,
          expiresAt: big(row.quote_expires_at),
          epoch: big(row.quote_epoch),
          envelope:
            (row.quote_envelope as Record<string, unknown> | null) ?? null,
        },
  digest: (row.digest_state as "FILLED" | "CANCELLED" | null) ?? null,
  makerEpoch: bigOrNull(row.maker_epoch),
  approve: intentFactOf(row, "approve"),
  fill: intentFactOf(row, "fill"),
  cursor:
    row.c_block_number === null
      ? null
      : {
          blockNumber: big(row.c_block_number),
          blockHash: ("0x" + row.c_block_hash) as Hex,
          blockTimestamp: big(row.c_block_timestamp),
          headNumber: big(row.c_head_number),
          finalizedNumber: bigOrNull(row.c_finalized_number),
          gateReason: (row.c_gate_reason as string | null) ?? null,
          stale: row.c_stale === true,
        },
});

export function postgresTraderStore(pool: Pool): TraderStore {
  const uow = createUnitOfWork(pool);
  const writer = signingIntentWriter();
  // The mandate's lock. The worker holds no UPDATE on mandates, so the row cannot be the lock; a
  // transaction advisory lock keyed by the agent serializes everything that spends its limits.
  const lockMandate = (db: PoolClient, agentId: string) =>
    db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('blink-trader:'||$1::text,0))",
      [agentId],
    );
  const audit = (
    db: Pick<PoolClient, "query">,
    input: { action: string; resource: string; reason: string },
  ) =>
    db.query(
      `INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id)
      SELECT $1,'trader',$2,$3,$4,$3
      WHERE NOT EXISTS (SELECT 1 FROM operations.audit_log WHERE action=$2 AND resource=$3 AND reason=$4)`,
      [randomUUID(), input.action, input.resource, input.reason],
    );
  const fact = async (db: Pick<PoolClient, "query">, intentId: string) => {
    const { rows } = await db.query(
      `SELECT i.id AS f_id, i.state AS f_state, ${minedOf("i")} AS f_mined
      FROM signing.economic_intents i WHERE i.id=$1`,
      [intentId],
    );
    return rows[0] ? intentFactOf(rows[0], "f") : null;
  };
  const transition = (
    id: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<void> =>
    uow.run(async (ctx) => {
      const db = uow.client(ctx);
      const { rows } = await db.query(
        "SELECT agent_id FROM trading.risk_reservations WHERE id=$1",
        [id],
      );
      if (!rows[0]) return;
      await lockMandate(db, String(rows[0].agent_id));
      await db.query(sql, [id, ...params]);
    });
  // Takes the mandate's lock, then reads: the reservation is HELD and the mandate is on. Release
  // takes the same lock, so what this returns is true at the moment it returns and, for every
  // release that exists, stays true until the caller's next step.
  const permitted = async (db: PoolClient, reservationId: string) => {
    const owner = await db.query(
      "SELECT agent_id FROM trading.risk_reservations WHERE id=$1",
      [reservationId],
    );
    if (!owner.rows[0]) return false;
    await lockMandate(db, String(owner.rows[0].agent_id));
    const { rows } = await db.query(
      `SELECT r.state='HELD' AS held, m.enabled FROM trading.risk_reservations r
      JOIN trading.mandates m ON m.agent_id=r.agent_id WHERE r.id=$1`,
      [reservationId],
    );
    return rows[0]?.held === true && rows[0]?.enabled === true;
  };

  return {
    async mandate(role) {
      const { rows } = await pool.query(
        `SELECT ${mandateColumns} FROM trading.mandates WHERE forecaster_role=$1 ORDER BY agent_id LIMIT 2`,
        [role],
      );
      if (rows.length > 1) throw new Error("TRADER_MANDATE_AMBIGUOUS");
      return rows[0] ? mandateOf(rows[0]) : null;
    },

    async context({ deploymentId, mandate }): Promise<TraderContext> {
      const one = async (sql: string, params: unknown[]) =>
        (await pool.query(sql, params)).rows[0] as Row | undefined;
      const deployment = await one(
        "SELECT manifest, enabled FROM markets.deployments WHERE id=$1",
        [deploymentId],
      );
      const cursorRow = await one(
        `SELECT c.block_number::text AS block_number, encode(c.block_hash,'hex') AS block_hash,
          c.block_timestamp::text AS block_timestamp, c.head_number::text AS head_number,
          c.finalized_number::text AS finalized_number, c.gate_reason, (${indexerStaleSql("c")}) AS stale
        FROM chain.cursors c WHERE c.deployment_id=$1`,
        [deploymentId],
      );
      const cursor: TradingCursor | null = cursorRow
        ? {
            blockNumber: big(cursorRow.block_number),
            blockHash: ("0x" + cursorRow.block_hash) as Hex,
            blockTimestamp: big(cursorRow.block_timestamp),
            headNumber: big(cursorRow.head_number),
            finalizedNumber: bigOrNull(cursorRow.finalized_number),
            gateReason: (cursorRow.gate_reason as string | null) ?? null,
            stale: cursorRow.stale === true,
          }
        : null;
      const now = await one(
        "SELECT floor(extract(epoch from blink.now()))::text AS now",
        [],
      );
      const maker = await one(
        "SELECT global_paused FROM chain.maker_state WHERE deployment_id=$1",
        [deploymentId],
      );
      const pool_ = await one(
        "SELECT gate_reason FROM trading.maker_pools WHERE deployment_id=$1",
        [deploymentId],
      );
      const taker = await one(
        "SELECT allowed FROM chain.takers WHERE deployment_id=$1 AND account=decode($2,'hex')",
        [deploymentId, hex(mandate.wallet)],
      );
      const markets = (
        await pool.query(
          `SELECT market_id::text AS market_id, encode(spec_hash,'hex') AS spec_hash, state, paused, close_at::text AS close_at
          FROM chain.markets WHERE deployment_id=$1 AND state<>'FINAL' ORDER BY market_id LIMIT 200`,
          [deploymentId],
        )
      ).rows;
      const gates = (
        await pool.query(
          `SELECT market_id::text AS market_id, reason FROM trading.quote_gates
          WHERE deployment_id=$1 AND reopened_at IS NULL ORDER BY closed_at, id`,
          [deploymentId],
        )
      ).rows;
      // The RFQ's snapshot rule, read-only (the API creates the snapshot row lazily and the worker may
      // not), through the view that shows closed windows only: the worker has no grant on the answers.
      const snapshots = (
        await pool.query(
          `SELECT market_id::text AS market_id, window_id,
            ((a_probability+b_probability)*1000000)::integer AS sum,
            ((CASE WHEN $2='FORECASTER_A' THEN a_probability ELSE b_probability END)*1000000)::integer AS own
          FROM trading.trader_snapshots WHERE deployment_id=$1`,
          [deploymentId, mandate.forecasterRole],
        )
      ).rows;
      const snapshotOf = new Map(
        snapshots.map((s) => [String(s.market_id), s]),
      );
      return {
        deployment: deployment
          ? {
              manifest: deployment.manifest,
              enabled: deployment.enabled === true,
            }
          : null,
        cursor,
        nowSeconds: big(now!.now),
        globalPaused: maker?.global_paused === true,
        poolGate: (pool_?.gate_reason as string | null) ?? null,
        takerAllowed: taker?.allowed === true,
        markets: markets.map((m): TraderMarketView => {
          const snapshot = snapshotOf.get(String(m.market_id));
          return {
            marketId: String(m.market_id),
            specHash: ("0x" + m.spec_hash) as Hex,
            state: m.state,
            paused: m.paused === true,
            closeAt: big(m.close_at),
            gates: gates
              .filter((g) => String(g.market_id) === String(m.market_id))
              .map((g) => String(g.reason)),
            snapshot: snapshot
              ? {
                  windowId: String(snapshot.window_id),
                  probabilitySumMillionths: Number(snapshot.sum),
                  ownProbabilityMillionths: Number(snapshot.own),
                }
              : null,
          };
        }),
      };
    },

    reserve: (input) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        await lockMandate(db, input.mandate.agentId);
        const existing = await db.query(
          "SELECT state FROM trading.risk_reservations WHERE intent_id=$1",
          [input.intentId],
        );
        if (existing.rows[0])
          return { state: "EXISTS", reservationState: existing.rows[0].state };
        // The limits as stored now, not as the caller read them earlier.
        const current = await db.query(
          `SELECT ${mandateColumns} FROM trading.mandates WHERE agent_id=$1`,
          [input.mandate.agentId],
        );
        const mandate = current.rows[0] ? mandateOf(current.rows[0]) : null;
        const refuse = async (reason: MandateRefusal | "MANDATE_DISABLED") => {
          await audit(db, {
            action: "trader.skipped",
            resource: input.intentId,
            reason,
          });
          return { state: "SKIPPED", reason } as const;
        };
        if (!mandate?.enabled) return refuse("MANDATE_DISABLED");
        const { rows } = await db.query(
          `SELECT COALESCE(sum(notional_micros) FILTER (WHERE state IN ('HELD','ACCOUNTED')
              AND day=(blink.now() AT TIME ZONE 'UTC')::date),0)::text AS daily,
            COALESCE(sum(notional_micros) FILTER (WHERE state='HELD'),0)::text AS open
          FROM trading.risk_reservations WHERE agent_id=$1`,
          [mandate.agentId],
        );
        const refusal = mandateAdmission({
          mandate,
          shares: input.shares,
          dailyMicros: big(rows[0].daily),
          openMicros: big(rows[0].open),
        });
        if (refusal) return refuse(refusal);
        const id = randomUUID();
        await db.query(
          `INSERT INTO trading.risk_reservations(id,agent_id,intent_id,day,notional_micros,state,
            deployment_id,market_id,window_id,side,shares,ask_bps,own_probability_millionths)
          VALUES ($1,$2,$3,(blink.now() AT TIME ZONE 'UTC')::date,$4,'HELD',$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            mandate.agentId,
            input.intentId,
            input.shares * 1_000_000,
            input.deploymentId,
            input.marketId,
            input.windowId,
            input.side,
            input.shares,
            input.askBps,
            input.ownProbabilityMillionths,
          ],
        );
        return { state: "RESERVED", reservationId: id };
      }),

    async trades({ agentId, deploymentId }) {
      const { rows } = await pool.query(
        `SELECT ${tradeColumns} ${tradeJoins}
        WHERE r.agent_id=$1 AND r.deployment_id=$2 AND (r.state='HELD' OR (r.state='ACCOUNTED'
          AND NOT COALESCE(d.state='FILLED' AND d.block_number<=c.finalized_number,false)))
        ORDER BY r.created_at, r.id`,
        [agentId, deploymentId],
      );
      return rows.map(tradeOf);
    },
    async trade(intentId) {
      const { rows } = await pool.query(
        `SELECT ${tradeColumns} ${tradeJoins} WHERE r.intent_id=$1`,
        [intentId],
      );
      return rows[0] ? tradeOf(rows[0]) : null;
    },

    release: (id, reason) =>
      transition(
        id,
        "UPDATE trading.risk_reservations SET state='RELEASED',release_reason=$2,updated_at=blink.now() WHERE id=$1 AND state='HELD'",
        [reason.slice(0, 200)],
      ),
    releaseUnspent: (id, reason, { quoteAllowed }) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const owner = await db.query(
          "SELECT agent_id FROM trading.risk_reservations WHERE id=$1",
          [id],
        );
        if (!owner.rows[0]) return false;
        await lockMandate(db, String(owner.rows[0].agent_id));
        const { rows } = await db.query(
          `SELECT r.state='HELD' AS held,
            EXISTS (SELECT 1 FROM trading.quotes q WHERE q.agent_id=r.agent_id
              AND q.idempotency_key='trader-'||r.intent_id::text) AS quoted,
            EXISTS (SELECT 1 FROM signing.economic_intents i
              WHERE i.dedupe_key IN ('trader:approve:'||r.intent_id::text,'trader:fill:'||r.intent_id::text)) AS spent
          FROM trading.risk_reservations r WHERE r.id=$1`,
          [id],
        );
        const row = rows[0];
        if (!row || row.held !== true || row.spent === true) return false;
        if (row.quoted === true && !quoteAllowed) return false;
        await db.query(
          "UPDATE trading.risk_reservations SET state='RELEASED',release_reason=$2,updated_at=blink.now() WHERE id=$1 AND state='HELD'",
          [id, reason.slice(0, 200)],
        );
        return true;
      }),
    setAccounted: (id, accounted) =>
      transition(
        id,
        accounted
          ? "UPDATE trading.risk_reservations SET state='ACCOUNTED',updated_at=blink.now() WHERE id=$1 AND state='HELD'"
          : "UPDATE trading.risk_reservations SET state='HELD',updated_at=blink.now() WHERE id=$1 AND state='ACCOUNTED'",
      ),

    authorize: (reservationId) =>
      uow.run((ctx) => permitted(uow.client(ctx), reservationId)),
    async snapshotWindow(snapshotId) {
      const { rows } = await pool.query(
        "SELECT window_id FROM trading.trader_snapshot_windows WHERE snapshot_id=$1",
        [snapshotId],
      );
      return rows[0] ? String(rows[0].window_id) : null;
    },
    prepare: (input) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        if (
          input.reservationId !== null &&
          !(await permitted(db, input.reservationId))
        )
          return null;
        const { intentId } = await writer.createIntent(db, {
          deploymentId: input.deploymentId,
          kind: input.kind,
          role: "trader",
          dedupeKey: input.dedupeKey,
          payload: input.payload,
          createdBy: "trader",
        });
        await writer.createSignRequest(db, {
          intentId,
          role: "trader",
          unsignedPayload: input.unsignedPayload,
          requestHash: keccak256(
            stringToHex(canonicalJson(input.unsignedPayload)),
          ),
          policyVersion: SIGNING_POLICY_VERSION,
        });
        return { intentId };
      }),
    intent: (intentId) => fact(pool, intentId),

    async redeemable({ deploymentId, wallet }) {
      const { rows } = await pool.query(
        `SELECT m.market_id::text AS market_id, i.id AS f_id, i.state AS f_state, ${minedOf("i")} AS f_mined
        FROM chain.markets m
        JOIN chain.positions p ON p.deployment_id=m.deployment_id AND p.market_id=m.market_id AND p.account=decode($2,'hex')
        LEFT JOIN signing.economic_intents i ON i.dedupe_key='trader:redeem:'||m.deployment_id||':'||m.market_id::text||':'||$2
        WHERE m.deployment_id=$1 AND m.state='FINAL' AND p.yes_shares+p.no_shares>0
        ORDER BY m.market_id`,
        [deploymentId, hex(wallet)],
      );
      return rows.map((row) => ({
        marketId: String(row.market_id),
        intent: intentFactOf(row, "f"),
      }));
    },

    audit: (input) => audit(pool, input).then(() => undefined),
  };
}

export async function assertTraderInstalled(pool: Pool) {
  await pool.query("SELECT agent_id FROM trading.risk_reservations LIMIT 0");
}
