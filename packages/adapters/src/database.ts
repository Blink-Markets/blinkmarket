import type { Pool, PoolClient } from "pg";
import type { TransactionContext, UnitOfWork } from "@blink/ports";

// The handle is deliberately opaque; callers cannot forge a working transactionId.
export function createUnitOfWork(
  pool: Pool,
): UnitOfWork & { client(tx: TransactionContext): PoolClient } {
  const active = new WeakMap<object, PoolClient>();
  return {
    client(tx) {
      const client = active.get(tx);
      if (!client) throw new Error("INACTIVE_OR_FOREIGN_TRANSACTION");
      return client;
    },
    async run<T>(
      work: (tx: TransactionContext) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      const client = await pool.connect();
      const tx = Object.freeze({}) as TransactionContext;
      try {
        await client.query("BEGIN");
        active.set(tx, client);
        if (signal?.aborted)
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("OPERATION_ABORTED");
        const result = await work(tx);
        if (signal?.aborted)
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("OPERATION_ABORTED");
        const commit = await client.query("COMMIT");
        // PostgreSQL acknowledges COMMIT on an aborted transaction as ROLLBACK.
        if (commit.command !== "COMMIT")
          throw new Error("TRANSACTION_NOT_COMMITTED");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        active.delete(tx);
        client.release();
      }
    },
  };
}
