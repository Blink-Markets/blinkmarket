import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { migrate } from "../../packages/adapters/src/migrations.js";
import { withDatabase } from "../helpers/postgres-database.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
import {
  createIdentityService,
  IdentityError,
} from "../../packages/application/src/identity.js";
import type { ProtocolAccount } from "../../packages/schemas/src/index.js";
import { fakeProtocolReader } from "../helpers/protocol-reader.js";
import { fakeSignatureVerifier } from "../helpers/signature-verifier.js";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "TEST_POSTGRES_ADMIN_URL_REQUIRED: dedicated local/CI PostgreSQL with CREATEDB and CREATEROLE privileges",
  );

const challengePath = "/v1/auth/wallet-challenges";
const verifyPath = "/v1/auth/wallet-verifications";

test(
  "real PostgreSQL: concurrent verifications of one challenge issue exactly one key",
  { timeout: 60000 },
  async () => {
    // Never migrate or truncate the supplied DB. Create and drop only our random test DB.
    const name = "blink_m2_" + randomUUID().replaceAll("-", "");
    assert.match(name, /^blink_m2_[a-f0-9]{32}$/);
    const control = new pg.Client({ connectionString: adminUrl });
    await control.connect();
    let created = false;
    const databaseUrl = new URL(adminUrl!);
    databaseUrl.pathname = "/" + name;
    const owner = new pg.Pool({
      connectionString: databaseUrl.toString(),
      max: 2,
    });
    const apiPool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      options: "-c role=blink_api",
      max: 10,
    });
    try {
      await control.query(`CREATE DATABASE "${name}"`);
      created = true;
      const migrationClient = await owner.connect();
      try {
        await migrate(migrationClient);
      } finally {
        migrationClient.release();
      }
      // Public deterministic test keys, never funded and never sent to any RPC.
      const wallet = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
      const bob = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
      const accounts = [wallet, bob].map(
        (a) =>
          ({
            address: a.address,
            registered: true,
            roles: {},
            credit: {},
          }) as ProtocolAccount,
      );
      const service = createIdentityService(
        postgresIdentityStore(apiPool),
        identityCrypto,
        "https://blink.example",
        {
          verifier: fakeSignatureVerifier(),
          reader: fakeProtocolReader({ accounts }),
        },
      );
      const count = async (table: string, where = "true") =>
        Number(
          (
            await owner.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
            )
          ).rows[0]!.n,
        );
      // A refusal arrives as an IdentityError; anything else is a failure of the test.
      const attempt = async (work: Promise<{ status: number }>) =>
        work.then(
          (r) => ({ status: r.status, code: "OK" }),
          (error: unknown) => {
            assert.ok(error instanceof IdentityError, String(error));
            return { status: error.status, code: error.code };
          },
        );
      const challenge = async (signer: typeof wallet) => {
        const c = (
          await service.mutate(challengePath, {
            body: { address: signer.address, action: "issue" },
            requestId: "pg-test",
            clientIp: "127.0.0.1",
          })
        ).body;
        return {
          challengeId: c.challengeId as string,
          signature: await signer.signMessage({ message: c.message as string }),
        };
      };
      const verify = (body: { challengeId: string; signature: string }) =>
        service.mutate(verifyPath, {
          body,
          requestId: "pg-test",
          clientIp: "127.0.0.1",
        });

      // One challenge, eight simultaneous verifications: one key. The others are refused as used,
      // or as out of attempts when more than the budget arrive before the winner commits.
      const single = await challenge(wallet);
      const raced = await Promise.all(
        Array.from({ length: 8 }, () => attempt(verify(single))),
      );
      assert.equal(raced.filter((r) => r.code === "OK").length, 1);
      assert.deepEqual(
        raced
          .filter((r) => r.code !== "OK")
          .filter(
            (r) =>
              r.code !== "WALLET_CHALLENGE_USED" && r.code !== "RATE_LIMITED",
          ),
        [],
      );
      assert.equal(await count("identity.api_keys"), 1);
      assert.equal(await count("identity.agents"), 1);
      assert.equal(await count("identity.wallet_bindings"), 1);
      assert.equal(
        await count("operations.audit_log", "action='identity.key_issued'"),
        1,
      );

      // Four more keys for the same address, issued at once, share the agent.
      const four = await Promise.all(
        Array.from({ length: 4 }, () => challenge(wallet)),
      );
      const fourResults = await Promise.all(
        four.map((c) => attempt(verify(c))),
      );
      assert.deepEqual(
        fourResults.map((r) => r.code),
        ["OK", "OK", "OK", "OK"],
      );
      assert.equal(await count("identity.api_keys"), 5);
      assert.equal(await count("identity.agents"), 1);
      const sixth = await attempt(verify(await challenge(wallet)));
      assert.deepEqual(sixth, { status: 409, code: "KEY_LIMIT_REACHED" });

      // A new address racing three keys at once still gets exactly one agent.
      const trio = await Promise.all(
        Array.from({ length: 3 }, () => challenge(bob)),
      );
      const trioResults = await Promise.all(
        trio.map((c) => attempt(verify(c))),
      );
      assert.equal(trioResults.filter((r) => r.code === "OK").length, 3);
      assert.equal(
        await count(
          "identity.wallet_bindings",
          "address=decode('" + bob.address.slice(2).toLowerCase() + "','hex')",
        ),
        1,
      );
      assert.equal(await count("identity.agents"), 2);
      assert.equal(await count("identity.operators"), 2);

      // Two keys left for bob, then five at once: exactly two more fit.
      const limit = await Promise.all(
        Array.from({ length: 5 }, () => challenge(bob)),
      );
      const limitResults = await Promise.all(
        limit.map((c) => attempt(verify(c))),
      );
      assert.equal(limitResults.filter((r) => r.code === "OK").length, 2);
      assert.equal(
        limitResults.filter((r) => r.code === "KEY_LIMIT_REACHED").length,
        3,
      );

      // The runtime role cannot mint credentials itself; only the SQL functions can.
      await assert.rejects(
        apiPool.query(
          `INSERT INTO identity.api_keys(id,operator_id,agent_id,secret_hash,scopes,expires_at)
          SELECT gen_random_uuid(),operator_id,agent_id,secret_hash,scopes,expires_at FROM identity.api_keys LIMIT 1`,
        ),
        /permission denied/,
      );
      await assert.rejects(
        apiPool.query("UPDATE identity.api_keys SET scopes=ARRAY['admin']"),
        /permission denied/,
      );
    } finally {
      await Promise.all([owner.end(), apiPool.end()]);
      if (created) await control.query(`DROP DATABASE "${name}"`);
      await control.end();
    }
  },
);

// Every database call below is bounded: connections time out, statements (lock waits included)
// are cancelled by the server, and every wait loop has its own deadline. The statement limit
// covers the intentional wait for the challenge to expire (WINDOW_SECONDS) with a wide margin.
const LIMITS = { connectTimeoutMs: 10_000, statementTimeoutMs: 45_000 };
const WINDOW_SECONDS = 8;
const OBSERVE_BLOCKED_MS = 4_000;
const EXPIRY_WAIT_MS = 15_000;
const SETUP_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { status: number; code: string };

// Re-runs `check` until it is true or the deadline passes; false means the deadline passed.
async function eventually(check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

// One try: hold `lock` in an owner transaction, start the verification, and see it blocked behind
// that very session while the challenge is still valid. Only then wait for the challenge to expire
// and release the lock. Returns null when the setup was too slow (the challenge expired before the
// wait was observed): such a try is never evidence, and it is released only after expiry, so it
// leaves no state behind either.
async function tryBehindLock(
  owner: pg.Pool,
  challengeId: string,
  lock: { sql: string; params: unknown[] },
  startVerification: () => Promise<Outcome>,
): Promise<Outcome | null> {
  const expired = async () =>
    (
      await owner.query<{ ok: boolean }>(
        "SELECT clock_timestamp() >= expires_at AS ok FROM identity.wallet_challenges WHERE id = $1",
        [challengeId],
      )
    ).rows[0]!.ok;
  await owner.query(
    `UPDATE identity.wallet_challenges c
    SET issued_at = t.t - interval '${300 - WINDOW_SECONDS} seconds',
        expires_at = t.t + interval '${WINDOW_SECONDS} seconds'
    FROM (SELECT clock_timestamp() AS t) t WHERE c.id = $1`,
    [challengeId],
  );
  const holder = await owner.connect();
  let pending: Promise<Outcome> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    await holder.query(lock.sql, lock.params);
    pending = startVerification();
    // A backend waiting on a lock, blocked by exactly the holder session.
    const blocked = await eventually(
      async () =>
        (
          await owner.query<{ ok: boolean }>(
            `SELECT count(*) > 0 AS ok FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))`,
            [pid],
          )
        ).rows[0]!.ok,
      OBSERVE_BLOCKED_MS,
    );
    // Validity is asserted once, right after the wait was seen.
    const valid = blocked && !(await expired());
    // Either way the lock is released only after expiry.
    assert.ok(
      await eventually(expired, EXPIRY_WAIT_MS),
      "the challenge did not expire in time",
    );
    await holder.query("COMMIT");
    const outcome = await pending;
    return valid ? outcome : null;
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    // Settle the verification whatever happened above, now that the holder is gone.
    await pending?.catch(() => undefined);
  }
}

async function behindLock(
  owner: pg.Pool,
  makeAttempt: () => Promise<{
    challengeId: string;
    lock: { sql: string; params: unknown[] };
    start: () => Promise<Outcome>;
  }>,
) {
  for (let attempt = 0; attempt < SETUP_ATTEMPTS; attempt++) {
    const a = await makeAttempt();
    const outcome = await tryBehindLock(owner, a.challengeId, a.lock, a.start);
    if (outcome) return outcome;
  }
  throw new Error("SETUP_TOO_SLOW: the lock wait was never seen before expiry");
}

for (const action of ["issue", "revoke"] as const)
  test(
    `real PostgreSQL: a ${action} that waits behind a lock past expiry is refused and changes nothing`,
    { timeout: 120_000 },
    async () => {
      await withDatabase(async ({ owner, pool }) => {
        const wallet = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
        const service = createIdentityService(
          postgresIdentityStore(pool("blink_api", 4)),
          identityCrypto,
          "https://blink.example",
          {
            verifier: fakeSignatureVerifier(),
            reader: fakeProtocolReader({
              accounts: [
                {
                  address: wallet.address,
                  registered: true,
                  roles: {},
                  credit: {},
                } as ProtocolAccount,
              ],
            }),
          },
        );
        const proof = async (
          body: Record<string, unknown>,
        ): Promise<{ challengeId: string; signature: string }> => {
          const c = (
            await service.mutate(challengePath, {
              body: { address: wallet.address, ...body },
              requestId: "pg-test",
              clientIp: "127.0.0.1",
            })
          ).body;
          return {
            challengeId: c.challengeId as string,
            signature: await wallet.signMessage({
              message: c.message as string,
            }),
          };
        };
        const verify = (payload: { challengeId: string; signature: string }) =>
          service
            .mutate(verifyPath, {
              body: payload,
              requestId: "pg-test",
              clientIp: "127.0.0.1",
            })
            .then(
              (r) => ({ status: r.status, code: "OK" }),
              (error: unknown) => {
                assert.ok(error instanceof IdentityError, String(error));
                return { status: error.status, code: error.code };
              },
            );
        const counts = async () =>
          (
            await owner.query<Record<string, string>>(
              `SELECT (SELECT count(*) FROM identity.api_keys)::text AS keys,
              (SELECT count(*) FROM identity.api_keys WHERE revoked_at IS NOT NULL)::text AS revoked,
              (SELECT count(*) FROM identity.operators)::text AS operators,
              (SELECT count(*) FROM identity.agents)::text AS agents,
              (SELECT count(*) FROM identity.wallet_bindings)::text AS bindings,
              (SELECT count(*) FROM identity.wallet_challenges WHERE consumed_at IS NOT NULL)::text AS consumed`,
            )
          ).rows[0]!;
        const expired = { status: 409, code: "WALLET_CHALLENGE_EXPIRED" };

        if (action === "issue") {
          // Issuance serializes per address behind an advisory lock.
          const outcome = await behindLock(owner, async () => {
            const payload = await proof({ action: "issue" });
            return {
              challengeId: payload.challengeId,
              lock: {
                sql: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                params: ["identity.wallet:" + wallet.address.toLowerCase()],
              },
              start: () => verify(payload),
            };
          });
          assert.deepEqual(outcome, expired);
          // No operator, agent, binding or key was written, and nothing was consumed.
          assert.deepEqual(await counts(), {
            keys: "0",
            revoked: "0",
            operators: "0",
            agents: "0",
            bindings: "0",
            consumed: "0",
          });
          return;
        }
        // Revocation waits for the row lock of the key it revokes.
        const issued = await service.mutate(verifyPath, {
          body: await proof({ action: "issue" }),
          requestId: "pg-test",
          clientIp: "127.0.0.1",
        });
        const keyId = issued.body.keyId as string;
        const outcome = await behindLock(owner, async () => {
          const payload = await proof({ action: "revoke", keyId });
          return {
            challengeId: payload.challengeId,
            lock: {
              sql: "SELECT id FROM identity.api_keys WHERE id = $1 FOR UPDATE",
              params: [keyId],
            },
            start: () => verify(payload),
          };
        });
        assert.deepEqual(outcome, expired);
        assert.deepEqual(await counts(), {
          keys: "1",
          revoked: "0",
          operators: "1",
          agents: "1",
          bindings: "1",
          consumed: "1",
        });
      }, LIMITS);
    },
  );
