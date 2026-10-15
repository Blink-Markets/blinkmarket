import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { attemptAll, settle } from "./lifecycle.js";

export const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "TEST_POSTGRES_ADMIN_URL_REQUIRED: dedicated local/CI PostgreSQL with CREATEDB and CREATEROLE privileges",
  );

const TEARDOWN_STEP_TIMEOUT_MS = 30_000;

export interface DatabaseLimits {
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
}

// Optional bounds so a stalled server fails fast instead of hanging a run; unset keeps the
// pg defaults. The server cancels a slow statement first; the client timer, a little
// later, also covers a server that no longer answers at all.
export function connectionLimits(limits: DatabaseLimits = {}) {
  return {
    ...(limits.connectTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: limits.connectTimeoutMs }),
    ...(limits.statementTimeoutMs === undefined
      ? {}
      : {
          statement_timeout: limits.statementTimeoutMs,
          query_timeout: limits.statementTimeoutMs + 5000,
        }),
  };
}

// Each test creates and drops its own random database; the supplied database is never touched.
// Teardown attempts every step even if one fails; a failure of `run` is reported first.
export async function withDatabase(
  run: (pools: {
    name: string;
    owner: pg.Pool;
    pool: (role: string, max?: number) => pg.Pool;
    // A real login of its own (not the administrator), as a deployed service would use.
    login: (options?: {
      memberOf?: string[];
      createdb?: boolean;
      ownsDatabase?: boolean;
      max?: number;
    }) => Promise<pg.Pool>;
  }) => Promise<void>,
  limits: DatabaseLimits = {},
) {
  const bounds = connectionLimits(limits);
  const name = "blink_t8_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^blink_t8_[a-f0-9]{32}$/);
  const control = new pg.Client({ connectionString: adminUrl, ...bounds });
  await control.connect();
  let created = false;
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  const owner = new pg.Pool({
    connectionString: url.toString(),
    max: 2,
    ...bounds,
  });
  const opened: pg.Pool[] = [];
  const roles: string[] = [];
  // Set when teardown starts: an abandoned `run` must not create anything the teardown, which
  // snapshots what exists, would then miss.
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("DATABASE_CLOSED: " + name);
  };
  let outcome: { error: unknown } | undefined;
  try {
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    const client = await owner.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    await run({
      name,
      owner,
      pool(role, max = 8) {
        assertOpen();
        const pool = new pg.Pool({
          connectionString: url.toString(),
          options: "-c role=" + role,
          max,
          ...bounds,
        });
        opened.push(pool);
        return pool;
      },
      async login(options = {}) {
        assertOpen();
        const role = "t8_" + randomUUID().replaceAll("-", "").slice(0, 24);
        const password = randomUUID();
        // Listed first so a teardown that overtakes this statement still drops the role.
        roles.push(role);
        await control.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' ${options.createdb ? "CREATEDB" : ""} IN ROLE ${(options.memberOf ?? ["blink_signer"]).join(", ")}`,
        );
        if (options.ownsDatabase)
          await control.query(`ALTER DATABASE "${name}" OWNER TO "${role}"`);
        // Teardown began while the role was being created: it drops the role, so no pool.
        assertOpen();
        const loginUrl = new URL(url.toString());
        loginUrl.username = role;
        loginUrl.password = password;
        const pool = new pg.Pool({
          connectionString: loginUrl.toString(),
          max: options.max ?? 8,
          ...bounds,
        });
        opened.push(pool);
        return pool;
      },
    });
  } catch (error) {
    outcome = { error };
  }
  closed = true;
  settle(
    outcome,
    await attemptAll(
      [
        ...opened.map((pool, i) => ({
          name: "login pool " + i,
          run: () => pool.end(),
        })),
        { name: "owner pool", run: () => owner.end() },
        ...(created
          ? [
              {
                name: "wait for sessions",
                // pool.end() resolves before the sockets are fully closed: let the sessions
                // leave on their own so DROP ... FORCE never kills a client that is still
                // shutting down.
                run: async () => {
                  for (let i = 0; i < 100; i += 1) {
                    const { rows } = await control.query(
                      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
                      [name],
                    );
                    if (rows[0].n === 0) break;
                    await new Promise((resolve) => setTimeout(resolve, 50));
                  }
                },
              },
              {
                name: "drop database",
                run: () =>
                  control.query(`DROP DATABASE "${name}" WITH (FORCE)`),
              },
            ]
          : []),
        ...roles.map((role) => ({
          name: "drop role " + role,
          run: () => control.query(`DROP ROLE IF EXISTS "${role}"`),
        })),
        { name: "control connection", run: () => control.end() },
      ],
      TEARDOWN_STEP_TIMEOUT_MS,
    ),
  );
}
