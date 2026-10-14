import { DeploymentManifest } from "@blink/schemas";
import type { Pool } from "pg";
import type { TrackedTransaction, TxTrackingStore } from "@blink/ports";
export const transactionColumns = `t.id,t.deployment_id AS "deploymentId",'0x'||encode(t.tx_hash,'hex') AS "txHash",t.agent_id AS "agentId",'0x'||encode(t.wallet,'hex') AS wallet,t.action,'0x'||encode(t.quote_id,'hex') AS "quoteId",t.market_id::text AS "marketId",t.status,t.reject_reason AS "rejectReason",'0x'||encode(t.receipt_block_hash,'hex') AS "receiptBlockHash",t.receipt_block_number::text AS "receiptBlockNumber",t.version::text AS version`;
export function postgresTxTrackingStore(pool: Pool): TxTrackingStore {
  return {
    async pending(limit) {
      return (
        await pool.query<TrackedTransaction>(
          `SELECT ${transactionColumns} FROM chain.transactions t WHERE status IN ('UNKNOWN','INCLUDED','REORGED') AND reject_reason IS NULL ORDER BY updated_at,id LIMIT $1`,
          [limit],
        )
      ).rows;
    },
    async update(row, next) {
      return (
        (
          await pool.query(
            `UPDATE chain.transactions SET status=$3,reject_reason=$4,receipt_block_hash=decode($5,'hex'),receipt_block_number=$6,market_id=$7,version=version+1,updated_at=blink.now() WHERE id=$1 AND version=$2`,
            [
              row.id,
              row.version,
              next.status,
              next.rejectReason,
              next.receiptBlockHash?.slice(2) ?? null,
              next.receiptBlockNumber,
              next.marketId,
            ],
          )
        ).rowCount === 1
      );
    },
  };
}

export async function txTrackingManifest(
  pool: Pool,
  deploymentId: string,
): Promise<DeploymentManifest | null> {
  const row = (
    await pool.query("SELECT manifest FROM markets.deployments WHERE id=$1", [
      deploymentId,
    ])
  ).rows[0];
  if (!row) return null;
  if (row.manifest.chainId === 8453) throw new Error("MAINNET_REFUSED");
  return DeploymentManifest.parse(row.manifest);
}
