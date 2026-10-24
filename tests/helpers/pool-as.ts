import type { Pool } from "pg";
import type { TestDatabase } from "./database.js";

/**
 * A pool on the shared PGlite session that switches to `role` whenever a
 * connection is checked out, so the real API and the real worker stores can
 * take turns on one session with their own grants.
 */
export function poolAs(t: TestDatabase, role: string): Pool {
  const connect = async () => {
    const client = await (
      t.pool as unknown as {
        connect(): Promise<{
          query(sql: string, params?: unknown[]): Promise<unknown>;
          release(): void;
        }>;
      }
    ).connect();
    await client.query(`SET ROLE ${role}`);
    return client;
  };
  return {
    connect,
    async query(sql: string, params?: unknown[]) {
      const client = await connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
  } as unknown as Pool;
}
