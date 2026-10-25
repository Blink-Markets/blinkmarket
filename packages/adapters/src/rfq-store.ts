import type { Pool } from "pg";
import type { RfqRecord, RfqStore } from "@blink/ports";
import { createUnitOfWork } from "./database.js";

type RfqRow = {
  id: string;
  seq: string;
  market_id: string;
  spec_hash: string;
  side: "YES" | "NO";
  quantity: string;
  taker: string;
  created_at: string;
  expires_at: string;
};
const columns = `id,seq::text AS seq,market_id::text AS market_id,'0x'||encode(spec_hash,'hex') AS spec_hash,
  side,quantity::text AS quantity,'0x'||encode(taker,'hex') AS taker,created_at::text AS created_at,expires_at::text AS expires_at`;
const record = (r: RfqRow): RfqRecord => ({
  id: r.id,
  seq: r.seq,
  marketId: r.market_id,
  specHash: r.spec_hash,
  side: r.side,
  quantity: r.quantity,
  taker: r.taker,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
});
const hex = (value: string) => value.slice(2);

/** RFQs and relayed quotes of one protocol generation. Rows are immutable: openness is a time test. */
export function postgresRfqStore(pool: Pool, deploymentId: string): RfqStore {
  const uow = createUnitOfWork(pool);
  return {
    async create(input, maxOpen) {
      return uow.run(async (tx) => {
        const db = uow.client(tx);
        // The count and the insert must not interleave with another RFQ of the same taker.
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "rfq:taker:" + input.taker,
        ]);
        const open = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM rfq.requests
           WHERE deployment_id=$1 AND taker=decode($2,'hex') AND expires_at>$3`,
          [deploymentId, hex(input.taker), input.createdAt],
        );
        if (Number(open.rows[0]!.n) >= maxOpen) return false;
        await db.query(
          `INSERT INTO rfq.requests(id,deployment_id,taker,market_id,spec_hash,side,quantity,created_at,expires_at)
           VALUES ($1,$2,decode($3,'hex'),$4,decode($5,'hex'),$6,$7,$8,$9)`,
          [
            input.id,
            deploymentId,
            hex(input.taker),
            input.marketId,
            hex(input.specHash),
            input.side,
            input.quantity,
            input.createdAt,
            input.expiresAt,
          ],
        );
        return true;
      });
    },
    async get(id) {
      const { rows } = await pool.query<RfqRow>(
        `SELECT ${columns} FROM rfq.requests WHERE id=$1 AND deployment_id=$2`,
        [id, deploymentId],
      );
      return rows[0] ? record(rows[0]) : null;
    },
    async listOpen({ after, limit, now }) {
      const { rows } = await pool.query<RfqRow>(
        `SELECT ${columns} FROM rfq.requests
         WHERE deployment_id=$1 AND expires_at>$2 AND ($3::bigint IS NULL OR seq>$3::bigint)
         ORDER BY seq LIMIT $4`,
        [deploymentId, now, after, limit],
      );
      return rows.map(record);
    },
    async addQuote(input, maxPerRfq) {
      return uow.run(async (tx) => {
        const db = uow.client(tx);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "rfq:quotes:" + input.rfqId,
        ]);
        const count = await db.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM rfq.quotes WHERE rfq_id=$1",
          [input.rfqId],
        );
        const mine = await db.query(
          "SELECT 1 FROM rfq.quotes WHERE rfq_id=$1 AND maker=decode($2,'hex')",
          [input.rfqId, hex(input.maker)],
        );
        if (mine.rows.length) return "DUPLICATE";
        if (Number(count.rows[0]!.n) >= maxPerRfq) return "FULL";
        await db.query(
          `INSERT INTO rfq.quotes(rfq_id,deployment_id,maker,digest,price_bps,expires_at,quote,signature,received_at)
           VALUES ($1,$2,decode($3,'hex'),decode($4,'hex'),$5,$6,$7,$8,$9)`,
          [
            input.rfqId,
            deploymentId,
            hex(input.maker),
            hex(input.digest),
            input.priceBps,
            input.expiresAt,
            input.quote,
            input.signature,
            input.receivedAt,
          ],
        );
        return "OK";
      });
    },
    async quotes(rfqId) {
      const { rows } = await pool.query<{ quote: string; signature: string }>(
        "SELECT quote,signature FROM rfq.quotes WHERE rfq_id=$1 AND deployment_id=$2 ORDER BY price_bps,seq",
        [rfqId, deploymentId],
      );
      return rows;
    },
    async stats(maker) {
      // Distinct digests: the same quote relayed to two RFQs is one fill or one cancel. A cancel
      // only counts when it was mined before the quote's expiry.
      const { rows } = await pool.query<{
        relayed: string;
        filled: string;
        cancelled: string;
      }>(
        `WITH mine AS (
           SELECT digest,expires_at FROM rfq.quotes WHERE deployment_id=$1 AND maker=decode($2,'hex')
         ), distinct_quotes AS (SELECT DISTINCT digest,expires_at FROM mine)
         SELECT (SELECT count(*) FROM mine)::text AS relayed,
           (SELECT count(*) FROM distinct_quotes q WHERE EXISTS (
              SELECT 1 FROM protocol.events e
              WHERE e.deployment_id=$1 AND e.canonical AND e.name='QuoteFilled'
                AND lower(e.args->>'digest')='0x'||encode(q.digest,'hex')))::text AS filled,
           (SELECT count(*) FROM distinct_quotes q WHERE EXISTS (
              SELECT 1 FROM protocol.events e
              JOIN chain.blocks b ON b.deployment_id=e.deployment_id AND b.hash=e.block_hash
              WHERE e.deployment_id=$1 AND e.canonical AND e.name='QuoteCancelled'
                AND lower(e.args->>'digest')='0x'||encode(q.digest,'hex')
                AND b.timestamp<q.expires_at))::text AS cancelled`,
        [deploymentId, hex(maker)],
      );
      const r = rows[0]!;
      return {
        quotesRelayed: Number(r.relayed),
        quotesFilled: Number(r.filled),
        quotesCancelledBeforeExpiry: Number(r.cancelled),
      };
    },
  };
}
