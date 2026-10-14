import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/adapters/src/migrations.js";

export const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "TEST_POSTGRES_ADMIN_URL_REQUIRED: dedicated local/CI PostgreSQL with CREATEDB and CREATEROLE privileges",
  );

// Each test creates and drops its own random database; the supplied database is never touched.
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
) {
  const name = "blink_t8_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^blink_t8_[a-f0-9]{32}$/);
  const control = new pg.Client({ connectionString: adminUrl });
  await control.connect();
  let created = false;
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  const owner = new pg.Pool({ connectionString: url.toString(), max: 2 });
  const opened: pg.Pool[] = [];
  const roles: string[] = [];
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
        const pool = new pg.Pool({
          connectionString: url.toString(),
          options: "-c role=" + role,
          max,
        });
        opened.push(pool);
        return pool;
      },
      async login(options = {}) {
        const role = "t8_" + randomUUID().replaceAll("-", "").slice(0, 24);
        const password = randomUUID();
        await control.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' ${options.createdb ? "CREATEDB" : ""} IN ROLE ${(options.memberOf ?? ["blink_signer"]).join(", ")}`,
        );
        roles.push(role);
        if (options.ownsDatabase)
          await control.query(`ALTER DATABASE "${name}" OWNER TO "${role}"`);
        const loginUrl = new URL(url.toString());
        loginUrl.username = role;
        loginUrl.password = password;
        const pool = new pg.Pool({
          connectionString: loginUrl.toString(),
          max: options.max ?? 8,
        });
        opened.push(pool);
        return pool;
      },
    });
  } finally {
    await Promise.all(opened.map((pool) => pool.end()));
    await owner.end();
    if (created) {
      // pool.end() resolves before the sockets are fully closed: let the sessions leave on their
      // own so DROP ... FORCE never kills a client that is still shutting down.
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await control.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
          [name],
        );
        if (rows[0].n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
    for (const role of roles)
      await control.query(`DROP ROLE IF EXISTS "${role}"`);
    await control.end();
  }
}
