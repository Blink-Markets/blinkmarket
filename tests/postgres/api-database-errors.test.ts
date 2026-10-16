import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildApi } from "../../apps/api/src/server.js";
import { withDatabase } from "../helpers/postgres-database.js";

// What the API's database failures really look like, from a real server and real pools: the
// errors are not made up, they are the ones pg raises.
test(
  "real PostgreSQL: pool exhaustion and a terminated backend are retryable 503s; a statement error stays a 500",
  { timeout: 60_000 },
  async () => {
    await withDatabase(async ({ owner }) => {
      // Built like the RFQ pool: the owner's connection settings, two connections at most (here
      // one, so a single held connection exhausts it), and a short wait for a free one.
      const small = new pg.Pool({
        ...owner.options,
        password: owner.options.password,
        max: 1,
        connectionTimeoutMillis: 200,
      });
      small.on("error", () => undefined);
      let work: () => Promise<unknown> = async () => undefined;
      const app = buildApi({
        services: [
          {
            paths: ["/v1/markets"],
            async handle() {
              await work();
              return { status: 200, body: { items: [], nextCursor: null } };
            },
          },
        ],
      });
      app.log.level = "silent";
      try {
        assert.equal((await app.inject("/v1/markets")).statusCode, 200);

        // Pool exhausted: the only connection is busy for longer than the wait.
        const held = await small.connect();
        work = () => small.query("SELECT 1");
        const exhausted = await app.inject("/v1/markets");
        held.release();
        assert.equal(exhausted.statusCode, 503);
        assert.equal(exhausted.json().code, "SERVICE_NOT_READY");
        assert.equal(exhausted.json().retryable, true);
        assert.equal(exhausted.headers["retry-after"], "1");

        // The backend is terminated under a running statement (57P01).
        work = async () => {
          const client = await small.connect();
          try {
            const { rows } = await client.query(
              "SELECT pg_backend_pid() AS pid",
            );
            // The error is taken as a value at once: it arrives while the terminate is awaited.
            const running = client
              .query("SELECT pg_sleep(30)")
              .catch((error: unknown) => error);
            await owner.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
            throw await running;
          } finally {
            client.release(true);
          }
        };
        const terminated = await app.inject("/v1/markets");
        assert.equal(terminated.statusCode, 503);
        assert.equal(terminated.json().retryable, true);
        assert.deepEqual(terminated.json().details, {
          reason: "DATABASE_UNAVAILABLE",
        });

        // A database that is not there at all.
        const absent = new pg.Pool({
          host: "127.0.0.1",
          port: 1,
          connectionTimeoutMillis: 2000,
        });
        work = () => absent.query("SELECT 1");
        const refused = await app.inject("/v1/markets");
        await absent.end();
        assert.equal(refused.statusCode, 503);

        // What a statement did wrong is not the database being away.
        for (const sql of [
          "SELECT 1/0",
          "SELECT * FROM no_such_table",
          "SELECT pg_sleep(5)",
        ]) {
          work = async () => {
            const client = await small.connect();
            try {
              await client.query("SET statement_timeout = 100");
              await client.query(sql);
            } finally {
              client.release(true);
            }
          };
          const failed = await app.inject("/v1/markets");
          assert.equal(failed.statusCode, 500, sql);
          assert.equal(failed.json().code, "INTERNAL_ERROR", sql);
          assert.equal(failed.json().retryable, false, sql);
        }
      } finally {
        await app.close();
        await small.end();
      }
    });
  },
);
