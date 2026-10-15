import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import pg from "pg";
import {
  adminUrl,
  connectionLimits,
  withDatabase,
} from "../helpers/postgres-database.js";

const exists = async (sql: string, name: string) => {
  const control = new pg.Client({ connectionString: adminUrl });
  await control.connect();
  try {
    return (await control.query(sql, [name])).rowCount === 1;
  } finally {
    await control.end();
  }
};
const databaseExists = (name: string) =>
  exists("SELECT 1 FROM pg_database WHERE datname = $1", name);
const roleExists = (name: string) =>
  exists("SELECT 1 FROM pg_roles WHERE rolname = $1", name);

test("real PostgreSQL: a statement timeout cancels a stalled query on every kind of connection", async () => {
  await withDatabase(
    async ({ owner, login }) => {
      const service = await login({ memberOf: ["blink_api"], max: 1 });
      for (const pool of [owner, service]) {
        const started = Date.now();
        await assert.rejects(
          pool.query("SELECT pg_sleep(30)"),
          /statement timeout/,
        );
        assert.ok(Date.now() - started < 5000);
        // The connection is usable again after the cancelled statement.
        assert.equal((await pool.query("SELECT 1 AS one")).rows[0].one, 1);
      }
    },
    { connectTimeoutMs: 2000, statementTimeoutMs: 300 },
  );
});

test("a connection that never answers the handshake fails at the connect timeout", async () => {
  const sockets: Socket[] = [];
  const silent = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { port } = silent.address() as { port: number };
  const pool = new pg.Pool({
    connectionString: `postgresql://nobody@127.0.0.1:${port}/none`,
    ...connectionLimits({ connectTimeoutMs: 300, statementTimeoutMs: 300 }),
  });
  try {
    const started = Date.now();
    await assert.rejects(pool.query("SELECT 1"), /timeout/);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await pool.end();
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => silent.close(resolve));
  }
});

test("real PostgreSQL: a failing pool shutdown still drops the random database and its logins", async () => {
  let database = "";
  let login = "";
  await assert.rejects(
    withDatabase(async (db) => {
      database = db.name;
      const pool = await db.login({ max: 1 });
      login = (await pool.query("SELECT current_user AS name")).rows[0].name;
      const end = pool.end.bind(pool);
      pool.end = async () => {
        await end();
        throw new Error("pool end failed");
      };
    }),
    (error) => {
      assert.ok(error instanceof AggregateError, String(error));
      assert.match(error.message, /pool end failed/);
      return true;
    },
  );
  assert.equal(await databaseExists(database), false);
  assert.equal(await roleExists(login), false);
});

test("real PostgreSQL: the scenario error is preserved when teardown also fails", async () => {
  let database = "";
  await assert.rejects(
    withDatabase(async (db) => {
      database = db.name;
      const pool = await db.login({ max: 1 });
      const end = pool.end.bind(pool);
      pool.end = async () => {
        await end();
        throw new Error("pool end failed");
      };
      throw new Error("scenario failed");
    }),
    (error) => {
      assert.ok(error instanceof AggregateError, String(error));
      assert.equal((error.errors[0] as Error).message, "scenario failed");
      assert.match(error.message, /pool end failed/);
      return true;
    },
  );
  assert.equal(await databaseExists(database), false);
});
