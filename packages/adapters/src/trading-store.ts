import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  Hex,
  OpenReservation,
  QuoteRecord,
  QuoteStatus,
  ReservationReader,
  ReservationState,
  SigningSqlClient,
  TradingCursor,
  TradingStore,
  TradingTransaction,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import { identityTransaction } from "./identity-store.js";
import { indexerStaleSql } from "./market-read-store.js";
import { signingIntentWriter } from "./signing-store.js";

type Row = Record<string, unknown>;
const hex = (column: string, alias: string) =>
  `'0x'||encode(${column},'hex') AS ${alias}`;
const bytes = (value: string) => value.replace(/^0x/, "").toLowerCase();
const big = (value: unknown) => BigInt(String(value));
const IN_FLIGHT = `('SIGN_REQUESTED','SIGNED','SIGN_UNKNOWN')`;

const quoteColumns = `q.id, ${hex("q.digest", "digest")}, q.deployment_id, q.market_id::text AS market_id,
  q.operator_id, q.idempotency_key, q.agent_id, q.key_id, ${hex("q.taker", "taker")}, q.side,
  q.quantity::text AS quantity, q.price_bps, q.taker_cost_micros::text AS taker_cost_micros,
  q.maker_cost_micros::text AS maker_cost_micros, q.max_cost_micros::text AS max_cost_micros,
  q.valid_after::text AS valid_after, q.expires_at::text AS expires_at, q.nonce::text AS nonce,
  q.epoch::text AS epoch, ${hex("q.spec_hash", "spec_hash")}, q.forecast_snapshot_id,
  q.sign_request_id, q.snapshot_block_number::text AS snapshot_block_number,
  ${hex("q.snapshot_block_hash", "snapshot_block_hash")}, q.status, q.envelope`;
const quoteOf = (row: Row): QuoteRecord => ({
  id: String(row.id),
  digest: row.digest as Hex,
  deploymentId: String(row.deployment_id),
  marketId: big(row.market_id),
  operatorId: String(row.operator_id),
  idempotencyKey: String(row.idempotency_key),
  agentId: String(row.agent_id),
  keyId: String(row.key_id),
  taker: row.taker as Hex,
  side: row.side as "YES" | "NO",
  quantity: big(row.quantity),
  priceBps: Number(row.price_bps),
  takerCostMicros: big(row.taker_cost_micros),
  makerCostMicros: big(row.maker_cost_micros),
  maxCostMicros: big(row.max_cost_micros),
  validAfter: big(row.valid_after),
  expiresAt: big(row.expires_at),
  nonce: big(row.nonce),
  epoch: big(row.epoch),
  specHash: row.spec_hash as Hex,
  forecastSnapshotId: String(row.forecast_snapshot_id),
  signRequestId: String(row.sign_request_id),
  snapshotBlockNumber: big(row.snapshot_block_number),
  snapshotBlockHash: row.snapshot_block_hash as Hex,
  status: row.status as QuoteStatus,
  envelope: (row.envelope as Record<string, unknown> | null) ?? null,
});

async function appendEvent(
  db: PoolClient,
  event: {
    reservationId: string;
    from: ReservationState | null;
    to: ReservationState;
    blockHash: string | null;
    reason: string;
  },
) {
  await db.query(
    `INSERT INTO trading.reservation_events(id,reservation_id,from_state,to_state,block_hash,reason)
    VALUES($1,$2,$3,$4,CASE WHEN $5::text IS NULL THEN NULL ELSE decode($5::text,'hex') END,$6)`,
    [
      randomUUID(),
      event.reservationId,
      event.from,
      event.to,
      event.blockHash === null ? null : bytes(event.blockHash),
      event.reason,
    ],
  );
}

function tradingTransaction(db: PoolClient): TradingTransaction {
  const writer = signingIntentWriter();
  return {
    ...identityTransaction(db),
    async deployment(deploymentId) {
      const { rows } = await db.query(
        "SELECT manifest, enabled FROM markets.deployments WHERE id=$1",
        [deploymentId],
      );
      return rows[0]
        ? { manifest: rows[0].manifest, enabled: rows[0].enabled === true }
        : null;
    },
    async market(deploymentId, marketId) {
      const { rows } = await db.query(
        `SELECT mode, ${hex("spec_hash", "spec_hash")}, close_at::text AS close_at
        FROM chain.markets WHERE deployment_id=$1 AND market_id=$2`,
        [deploymentId, marketId.toString()],
      );
      const row = rows[0];
      return row
        ? {
            mode: row.mode as "LIVE" | "REPLAY",
            specHash: row.spec_hash as Hex,
            closeAt: big(row.close_at),
          }
        : null;
    },
    async cursor(deploymentId): Promise<TradingCursor | null> {
      const { rows } = await db.query(
        `SELECT c.block_number::text AS block_number, ${hex("c.block_hash", "block_hash")},
          c.block_timestamp::text AS block_timestamp, c.head_number::text AS head_number,
          c.finalized_number::text AS finalized_number, c.gate_reason,
          (${indexerStaleSql("c")}) AS stale
        FROM chain.cursors c WHERE c.deployment_id=$1`,
        [deploymentId],
      );
      const row = rows[0];
      return row
        ? {
            blockNumber: big(row.block_number),
            blockHash: row.block_hash as Hex,
            blockTimestamp: big(row.block_timestamp),
            headNumber: big(row.head_number),
            finalizedNumber:
              row.finalized_number === null ? null : big(row.finalized_number),
            gateReason: (row.gate_reason as string | null) ?? null,
            stale: row.stale === true,
          }
        : null;
    },
    async openGates(deploymentId, marketId) {
      const { rows } = await db.query(
        `SELECT reason FROM trading.quote_gates
        WHERE deployment_id=$1 AND market_id=$2 AND reopened_at IS NULL ORDER BY reason`,
        [deploymentId, marketId.toString()],
      );
      return rows.map((row) => String(row.reason));
    },
    async poolGate(deploymentId) {
      const { rows } = await db.query(
        "SELECT gate_reason FROM trading.maker_pools WHERE deployment_id=$1",
        [deploymentId],
      );
      return (rows[0]?.gate_reason as string | null | undefined) ?? null;
    },
    async lockPool(deploymentId) {
      await db.query(
        "INSERT INTO trading.maker_pools(deployment_id) VALUES($1) ON CONFLICT DO NOTHING",
        [deploymentId],
      );
      const { rows } = await db.query(
        `SELECT gate_reason, version::text AS version FROM trading.maker_pools
        WHERE deployment_id=$1 FOR UPDATE`,
        [deploymentId],
      );
      return {
        gateReason: (rows[0]!.gate_reason as string | null) ?? null,
        version: big(rows[0]!.version),
      };
    },
    async needsReconcile(deploymentId) {
      const { rows } = await db.query(
        `SELECT EXISTS (
          SELECT 1 FROM trading.collateral_reservations r
          WHERE r.deployment_id=$1 AND r.state IN ('ACCOUNTED','RELEASED') AND r.state_block_hash IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM chain.blocks b
              WHERE b.deployment_id=r.deployment_id AND b.hash=r.state_block_hash AND b.canonical)
        ) AS needed`,
        [deploymentId],
      );
      return rows[0]!.needed === true;
    },
    async outstandingQuotes(deploymentId, taker, blockTimestamp) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM trading.quotes
        WHERE deployment_id=$1 AND taker=decode($2,'hex') AND status IN ${IN_FLIGHT}
          AND expires_at>$3::numeric`,
        [deploymentId, bytes(taker), blockTimestamp.toString()],
      );
      return Number(rows[0]!.n);
    },
    async reservedMicros(deploymentId, headNumber) {
      const { rows } = await db.query(
        `SELECT COALESCE(sum(amount_micros),0)::text AS total FROM trading.collateral_reservations
        WHERE deployment_id=$1 AND (state IN ('HELD','RECONCILE_REQUIRED')
          OR (state='ACCOUNTED' AND state_block_number>$2::numeric))`,
        [deploymentId, headNumber.toString()],
      );
      return big(rows[0]!.total);
    },
    async createQuote(input) {
      const { intentId } = await writer.createIntent(db, {
        deploymentId: input.deploymentId,
        kind: "MAKER_QUOTE",
        role: "maker",
        dedupeKey: `quote:${input.digest}`,
        payload: input.message,
        createdBy: `api:${input.keyId}`,
      });
      const { signRequestId } = await writer.createSignRequest(db, {
        intentId,
        role: "maker",
        unsignedPayload: input.message,
        requestHash: input.digest,
        policyVersion: input.policyVersion,
      });
      await db.query(
        `INSERT INTO trading.quotes(id,digest,deployment_id,market_id,operator_id,idempotency_key,agent_id,key_id,taker,
          side,quantity,price_bps,taker_cost_micros,maker_cost_micros,max_cost_micros,valid_after,expires_at,nonce,epoch,
          spec_hash,forecast_snapshot_id,intent_id,sign_request_id,snapshot_block_number,snapshot_block_hash,status)
        VALUES($1,decode($2,'hex'),$3,$4,$5,$6,$7,$8,decode($9,'hex'),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          decode($20,'hex'),$21,$22,$23,$24,decode($25,'hex'),'SIGN_REQUESTED')`,
        [
          input.id,
          bytes(input.digest),
          input.deploymentId,
          input.marketId.toString(),
          input.operatorId,
          input.idempotencyKey,
          input.agentId,
          input.keyId,
          bytes(input.taker),
          input.side,
          input.quantity.toString(),
          input.priceBps,
          input.takerCostMicros.toString(),
          input.makerCostMicros.toString(),
          input.maxCostMicros.toString(),
          input.validAfter.toString(),
          input.expiresAt.toString(),
          input.nonce.toString(),
          input.epoch.toString(),
          bytes(input.specHash),
          input.forecastSnapshotId,
          intentId,
          signRequestId,
          input.snapshotBlockNumber.toString(),
          bytes(input.snapshotBlockHash),
        ],
      );
      await db.query(
        `INSERT INTO trading.collateral_reservations(id,quote_id,deployment_id,amount_micros,state,state_block_number,state_block_hash)
        VALUES($1,$2,$3,$4,'HELD',$5,decode($6,'hex'))`,
        [
          input.reservationId,
          input.id,
          input.deploymentId,
          input.makerCostMicros.toString(),
          input.snapshotBlockNumber.toString(),
          bytes(input.snapshotBlockHash),
        ],
      );
      await appendEvent(db, {
        reservationId: input.reservationId,
        from: null,
        to: "HELD",
        blockHash: input.snapshotBlockHash,
        reason: "QUOTE_RESERVED",
      });
      await db.query(
        "UPDATE trading.maker_pools SET version=version+1 WHERE deployment_id=$1",
        [input.deploymentId],
      );
      return { signRequestId };
    },
    async quoteByKey(operatorId, idempotencyKey) {
      const { rows } = await db.query(
        `SELECT ${quoteColumns} FROM trading.quotes q WHERE q.operator_id=$1 AND q.idempotency_key=$2`,
        [operatorId, idempotencyKey],
      );
      return rows[0] ? quoteOf(rows[0]) : null;
    },
    async quoteByDigest(deploymentId, digest) {
      const { rows } = await db.query(
        `SELECT ${quoteColumns} FROM trading.quotes q WHERE q.deployment_id=$1 AND q.digest=decode($2,'hex')`,
        [deploymentId, bytes(digest)],
      );
      return rows[0] ? quoteOf(rows[0]) : null;
    },
    async lockQuote(id) {
      const { rows } = await db.query(
        `SELECT ${quoteColumns} FROM trading.quotes q WHERE q.id=$1 FOR UPDATE`,
        [id],
      );
      return rows[0] ? quoteOf(rows[0]) : null;
    },
    async quoteChainState(deploymentId, digest) {
      const { rows } = await db.query(
        `SELECT (SELECT state FROM chain.quote_digests WHERE deployment_id=$1 AND digest=decode($2,'hex')) AS digest,
          (SELECT epoch::text FROM chain.maker_state WHERE deployment_id=$1) AS epoch`,
        [deploymentId, bytes(digest)],
      );
      const row = rows[0]!;
      return {
        digest: (row.digest as "FILLED" | "CANCELLED" | null) ?? null,
        makerEpoch: row.epoch === null ? null : big(row.epoch),
      };
    },
    async markSigned(quoteId, envelope) {
      const { rows } = await db.query(
        `UPDATE trading.quotes SET status='SIGNED', envelope=$2::jsonb, signed_at=clock_timestamp(),
          updated_at=clock_timestamp(), version=version+1
        WHERE id=$1 AND status IN ('SIGN_REQUESTED','SIGN_UNKNOWN') RETURNING id`,
        [quoteId, JSON.stringify(envelope)],
      );
      return rows.length === 1;
    },
    async markSignUnknown(quoteId) {
      await db.query(
        `UPDATE trading.quotes SET status='SIGN_UNKNOWN', updated_at=clock_timestamp(), version=version+1
        WHERE id=$1 AND status IN ('SIGN_REQUESTED','SIGN_UNKNOWN')`,
        [quoteId],
      );
    },
    async markSignRejected(quoteId, code) {
      // Reservation first, then quote: the order reconciliation uses, so the two never deadlock.
      const { rows } = await db.query(
        `WITH prev AS (SELECT id FROM trading.collateral_reservations WHERE quote_id=$1 AND state='HELD' FOR UPDATE)
        UPDATE trading.collateral_reservations r SET state='RELEASED', state_block_number=NULL, state_block_hash=NULL,
          updated_at=clock_timestamp(), version=r.version+1
        FROM prev WHERE r.id=prev.id RETURNING r.id`,
        [quoteId],
      );
      if (rows[0])
        await appendEvent(db, {
          reservationId: String(rows[0].id),
          from: "HELD",
          to: "RELEASED",
          blockHash: null,
          reason: `SIGN_REJECTED:${code}`,
        });
      await db.query(
        `UPDATE trading.quotes SET status='SIGN_REJECTED', updated_at=clock_timestamp(), version=version+1
        WHERE id=$1 AND status IN ('SIGN_REQUESTED','SIGN_UNKNOWN')`,
        [quoteId],
      );
    },
    async reopenOrphaned(deploymentId) {
      const { rows } = await db.query(
        `SELECT r.id, r.quote_id, r.state, ${hex("r.state_block_hash", "block_hash")}
        FROM trading.collateral_reservations r
        WHERE r.deployment_id=$1 AND r.state IN ('ACCOUNTED','RELEASED') AND r.state_block_hash IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM chain.blocks b
            WHERE b.deployment_id=r.deployment_id AND b.hash=r.state_block_hash AND b.canonical)
        ORDER BY r.created_at, r.id FOR UPDATE OF r`,
        [deploymentId],
      );
      for (const row of rows) {
        await db.query(
          `UPDATE trading.collateral_reservations SET state='RECONCILE_REQUIRED', state_block_number=NULL,
            state_block_hash=NULL, updated_at=clock_timestamp(), version=version+1 WHERE id=$1`,
          [row.id],
        );
        await appendEvent(db, {
          reservationId: String(row.id),
          from: row.state as ReservationState,
          to: "RECONCILE_REQUIRED",
          blockHash: String(row.block_hash),
          reason: "REORG_REOPENED",
        });
        // The signed quote is live again; one that never got its signature back is still unknown.
        await db.query(
          `UPDATE trading.quotes SET status=CASE WHEN envelope IS NULL THEN 'SIGN_UNKNOWN' ELSE 'SIGNED' END,
            status_block_hash=NULL, updated_at=clock_timestamp(), version=version+1
          WHERE id=$1 AND status IN ('EXPIRED','CANCELLED','CONSUMED')`,
          [row.quote_id],
        );
      }
      return rows.length;
    },
    async openReservations(deploymentId): Promise<OpenReservation[]> {
      const { rows } = await db.query(
        `SELECT r.id AS reservation_id, r.quote_id, r.amount_micros::text AS amount,
          q.epoch::text AS quote_epoch, q.expires_at::text AS expires_at,
          d.state AS digest_state, d.block_number::text AS digest_block, ${hex("d.block_hash", "digest_hash")}
        FROM trading.collateral_reservations r
        JOIN trading.quotes q ON q.id=r.quote_id
        LEFT JOIN chain.quote_digests d ON d.deployment_id=r.deployment_id AND d.digest=q.digest
        WHERE r.deployment_id=$1 AND r.state IN ('HELD','RECONCILE_REQUIRED')
        ORDER BY r.created_at, r.id FOR UPDATE OF r`,
        [deploymentId],
      );
      return rows.map((row) => ({
        reservationId: String(row.reservation_id),
        quoteId: String(row.quote_id),
        amountMicros: big(row.amount),
        quoteEpoch: big(row.quote_epoch),
        expiresAt: big(row.expires_at),
        digest:
          row.digest_state === null
            ? null
            : {
                state: row.digest_state as "FILLED" | "CANCELLED",
                blockNumber: big(row.digest_block),
                blockHash: row.digest_hash as Hex,
              },
      }));
    },
    async settle(s) {
      const { rows } = await db.query(
        `WITH prev AS (SELECT id, state FROM trading.collateral_reservations
          WHERE id=$1 AND state IN ('HELD','RECONCILE_REQUIRED') FOR UPDATE)
        UPDATE trading.collateral_reservations r SET state=$2, state_block_number=$3::numeric,
          state_block_hash=decode($4,'hex'), updated_at=clock_timestamp(), version=r.version+1
        FROM prev WHERE r.id=prev.id RETURNING prev.state AS previous`,
        [s.reservationId, s.to, s.blockNumber.toString(), bytes(s.blockHash)],
      );
      if (!rows[0]) return false;
      await appendEvent(db, {
        reservationId: s.reservationId,
        from: rows[0].previous as ReservationState,
        to: s.to,
        blockHash: s.blockHash,
        reason: s.reason,
      });
      await db.query(
        `UPDATE trading.quotes SET status=$2, status_block_hash=decode($3,'hex'),
          updated_at=clock_timestamp(), version=version+1
        WHERE id=$1 AND status IN ${IN_FLIGHT}`,
        [s.quoteId, s.quoteStatus, bytes(s.blockHash)],
      );
      return true;
    },
    async makerState(deploymentId) {
      const { rows } = await db.query(
        `SELECT free_balance_micros::text AS free, epoch::text AS epoch
        FROM chain.maker_state WHERE deployment_id=$1`,
        [deploymentId],
      );
      return rows[0]
        ? { freeMicros: big(rows[0].free), epoch: big(rows[0].epoch) }
        : null;
    },
    async heldMicros(deploymentId) {
      const { rows } = await db.query(
        `SELECT COALESCE(sum(amount_micros),0)::text AS total FROM trading.collateral_reservations
        WHERE deployment_id=$1 AND state IN ('HELD','RECONCILE_REQUIRED')`,
        [deploymentId],
      );
      return big(rows[0]!.total);
    },
    async setPoolGate(deploymentId, reason) {
      await db.query(
        `UPDATE trading.maker_pools SET gate_reason=$2, version=version+1
        WHERE deployment_id=$1 AND gate_reason IS DISTINCT FROM $2`,
        [deploymentId, reason],
      );
    },
    async bumpPool(deploymentId) {
      await db.query(
        "UPDATE trading.maker_pools SET version=version+1 WHERE deployment_id=$1",
        [deploymentId],
      );
    },
  };
}

export function postgresTradingStore(pool: Pool): TradingStore {
  const uow = createUnitOfWork(pool);
  return {
    run: (work) => uow.run((ctx) => work(tradingTransaction(uow.client(ctx)))),
  };
}

/** The signer's view: reads inside its own transaction, with the SELECT grants it has. */
export function postgresReservationReader(): ReservationReader {
  return {
    async reservationFor(client, digest) {
      const { rows } = await (client as SigningSqlClient).query(
        `SELECT q.status, r.state, r.amount_micros::text AS amount
        FROM trading.quotes q JOIN trading.collateral_reservations r ON r.quote_id=q.id
        WHERE q.digest=decode($1,'hex')`,
        [bytes(digest)],
      );
      const row = rows[0];
      return row
        ? {
            quoteStatus: row.status as QuoteStatus,
            reservationState: row.state as ReservationState,
            amountMicros: big(row.amount),
          }
        : null;
    },
  };
}

/** The API's startup guard: the trading migration is installed. */
export async function assertTradingInstalled(pool: Pool) {
  await pool.query("SELECT id FROM trading.quotes LIMIT 0");
}
