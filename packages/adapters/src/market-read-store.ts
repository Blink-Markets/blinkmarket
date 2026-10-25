import type { Pool } from "pg";
import type { MarketReadStore } from "@blink/ports";
import { transactionColumns } from "./tx-tracking-store.js";

// Timestamp lag and stopped-index age share the protocol's 30-second freshness budget.
export const indexerStaleSql = (cursor: string) =>
  `(${cursor}.synced_at < blink.now()-interval '30 seconds' OR COALESCE(${cursor}.head_timestamp,${cursor}.block_timestamp)-${cursor}.block_timestamp>30)`;
export function postgresMarketReadStore(pool: Pool): MarketReadStore {
  return {
    async transaction(deployment, hash) {
      const row = (
        await pool.query(
          `SELECT ${transactionColumns},c.finalized_number::text AS finalized FROM chain.transactions t LEFT JOIN chain.cursors c ON c.deployment_id=t.deployment_id WHERE t.deployment_id=$1 AND t.tx_hash=decode($2,'hex')`,
          [deployment, hash.slice(2)],
        )
      ).rows[0];
      if (!row) return null;
      return {
        ...row,
        chainCursor: row.receiptBlockHash
          ? {
              blockNumber: row.receiptBlockNumber,
              blockHash: row.receiptBlockHash,
              finality:
                row.status === "REORGED"
                  ? "UNKNOWN"
                  : row.status === "FINALIZED"
                    ? "FINALIZED"
                    : row.finalized === null
                      ? "UNKNOWN"
                      : "INCLUDED",
            }
          : null,
      } as Awaited<ReturnType<MarketReadStore["transaction"]>>;
    },
  };
}
