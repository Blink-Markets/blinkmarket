import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { MarketReadStore } from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import { identityTransaction } from "./identity-store.js";
import { transactionColumns } from "./tx-tracking-store.js";

// Timestamp lag and stopped-index age share the protocol's 30-second freshness budget.
export const indexerStaleSql = (cursor: string) =>
  `(${cursor}.synced_at < blink.now()-interval '30 seconds' OR COALESCE(${cursor}.head_timestamp,${cursor}.block_timestamp)-${cursor}.block_timestamp>30)`;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function postgresMarketReadStore(pool: Pool): MarketReadStore {
  const uow = createUnitOfWork(pool);
  return {
    async hint(principal, body, key) {
      return uow.run(async (context) => {
        const db = uow.client(context),
          tx = identityTransaction(db);
        const current = await tx.key(principal.keyId);
        if (
          !current ||
          current.revokedAt ||
          current.expiresAt <= (await tx.now())
        )
          throw new Error("UNAUTHORIZED");
        const scope = "POST /v1/transactions";
        const claim = await tx.claimRequest(
          principal.operatorId,
          scope,
          key,
          digest({ keyId: principal.keyId, body }),
        );
        if (claim.state === "DONE") return claim.result;
        if (claim.state === "CONFLICT") throw new Error("IDEMPOTENCY_CONFLICT");
        if (claim.state === "BUSY") throw new Error("REQUEST_IN_PROGRESS");
        const wallet = await tx.wallet(principal.agentId);
        let result;
        if (!wallet)
          result = {
            status: 403,
            body: {
              code: "WALLET_NOT_VERIFIED",
              message: "WALLET_NOT_VERIFIED",
              retryable: false,
              details: {},
            },
          };
        else if (
          !(
            await db.query("SELECT id FROM markets.deployments WHERE id=$1", [
              body.deploymentId,
            ])
          ).rows.length
        )
          result = {
            status: 404,
            body: {
              code: "NOT_FOUND",
              message: "NOT_FOUND",
              retryable: false,
              details: {},
            },
          };
        else {
          await db.query(
            `INSERT INTO chain.transactions(id,deployment_id,tx_hash,agent_id,wallet,action,quote_id) VALUES ($1,$2,decode($3,'hex'),$4,decode($5,'hex'),$6,decode($7,'hex')) ON CONFLICT (deployment_id,tx_hash) DO NOTHING`,
            [
              randomUUID(),
              body.deploymentId,
              body.txHash.slice(2),
              principal.agentId,
              wallet.slice(2),
              body.action,
              body.quoteId?.slice(2) ?? null,
            ],
          );
          const row = (
            await db.query<{ id: string; agent_id: string }>(
              "SELECT id,agent_id FROM chain.transactions WHERE deployment_id=$1 AND tx_hash=decode($2,'hex')",
              [body.deploymentId, body.txHash.slice(2)],
            )
          ).rows[0]!;
          result =
            row.agent_id === principal.agentId
              ? { status: 202, body: { trackingId: row.id, status: "UNKNOWN" } }
              : {
                  status: 409,
                  body: {
                    code: "TX_ALREADY_TRACKED",
                    message: "TX_ALREADY_TRACKED",
                    retryable: false,
                    details: {},
                  },
                };
        }
        await tx.finishRequest(principal.operatorId, scope, key, result);
        return result;
      });
    },
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
