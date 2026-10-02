import { parseArgs } from "node:util";
import { open, readFile } from "node:fs/promises";
import pg from "pg";
import { evidenceAdmin } from "../packages/adapters/src/evidence-admin.js";
import { fileObjectStore } from "../packages/adapters/src/file-object-store.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    entity: { type: "string" },
    url: { type: "string" },
    reason: { type: "string" },
    metadata: { type: "string" },
    file: { type: "string" },
  },
});
const connectionString = process.env.EVIDENCE_ADMIN_DATABASE_URL;
const directory = process.env.EVIDENCE_OBJECT_DIRECTORY;
if (!connectionString || !directory)
  throw new Error("EVIDENCE_ADMIN_CONFIGURATION_REQUIRED");
const pool = new pg.Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
try {
  const admin = evidenceAdmin(pool, fileObjectStore(directory));
  if (
    positionals[0] === "allow-source" &&
    values.entity &&
    values.url &&
    values.reason
  ) {
    console.log(
      JSON.stringify(
        await admin.allowSource(values.entity, values.url, values.reason),
      ),
    );
  } else if (positionals[0] === "import" && values.metadata && values.file) {
    const handle = await open(values.file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 10 * 1024 * 1024)
        throw new Error("INVALID_EVIDENCE_FILE");
      const metadata = JSON.parse(
        await readFile(values.metadata, "utf8"),
      ) as unknown;
      console.log(
        JSON.stringify(
          await admin.importBytes(metadata, await handle.readFile()),
        ),
      );
    } finally {
      await handle.close();
    }
  } else throw new Error("INVALID_ARGUMENTS");
} catch {
  console.error(
    "EVIDENCE_ADMIN_FAILED: check arguments, reviewed metadata, archive and database permissions",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
