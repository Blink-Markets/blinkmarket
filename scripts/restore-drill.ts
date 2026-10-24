import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { prepareRestoredDatabase } from "./restore-prepare.js";

export const POSTGRES_IMAGE = "postgres:17.6";
const TOOL_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 300_000;

export interface RestoreDrillReport {
  pgDumpVersion: string;
  archiveBytes: number;
  restoredEqualsDump: boolean;
  schemaIdentical: boolean;
  leaseCleared: boolean;
}

interface Tool {
  network: string[];
  host: string;
  port: string;
  user: string;
  password: string;
}

// Containers reach the host's PostgreSQL through the host network on Linux (CI) and through
// Docker Desktop's host alias elsewhere.
function toolFor(adminUrl: URL): Tool {
  const linux = process.platform === "linux";
  return {
    network: linux
      ? ["--network", "host"]
      : ["--add-host", "host.docker.internal:host-gateway"],
    host: linux ? adminUrl.hostname : "host.docker.internal",
    port: adminUrl.port || "5432",
    user: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
  };
}

// A first run on a fresh machine pulls the image: give that its own bound, outside the tool timeout.
let imageReady: Promise<void> | undefined;
function ensureImage(): Promise<void> {
  const exec = promisify(execFile);
  imageReady ??= exec("docker", ["image", "inspect", POSTGRES_IMAGE]).then(
    () => undefined,
    () =>
      exec("docker", ["pull", POSTGRES_IMAGE], {
        timeout: PULL_TIMEOUT_MS,
      }).then(() => undefined),
  );
  return imageReady;
}

// Runs one PostgreSQL client tool inside the pinned image; the password travels in the
// container's environment, never in an argument.
function runTool(
  tool: Tool,
  label: string,
  args: string[],
  options: { input?: Buffer; signal: AbortSignal },
): Promise<Buffer> {
  const name = "blink-drill-" + randomUUID().slice(0, 8);
  return ensureImage().then(() =>
    runContainer(tool, name, label, args, options),
  );
}
function runContainer(
  tool: Tool,
  name: string,
  label: string,
  args: string[],
  options: { input?: Buffer; signal: AbortSignal },
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        ...tool.network,
        "-e",
        "PGPASSWORD",
        POSTGRES_IMAGE,
        ...args,
      ],
      {
        env: { ...process.env, PGPASSWORD: tool.password },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const stop = (reason: string) => {
      child.kill("SIGKILL");
      // Killing the client leaves the container running until its tool ends.
      spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).on(
        "error",
        () => {},
      );
      reject(new Error(`RESTORE_DRILL_TOOL_FAILED: ${label} ${reason}`));
    };
    const timer = setTimeout(
      () => stop(`timed out after ${TOOL_TIMEOUT_MS} ms`),
      TOOL_TIMEOUT_MS,
    );
    const abort = () => stop("cancelled");
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) =>
      reject(
        new Error(`RESTORE_DRILL_TOOL_FAILED: ${label}: ${error.message}`),
      ),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (code === 0) resolvePromise(Buffer.concat(out));
      else
        reject(
          new Error(
            `RESTORE_DRILL_TOOL_FAILED: ${label} exited ${code}: ${err.trim().slice(0, 500)}`,
          ),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

// Every table's content digest and grants. The cursor lease changes during recovery, so
// the cursor is compared separately with only lease ownership and expiry excluded.
async function fingerprint(db: pg.Pool) {
  const tables = (
    await db.query<{ schema: string; name: string }>(
      `SELECT schemaname AS schema, tablename AS name FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`,
    )
  ).rows.filter((t) => !["chain.cursors"].includes(`${t.schema}.${t.name}`));
  const rows: Record<string, string> = {};
  for (const { schema, name } of tables) {
    const { rows: result } = await db.query(
      `SELECT count(*)::text AS n,
        md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS digest
      FROM "${schema}"."${name}" x`,
    );
    rows[`${schema}.${name}`] = `${result[0].n}:${result[0].digest}`;
  }
  const privileges = (
    await db.query<{ line: string }>(
      `SELECT n.nspname || '.' || c.relname || ' ' || a.grantee::regrole::text || ' ' || a.privilege_type AS line
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
        LATERAL aclexplode(c.relacl) a
      WHERE c.relacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema')
      UNION ALL
      SELECT n.nspname || '.' || c.relname || '.' || t.attname || ' ' || a.grantee::regrole::text || ' ' || a.privilege_type
      FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
        LATERAL aclexplode(t.attacl) a
      WHERE t.attacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema')
      ORDER BY 1`,
    )
  ).rows.map((r) => r.line);
  return { rows, privileges };
}

// `((A) OR (B)) OR (C)` and `(A) OR (B) OR (C)` are the same condition, and a restore turns the
// first form into the second. Splices a parenthesized group that is itself an OR chain into the
// OR chain around it; every other character, parenthesis included, stays exactly as dumped.
type Part = string | Part[];
function flattenOr(line: string): string {
  const stack: Part[][] = [[]];
  for (const piece of line.split(/([()])/)) {
    if (piece === "(") stack.push([]);
    else if (piece === ")") {
      if (stack.length < 2) return line;
      const group = stack.pop()!;
      stack.at(-1)!.push(group);
    } else if (piece) stack.at(-1)!.push(piece);
  }
  if (stack.length !== 1) return line;
  const isOr = (g: Part[]) =>
    g.some((p) => typeof p === "string" && p.includes(" OR "));
  const flatten = (g: Part[]): Part[] => {
    const parts = g.map((p) => (typeof p === "string" ? p : flatten(p)));
    return isOr(parts)
      ? parts.flatMap((p) => (typeof p !== "string" && isOr(p) ? p : [p]))
      : parts;
  };
  const text = (g: Part[]): string =>
    g.map((p) => (typeof p === "string" ? p : "(" + text(p) + ")")).join("");
  return text(flatten(stack[0]!));
}

// The drill copies a quiescent infrastructure database; it never signs or sends transactions.
export async function runRestoreDrill(
  context: {
    owner: pg.Pool;
    adminUrl: string;
    deploymentId: string;
    signal: AbortSignal;
  },
  options: { afterRestore?: (db: pg.Pool) => Promise<unknown> } = {},
): Promise<RestoreDrillReport> {
  const admin = new URL(context.adminUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(admin.hostname))
    throw new Error("LOCAL_POSTGRES_REQUIRED");
  const tool = toolFor(admin);
  const sourceName = (
    await context.owner.query("SELECT current_database() AS name")
  ).rows[0].name as string;
  const dbArgs = (name: string) => [
    "-h",
    tool.host,
    "-p",
    tool.port,
    "-U",
    tool.user,
    "-d",
    name,
  ];
  const run = (label: string, args: string[], input?: Buffer) =>
    runTool(tool, label, args, {
      signal: context.signal,
      ...(input ? { input } : {}),
    });
  const schemaOf = async (name: string) =>
    (
      await run("schema", [
        "pg_dump",
        "--schema-only",
        "--no-owner",
        ...dbArgs(name),
      ])
    )
      .toString()
      .replaceAll(name, "<database>")
      .replace(/^\\(un)?restrict .*\n/gm, "")
      .replace(/^.*\bCHECK\b.*$/gm, flattenOr);
  const cursorOf = async (db: pg.Pool) =>
    (
      await db.query(
        "SELECT to_jsonb(c)-'lease_owner'-'lease_until' AS cursor FROM chain.cursors c ORDER BY deployment_id",
      )
    ).rows;
  const sourcePrint = await fingerprint(context.owner);
  const sourceCursor = await cursorOf(context.owner);
  const sourceSchema = await schemaOf(sourceName);
  const pgDumpVersion = (await run("version", ["pg_dump", "--version"]))
    .toString()
    .trim();
  const archive = await run("dump", [
    "pg_dump",
    "--format=custom",
    "--no-owner",
    ...dbArgs(sourceName),
  ]);
  assert.ok(archive.length > 0, "RESTORE_DRILL_EMPTY_DUMP");
  const restoredName = "blink_restore_" + randomUUID().replaceAll("-", "");
  const restoredUrl = new URL(admin);
  restoredUrl.pathname = "/" + restoredName;
  const control = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  const restored = new pg.Pool({
    connectionString: restoredUrl.toString(),
    max: 2,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  await control.connect();
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${restoredName}"`);
    created = true;
    await run(
      "restore",
      ["pg_restore", "--no-owner", "--exit-on-error", ...dbArgs(restoredName)],
      archive,
    );
    await options.afterRestore?.(restored);
    const prepared = await prepareRestoredDatabase(
      restored,
      context.deploymentId,
    );
    assert.deepEqual(
      await fingerprint(restored),
      sourcePrint,
      "RESTORE_NOT_EQUAL_TO_DUMP",
    );
    assert.deepEqual(
      await cursorOf(restored),
      sourceCursor,
      "RESTORE_NOT_EQUAL_TO_DUMP",
    );
    assert.equal(
      await schemaOf(restoredName),
      sourceSchema,
      "RESTORE_SCHEMA_DIFFERS",
    );
    assert.equal(
      (
        await restored.query(
          "SELECT count(*)::int AS n FROM chain.cursors WHERE lease_owner IS NOT NULL AND deployment_id=$1",
          [context.deploymentId],
        )
      ).rows[0].n,
      0,
    );
    return {
      pgDumpVersion,
      archiveBytes: archive.length,
      restoredEqualsDump: true,
      schemaIdentical: true,
      leaseCleared: prepared.leaseCleared,
    };
  } finally {
    try {
      await restored.end();
    } finally {
      try {
        if (created) {
          // pool.end() resolves before its sockets close: let the sessions leave on their own, so
          // DROP ... FORCE never kills a client that is still shutting down (an uncaught error).
          for (let i = 0; i < 100; i += 1) {
            const { rows } = await control.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
              [restoredName],
            );
            if (rows[0].n === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await control.query(`DROP DATABASE "${restoredName}" WITH (FORCE)`);
        }
      } finally {
        await control.end();
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const databaseUrl = process.env.RESTORE_ADMIN_DATABASE_URL;
  const deploymentId = process.argv[2];
  if (!databaseUrl || !deploymentId || process.argv.length !== 3) {
    console.error(
      "RESTORE_DRILL_CONFIGURATION_REQUIRED: pnpm drill:restore <deploymentId>, RESTORE_ADMIN_DATABASE_URL",
    );
    process.exitCode = 1;
  } else {
    const owner = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    try {
      console.log(
        JSON.stringify(
          await runRestoreDrill({
            owner,
            adminUrl: databaseUrl,
            deploymentId,
            signal: AbortSignal.timeout(300_000),
          }),
        ),
      );
    } catch {
      console.error("RESTORE_DRILL_FAILED");
      process.exitCode = 1;
    } finally {
      await owner.end();
    }
  }
}
