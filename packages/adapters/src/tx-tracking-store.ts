import { ProtocolDeployment } from "@blink/schemas";
import type { Pool } from "pg";
import type {
  TrackedStatus,
  TrackedTransaction,
  TxTrackingStore,
} from "@blink/ports";
export const transactionColumns = `t.id,t.deployment_id AS "deploymentId",'0x'||encode(t.tx_hash,'hex') AS "txHash",t.agent_id AS "agentId",'0x'||encode(t.wallet,'hex') AS wallet,t.action,t.market_id::text AS "marketId",t.status,t.reject_reason AS "rejectReason",'0x'||encode(t.receipt_block_hash,'hex') AS "receiptBlockHash",t.receipt_block_number::text AS "receiptBlockNumber",t.version::text AS version`;
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
            `UPDATE chain.transactions SET action=$3,status=$4,reject_reason=$5,receipt_block_hash=decode($6,'hex'),receipt_block_number=$7,market_id=$8,version=version+1,updated_at=blink.now() WHERE id=$1 AND version=$2`,
            [
              row.id,
              row.version,
              next.action,
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
    async track(input) {
      await pool.query(
        `INSERT INTO chain.transactions(id,deployment_id,tx_hash,agent_id,wallet) VALUES ($1,$2,decode($3,'hex'),$4,decode($5,'hex')) ON CONFLICT (deployment_id,tx_hash) DO NOTHING`,
        [
          input.id,
          input.deploymentId,
          input.txHash.slice(2),
          input.agentId,
          input.wallet.slice(2),
        ],
      );
      const row = (
        await pool.query<{ id: string; agentId: string; status: TrackedStatus }>(
          `SELECT t.id,t.agent_id AS "agentId",t.status FROM chain.transactions t WHERE t.deployment_id=$1 AND t.tx_hash=decode($2,'hex')`,
          [input.deploymentId, input.txHash.slice(2)],
        )
      ).rows[0];
      if (!row) throw new Error("TRACKED_TRANSACTION_MISSING");
      return row;
    },
  };
}

/** The registered protocol generation a tracked transaction belongs to. */
export async function txTrackingManifest(
  pool: Pool,
  deploymentId: string,
): Promise<ProtocolDeployment | null> {
  const row = (
    await pool.query(
      "SELECT manifest FROM markets.protocol_deployments WHERE deployment_id=$1",
      [deploymentId],
    )
  ).rows[0];
  return row ? ProtocolDeployment.parse(row.manifest) : null;
}
