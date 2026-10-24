import { assertRuntimeRole } from "./runtime-role.js";
import type { Pool, PoolClient } from "pg";
import type {
  IdentityStore,
  IdentityTransaction,
  IdentityKey,
  WalletChallenge,
  IdentityResponse,
  KeyIssueOutcome,
  KeyRevokeOutcome,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";

const date = (value: Date | string) =>
  new Date(value instanceof Date ? value.getTime() : value);

export function identityTransaction(client: PoolClient): IdentityTransaction {
  return {
    async now() {
      const { rows } = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      return date(rows[0]!.now);
    },
    async key(id) {
      const { rows } = await client.query<IdentityKey>(
        `
        SELECT id, operator_id AS "operatorId", agent_id AS "agentId",
          encode(secret_hash, 'hex') AS "secretHash", scopes,
          expires_at AS "expiresAt", revoked_at AS "revokedAt"
        FROM identity.api_keys WHERE id=$1 FOR SHARE`,
        [id],
      );
      const key = rows[0];
      return key
        ? {
            ...key,
            expiresAt: date(key.expiresAt),
            revokedAt: key.revokedAt ? date(key.revokedAt) : null,
          }
        : null;
    },
    async claimRequest(operatorId, scope, key, hash) {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [JSON.stringify(["idempotency", operatorId, scope, key])],
      );
      if (!lock.rows[0]!.acquired) return { state: "BUSY" };
      const result = await client.query<{
        payload_hash: string;
        state: string;
        response_status: number;
        response: Record<string, unknown>;
      }>(
        `SELECT encode(payload_hash,'hex') AS payload_hash,state,response_status,response
        FROM operations.idempotency_records WHERE operator_id=$1 AND endpoint_scope=$2 AND key=$3`,
        [operatorId, scope, key],
      );
      const existing = result.rows[0];
      if (existing) {
        if (existing.payload_hash !== hash) return { state: "CONFLICT" };
        if (existing.state !== "COMPLETED") return { state: "BUSY" };
        return {
          state: "DONE",
          result: { status: existing.response_status, body: existing.response },
        };
      }
      await client.query(
        `INSERT INTO operations.idempotency_records
        (operator_id,endpoint_scope,key,payload_hash,state) VALUES ($1,$2,$3,decode($4,'hex'),'IN_PROGRESS')`,
        [operatorId, scope, key, hash],
      );
      return { state: "NEW" };
    },
    async finishRequest(operatorId, scope, key, result: IdentityResponse) {
      await client.query(
        `UPDATE operations.idempotency_records SET state='COMPLETED',response_status=$4,response=$5
        WHERE operator_id=$1 AND endpoint_scope=$2 AND key=$3`,
        [operatorId, scope, key, result.status, result.body],
      );
    },
    async lockAddress(address) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["identity.challenge:" + address.toLowerCase()],
      );
    },
    async pendingChallenges(address) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM identity.wallet_challenges
        WHERE address=decode($1,'hex') AND consumed_at IS NULL AND expires_at > clock_timestamp()`,
        [address.slice(2)],
      );
      return Number(rows[0]!.count);
    },
    async addChallenge(c) {
      await client.query(
        `INSERT INTO identity.wallet_challenges
        (id,address,action,target_key_id,chain_id,origin,nonce_hash,message,issued_at,expires_at)
        VALUES ($1,decode($2,'hex'),$3,$4,84532,$5,decode($6,'hex'),$7,$8,$9)`,
        [
          c.id,
          c.address.slice(2),
          c.action,
          c.targetKeyId,
          c.origin,
          c.nonceHash,
          c.message,
          c.issuedAt,
          c.expiresAt,
        ],
      );
    },
    async challenge(id) {
      const { rows } = await client.query<WalletChallenge>(
        `SELECT id,'0x'||encode(address,'hex') AS address,action,target_key_id AS "targetKeyId",
        origin,encode(nonce_hash,'hex') AS "nonceHash",message,
        issued_at AS "issuedAt",expires_at AS "expiresAt",consumed_at AS "consumedAt"
        FROM identity.wallet_challenges WHERE id=$1 AND action IN ('issue','revoke')`,
        [id],
      );
      const c = rows[0];
      return c
        ? {
            ...c,
            issuedAt: date(c.issuedAt),
            expiresAt: date(c.expiresAt),
            consumedAt: c.consumedAt ? date(c.consumedAt) : null,
          }
        : null;
    },
    async spendAttempt(challengeId, budget) {
      const { rows } = await client.query(
        `UPDATE identity.wallet_challenges SET attempts=attempts+1
        WHERE id=$1 AND action IN ('issue','revoke') AND attempts < $2 RETURNING id`,
        [challengeId, budget],
      );
      return rows.length === 1;
    },
    async issueKey(input): Promise<KeyIssueOutcome> {
      const { rows } = await client.query<{
        status: KeyIssueOutcome["status"];
        keyId: string | null;
        expiresAt: Date | null;
      }>(
        `SELECT out_status AS status, out_key_id AS "keyId", out_expires_at AS "expiresAt"
        FROM identity.issue_self_serve_key($1,$2,decode($3,'hex'),$4,$5,$6)`,
        [
          input.challengeId,
          input.keyId,
          input.secretHash,
          input.operatorId,
          input.agentId,
          input.requestId,
        ],
      );
      const row = rows[0]!;
      return row.status === "OK"
        ? { status: "OK", keyId: row.keyId!, expiresAt: date(row.expiresAt!) }
        : ({ status: row.status } as KeyIssueOutcome);
    },
    async revokeKey(challengeId, requestId): Promise<KeyRevokeOutcome> {
      const { rows } = await client.query<{
        status: KeyRevokeOutcome["status"];
        keyId: string | null;
        revokedAt: Date | null;
      }>(
        `SELECT out_status AS status, out_key_id AS "keyId", out_revoked_at AS "revokedAt"
        FROM identity.revoke_self_serve_key($1,$2)`,
        [challengeId, requestId],
      );
      const row = rows[0]!;
      return row.status === "OK"
        ? { status: "OK", keyId: row.keyId!, revokedAt: date(row.revokedAt!) }
        : ({ status: row.status } as KeyRevokeOutcome);
    },
    async wallet(agentId) {
      const { rows } = await client.query<{ address: string }>(
        "SELECT '0x'||encode(address,'hex') AS address FROM identity.wallet_bindings WHERE agent_id=$1",
        [agentId],
      );
      return rows[0]?.address ?? null;
    },
  };
}

export function postgresIdentityStore(pool: Pool): IdentityStore {
  const uow = createUnitOfWork(pool);
  return {
    run: (work) => uow.run((tx) => work(identityTransaction(uow.client(tx)))),
  };
}

export async function assertIdentityRuntimeRole(
  client: Pick<PoolClient, "query">,
) {
  await assertRuntimeRole(client, "blink_api", "UNSAFE_API_DATABASE_ROLE");
}
