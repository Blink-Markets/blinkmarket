import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface MigrationConnection {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export const migrationDirectory = new URL("../migrations/", import.meta.url);
export async function migratePostgres(connectionString: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await migrate(client);
  } finally {
    await client.end();
  }
}
export async function migrate(
  client: MigrationConnection,
  directory: URL = migrationDirectory,
) {
  // Must be one dedicated session. Session lock spans the per-file transactions.
  await client.query("SELECT pg_advisory_lock(84532, 1)");
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS blink_migrations");
    await client.query("REVOKE ALL ON SCHEMA blink_migrations FROM PUBLIC");
    await client.query(
      "CREATE TABLE IF NOT EXISTS blink_migrations.applied (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())",
    );
    const files = (await readdir(directory))
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
      .sort();
    const names = new Set(files);
    const applied = await client.query(
      "SELECT name,checksum FROM blink_migrations.applied",
    );
    if (applied.rows.some((r) => !names.has(String(r.name))))
      throw new Error("MISSING_APPLIED_MIGRATION");
    for (const name of files) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = applied.rows.find((r) => r.name === name);
      if (previous) {
        if (previous.checksum !== checksum)
          throw new Error("MIGRATION_CHECKSUM_MISMATCH: " + name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO blink_migrations.applied(name,checksum) VALUES ($1,$2)",
          [name, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { directory: fileURLToPath(directory), versions: files };
  } finally {
    await client.query("SELECT pg_advisory_unlock(84532, 1)");
  }
}
