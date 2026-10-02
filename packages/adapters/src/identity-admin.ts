import type { Pool } from "pg";
import { IdentityInvitation, type ApiScope } from "@blink/schemas";
import { createUnitOfWork } from "./database.js";
import { identityCrypto as crypto } from "./identity-crypto.js";

// Offline administrative boundary. The runtime API role cannot execute these writes.
export function identityAdmin(pool: Pool) {
  const uow = createUnitOfWork(pool);
  async function issue(
    tx: Parameters<typeof uow.client>[0],
    agentId: string,
    scopes: ApiScope[],
    days: number,
    reason: string,
  ) {
    const client = uow.client(tx);
    const agent = await client.query<{ operator_id: string }>(
      "SELECT operator_id FROM identity.agents WHERE id=$1",
      [agentId],
    );
    if (!agent.rows[0]) throw new Error("AGENT_NOT_FOUND");
    const keyId = crypto.id();
    const secret = crypto.nonce();
    const { rows } = await client.query<{ expires_at: Date }>(
      `INSERT INTO identity.api_keys
      (id,operator_id,agent_id,secret_hash,scopes,expires_at)
      VALUES ($1,$2,$3,decode($4,'hex'),$5,clock_timestamp()+$6*interval '1 day') RETURNING expires_at`,
      [
        keyId,
        agent.rows[0].operator_id,
        agentId,
        crypto.hash(secret),
        [...new Set(scopes)],
        days,
      ],
    );
    await client.query(
      `INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id)
      VALUES ($1,current_user,'identity.key_issued',$2,$3,$4)`,
      [crypto.id(), keyId, reason, crypto.id()],
    );
    return {
      operatorId: agent.rows[0].operator_id,
      agentId,
      keyId,
      expiresAt: rows[0]!.expires_at,
      apiKey: `blink_${keyId}.${secret}`,
    };
  }
  return {
    async invite(input: unknown) {
      const parsed = IdentityInvitation.parse(input);
      return uow.run(async (tx) => {
        const operatorId = crypto.id();
        const agentId = crypto.id();
        await uow
          .client(tx)
          .query("INSERT INTO identity.operators(id,name) VALUES ($1,$2)", [
            operatorId,
            parsed.operatorName,
          ]);
        await uow
          .client(tx)
          .query(
            "INSERT INTO identity.agents(id,operator_id,name) VALUES ($1,$2,$3)",
            [agentId, operatorId, parsed.agentName],
          );
        return issue(
          tx,
          agentId,
          parsed.scopes,
          parsed.lifetimeDays,
          parsed.reason,
        );
      });
    },
    async issue(agentId: string, input: unknown) {
      const parsed = IdentityInvitation.omit({
        operatorName: true,
        agentName: true,
      }).parse(input);
      return uow.run((tx) =>
        issue(tx, agentId, parsed.scopes, parsed.lifetimeDays, parsed.reason),
      );
    },
    async revoke(keyId: string, reason: string) {
      IdentityInvitation.shape.reason.parse(reason);
      return uow.run(async (tx) => {
        const result = await uow.client(tx).query(
          `UPDATE identity.api_keys SET revoked_at=clock_timestamp()
          WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
          [keyId],
        );
        if (result.rows.length)
          await uow.client(tx).query(
            `INSERT INTO operations.audit_log
          (id,actor,action,resource,reason,request_id) VALUES ($1,current_user,'identity.key_revoked',$2,$3,$4)`,
            [crypto.id(), keyId, reason, crypto.id()],
          );
        return { revoked: result.rows.length === 1 };
      });
    },
  };
}
