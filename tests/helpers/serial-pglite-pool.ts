import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";

/**
 * A migrated PGlite database behind a `pg.Pool` lookalike, connected as
 * `blink_worker`. One PGlite session serializes checkout, so this is NOT a
 * multi-connection lock test; real races live in tests/postgres.
 */
export async function migratedPglite() {
  const db = new PGlite();
  await migrate({
    async query(sql, params) {
      if (params) return db.query<Record<string, unknown>>(sql, params);
      return {
        rows:
          ((await db.exec(sql)).at(-1)?.rows as Record<string, unknown>[]) ??
          [],
      };
    },
  });
  await db.exec(
    await readFile(
      new URL("./test-clock-overlay.sql", import.meta.url),
      "utf8",
    ),
  );
  let previous = Promise.resolve();
  const connect = async () => {
    const ready = previous;
    let release!: () => void;
    previous = new Promise<void>((r) => {
      release = r;
    });
    await ready;
    return {
      query: (sql: string, params?: unknown[]) => db.query(sql, params),
      release,
    };
  };
  const pool = {
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
  await db.exec("SET ROLE blink_worker");
  return {
    db,
    pool,
    /** Moves blink.now() forward for this session without sleeping. */
    async advanceClock(seconds: number) {
      await db.query(
        "SELECT set_config('blink.test_clock_offset_seconds', $1, false)",
        [String(seconds)],
      );
    },
    /** Runs privileged fixture work, then returns to the worker role. */
    async asOwner<T>(work: () => Promise<T>): Promise<T> {
      await db.exec("RESET ROLE");
      try {
        return await work();
      } finally {
        await db.exec("SET ROLE blink_worker");
      }
    },
  };
}
