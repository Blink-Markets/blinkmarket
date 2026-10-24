import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";
import {
  migrate,
  migrationDirectory,
} from "../packages/adapters/src/migrations.js";
import { createUnitOfWork } from "../packages/adapters/src/database.js";
import type { Pool } from "pg";

test("migration checksums, uint256 precision, runtime grants and append-only audit", async () => {
  const db = new PGlite();
  const client = {
    async query(sql: string, params?: unknown[]) {
      // PGlite uses one session; multi-statement migration scripts use simple-query exec.
      if (params) return db.query<Record<string, unknown>>(sql, params);
      const results = await db.exec(sql);
      return {
        rows: (results.at(-1)?.rows as Record<string, unknown>[]) ?? [],
      };
    },
  };
  try {
    // Every migration file is applied exactly once; adding one must not edit this test.
    const files = (await readdir(migrationDirectory)).filter((f) =>
      f.endsWith(".sql"),
    ).length;
    const first = await migrate(client);
    assert.equal(first.versions.length, files);
    await migrate(client);
    assert.equal(
      (await db.query("SELECT * FROM blink_migrations.applied")).rows.length,
      files,
    );
    await assert.rejects(
      db.query("SELECT $1::blink.uint256", [(2n ** 256n).toString()]),
    );
    await assert.rejects(db.query("SELECT '-1'::blink.uint256"));
    await assert.rejects(db.query("SELECT '1.5'::blink.uint256"));
    assert.equal(
      (
        await db.query<{ v: string }>("SELECT $1::blink.uint256::text AS v", [
          (2n ** 256n - 1n).toString(),
        ])
      ).rows[0]?.v,
      (2n ** 256n - 1n).toString(),
    );
    await db.exec("SET ROLE blink_api");
    await db.exec(
      "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES ('00000000-0000-4000-8000-000000000001','test','test','test','test','test')",
    );
    await assert.rejects(
      db.exec("UPDATE operations.audit_log SET reason='changed'"),
    );
    await assert.rejects(db.exec("DELETE FROM operations.audit_log"));
    await assert.rejects(
      db.exec("CREATE TABLE operations.forbidden(id integer)"),
    );
    await assert.rejects(db.exec("SELECT * FROM blink_migrations.applied"));
    await db.exec("RESET ROLE");
    await assert.rejects(db.exec("TRUNCATE operations.audit_log"));
    await db.exec("UPDATE blink_migrations.applied SET checksum='bad'");
    await assert.rejects(migrate(client), /CHECKSUM/);
  } finally {
    await db.close();
  }
});
test("UnitOfWork uses the same connection, rolls back and expires its handle", async () => {
  const calls: string[] = [];
  let released = false;
  const client = {
    async query(sql: string) {
      calls.push(sql);
      return { rows: [], command: sql };
    },
    release() {
      released = true;
    },
  };
  const uow = createUnitOfWork({
    async connect() {
      return client;
    },
  } as unknown as Pool);
  let saved: Parameters<typeof uow.client>[0] | undefined;
  await uow.run(async (tx) => {
    saved = tx;
    assert.equal(uow.client(tx), client);
  });
  assert.deepEqual(calls, ["BEGIN", "COMMIT"]);
  assert.ok(released);
  assert.throws(() => uow.client(saved!), /INACTIVE/);
  calls.length = 0;
  await assert.rejects(
    uow.run(async () => {
      throw new Error("failure");
    }),
    /failure/,
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);
});

test("UnitOfWork rejects PostgreSQL's implicit rollback and supports savepoint recovery", async () => {
  const db = new PGlite();
  let releases = 0;
  const client = {
    query: (sql: string) => db.query(sql),
    release: () => {
      releases++;
    },
  };
  const uow = createUnitOfWork({
    connect: async () => client,
  } as unknown as Pool);
  let saved: Parameters<typeof uow.client>[0] | undefined;
  try {
    await db.exec("CREATE TABLE probe (id integer PRIMARY KEY)");
    await assert.rejects(
      uow.run(async (tx) => {
        saved = tx;
        await uow.client(tx).query("INSERT INTO probe VALUES (1)");
        await assert.rejects(
          uow.client(tx).query("INSERT INTO probe VALUES (1)"),
        );
        return "success";
      }),
      /TRANSACTION_NOT_COMMITTED/,
    );
    assert.deepEqual((await db.query("SELECT * FROM probe")).rows, []);
    assert.equal(releases, 1);
    assert.throws(() => uow.client(saved!), /INACTIVE/);

    assert.equal(
      await uow.run(async (tx) => {
        const connection = uow.client(tx);
        await connection.query("INSERT INTO probe VALUES (2)");
        await connection.query("SAVEPOINT recoverable");
        await assert.rejects(connection.query("INSERT INTO probe VALUES (2)"));
        await connection.query("ROLLBACK TO SAVEPOINT recoverable");
        await connection.query("INSERT INTO probe VALUES (3)");
        return "committed";
      }),
      "committed",
    );
    assert.deepEqual((await db.query("SELECT * FROM probe ORDER BY id")).rows, [
      { id: 2 },
      { id: 3 },
    ]);
    assert.equal(releases, 2);
  } finally {
    await db.close();
  }
});

test("0025 retires platform execution objects", async () => {
  const db = new PGlite();
  try {
    await migrate({
      async query(sql: string, params?: unknown[]) {
        if (params) return db.query<Record<string, unknown>>(sql, params);
        if (sql.startsWith("-- P2: retire")) {
          await db.exec(`INSERT INTO operations.jobs(id,type,dedupe_key,payload,state,lease_owner,lease_until,lease_token)
          SELECT gen_random_uuid(),type,type || ':' || state,'{}'::jsonb,state,
            CASE WHEN state='LEASED' THEN 'old-worker' END,
            CASE WHEN state='LEASED' THEN blink.now()+interval '1 hour' END,7
          FROM unnest(ARRAY['tx.dispatch','keeper.finalize','faucet.mint','trader.evaluate','quote.reconcile','evaluation.score']) type
          CROSS JOIN unnest(ARRAY['QUEUED','LEASED','SUCCEEDED']) state`);
        }
        const results = await db.exec(sql);
        return {
          rows: (results.at(-1)?.rows as Record<string, unknown>[]) ?? [],
        };
      },
    });
    assert.deepEqual(
      (
        await db.query(`SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname IN ('signing', 'faucet') OR (schemaname = 'trading' AND tablename IN
      ('quotes','maker_pools','quote_gates','collateral_reservations','reservation_events','mandates','risk_reservations'))`)
      ).rows,
      [],
    );
    const retired = (
      await db.query<{
        state: string;
        last_error_code: string;
        lease_owner: string | null;
        lease_until: string | null;
        lease_token: string;
      }>(
        "SELECT state,last_error_code,lease_owner,lease_until,lease_token::text FROM operations.jobs WHERE type<>'evaluation.score' AND state<>'SUCCEEDED'",
      )
    ).rows;
    assert.equal(retired.length, 10);
    for (const job of retired)
      assert.deepEqual(job, {
        state: "DEAD",
        last_error_code: "RETIRED_P2",
        lease_owner: null,
        lease_until: null,
        lease_token: "8",
      });
    assert.equal(
      (await db.query("SELECT * FROM operations.jobs WHERE state='SUCCEEDED'"))
        .rows.length,
      6,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM operations.jobs WHERE type='evaluation.score' AND state IN ('QUEUED','LEASED')",
        )
      ).rows.length,
      2,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT rolname FROM pg_roles WHERE rolname IN ('blink_signer','blink_trading_admin')",
        )
      ).rows,
      [],
    );
  } finally {
    await db.close();
  }
});
