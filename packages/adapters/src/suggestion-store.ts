import type { Pool } from "pg";
import type { SuggestionRecord, SuggestionStore } from "@blink/ports";
import { createUnitOfWork } from "./database.js";

type Row = {
  seq: string;
  id: string;
  body: string;
  source_urls: string[];
  created_at: Date;
  spec_hashes: string[];
  claim_count: string;
};
const select = `SELECT s.seq::text AS seq,s.id,s.body,s.source_urls,s.created_at,
  COALESCE((SELECT array_agg('0x'||encode(l.spec_hash,'hex') ORDER BY l.spec_hash)
    FROM suggestions.spec_links l WHERE l.suggestion_id=s.id),'{}') AS spec_hashes,
  (SELECT count(*) FROM suggestions.claims c WHERE c.suggestion_id=s.id)::text AS claim_count
  FROM suggestions.items s`;
const record = (r: Row): SuggestionRecord & { seq: string } => ({
  seq: r.seq,
  id: r.id,
  text: r.body,
  sourceUrls: r.source_urls,
  createdAt: new Date(r.created_at),
  specHashes: r.spec_hashes,
  claimCount: Number(r.claim_count),
});

export function postgresSuggestionStore(pool: Pool): SuggestionStore {
  const uow = createUnitOfWork(pool);
  return {
    async add(input) {
      await pool.query(
        "INSERT INTO suggestions.items(id,body,source_urls) VALUES ($1,$2,$3)",
        [input.id, input.text, input.sourceUrls],
      );
    },
    async get(id) {
      const { rows } = await pool.query<Row>(`${select} WHERE s.id=$1`, [id]);
      return rows[0] ? record(rows[0]) : null;
    },
    async list({ after, limit }) {
      const { rows } = await pool.query<Row>(
        `${select} WHERE ($1::bigint IS NULL OR s.seq<$1::bigint) ORDER BY s.seq DESC LIMIT $2`,
        [after, limit],
      );
      return rows.map(record);
    },
    async claim(id, creator) {
      return uow.run(async (ctx) => {
        const db = uow.client(ctx);
        // Ignore the claim if the suggestion does not exist; the insert would fail the foreign key.
        const found = await db.query(
          "SELECT 1 FROM suggestions.items WHERE id=$1",
          [id],
        );
        if (!found.rows[0]) return null;
        const { rowCount } = await db.query(
          `INSERT INTO suggestions.claims(suggestion_id,creator) VALUES ($1,decode($2,'hex'))
           ON CONFLICT DO NOTHING`,
          [id, creator.slice(2)],
        );
        return rowCount === 1;
      });
    },
  };
}
