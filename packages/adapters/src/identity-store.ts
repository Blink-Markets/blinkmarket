import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  IdentityStore,
  IdentityTransaction,
  IdentityKey,
  WalletChallenge,
  IdentityResponse,
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
    async lockAgent(id) {
      await client.query(
        "SELECT id FROM identity.agents WHERE id=$1 FOR UPDATE",
        [id],
      );
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
    async pendingChallenges(keyId) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM identity.wallet_challenges
        WHERE key_id=$1 AND consumed_at IS NULL AND expires_at > clock_timestamp()`,
        [keyId],
      );
      return Number(rows[0]!.count);
    },
    async addChallenge(c) {
      await client.query(
        `INSERT INTO identity.wallet_challenges
        (id,key_id,agent_id,address,chain_id,origin,nonce_hash,message,issued_at,expires_at)
        VALUES ($1,$2,$3,decode($4,'hex'),84532,$5,decode($6,'hex'),$7,$8,$9)`,
        [
          c.id,
          c.keyId,
          c.agentId,
          c.address.slice(2),
          c.origin,
          c.nonceHash,
          c.message,
          c.issuedAt,
          c.expiresAt,
        ],
      );
    },
    async challenge(id, keyId, agentId) {
      const { rows } = await client.query<WalletChallenge>(
        `SELECT id,key_id AS "keyId",agent_id AS "agentId",
        '0x'||encode(address,'hex') AS address,origin,encode(nonce_hash,'hex') AS "nonceHash",message,
        issued_at AS "issuedAt",expires_at AS "expiresAt",consumed_at AS "consumedAt"
        FROM identity.wallet_challenges WHERE id=$1 AND key_id=$2 AND agent_id=$3 FOR UPDATE`,
        [id, keyId, agentId],
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
    async consumeChallenge(id) {
      await client.query(
        "UPDATE identity.wallet_challenges SET consumed_at=clock_timestamp() WHERE id=$1",
        [id],
      );
    },
    async bindWallet(agentId, address, challengeId) {
      const { rows } = await client.query(
        `INSERT INTO identity.wallet_bindings(agent_id,chain_id,address,challenge_id)
        VALUES ($1,84532,decode($2,'hex'),$3) ON CONFLICT DO NOTHING RETURNING agent_id`,
        [agentId, address.slice(2), challengeId],
      );
      return rows.length === 1;
    },
    async wallet(agentId) {
      const { rows } = await client.query<{ address: string }>(
        "SELECT '0x'||encode(address,'hex') AS address FROM identity.wallet_bindings WHERE agent_id=$1",
        [agentId],
      );
      return rows[0]?.address ?? null;
    },
    async audit(actor, action, resource, requestId) {
      await client.query(
        `INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id)
        VALUES ($1,$2,$3,$4,'Invited wallet identity binding only',$5)`,
        [randomUUID(), actor, action, resource, requestId],
      );
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
  const { rows } = await client.query<{ allowed: boolean }>(`SELECT
    NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
    AND pg_has_role(current_user, 'blink_api', 'USAGE')
    AND NOT pg_has_role(current_user, 'blink_identity_admin', 'USAGE')
    AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='blink_evidence_admin'
      AND pg_has_role(current_user, oid, 'USAGE'))
    AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='blink_deployment_admin'
      AND pg_has_role(current_user, oid, 'USAGE'))
    AND NOT pg_has_role(current_user, 'blink_indexer', 'USAGE')
    AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('markets','evidence','discovery','chain')
      AND has_schema_privilege(current_user,oid,'CREATE'))
    AND NOT has_schema_privilege(current_user, 'identity', 'CREATE')
    AND NOT has_schema_privilege(current_user, 'operations', 'CREATE') AS allowed
    FROM pg_roles WHERE rolname=current_user`);
  if (rows[0]?.allowed !== true) throw new Error("UNSAFE_API_DATABASE_ROLE");
}
