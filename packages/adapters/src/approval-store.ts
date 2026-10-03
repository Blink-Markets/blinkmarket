import type { Pool } from "pg";
import type { ApprovalStore, CreationIntent } from "@blink/ports";
import { DeploymentManifest } from "@blink/schemas";
import { randomUUID } from "node:crypto";
import { createUnitOfWork } from "./database.js";
import { preparationTransaction } from "./preparation-store.js";

export function postgresApprovalStore(pool: Pool): ApprovalStore {
  const uow = createUnitOfWork(pool);
  return {
    run: (work) =>
      uow.run(async (context) => {
        const db = uow.client(context);
        return work({
          ...preparationTransaction(db),
          async evidenceObject(id) {
            const { rows } = await db.query<{ uri: string; hash: string }>(
              "SELECT object_uri AS uri,'0x'||encode(content_hash,'hex') AS hash FROM evidence.records WHERE id=$1",
              [id],
            );
            return rows[0] ?? null;
          },
          async cached(operatorId, scope, key, hash) {
            const { rows } = await db.query(
              `SELECT encode(payload_hash,'hex') AS hash,state,response_status,response
          FROM operations.idempotency_records WHERE operator_id=$1 AND endpoint_scope=$2 AND key=$3`,
              [operatorId, scope, key],
            );
            const row = rows[0];
            if (!row) return null;
            // Return only exact completed responses; the final claim handles conflicts/busy cases.
            if (row.hash !== hash || row.state !== "COMPLETED") {
              const code =
                row.hash !== hash
                  ? "IDEMPOTENCY_CONFLICT"
                  : "REQUEST_IN_PROGRESS";
              return {
                status: 409,
                body: {
                  code,
                  message: code,
                  retryable: code === "REQUEST_IN_PROGRESS",
                  details: {},
                },
              };
            }
            return {
              status: row.response_status as number,
              body: row.response as Record<string, unknown>,
            };
          },
          async deployment(id) {
            const { rows } = await db.query(
              `SELECT manifest,enabled,
          (SELECT max(verified_at) FROM markets.deployment_checks WHERE deployment_id=d.id) AS verified_at
          FROM markets.deployments d WHERE id=$1 FOR SHARE`,
              [id],
            );
            const row = rows[0];
            if (!row || !row.verified_at) return null;
            return {
              manifest: DeploymentManifest.parse(row.manifest),
              enabled: row.enabled as boolean,
              verifiedAt: new Date(row.verified_at as string),
            };
          },
          async reserveSlot(slot, canonical, intentId) {
            const result = await db.query(
              `INSERT INTO markets.active_slots(slot_key,canonical_key,intent_id)
          VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING slot_key`,
              [slot, canonical, intentId],
            );
            return result.rows.length === 1;
          },
          async saveApproval(w) {
            await db.query(
              "INSERT INTO markets.specs(hash,object_uri,public_uri) VALUES (decode($1,'hex'),$2,$3) ON CONFLICT DO NOTHING",
              [w.specHash.slice(2), w.objectUri, w.publicUri],
            );
            await db.query(
              `INSERT INTO markets.approvals(id,candidate_id,revision,deployment_id,spec_hash,actor_key_id,budget_micros,reason)
          VALUES ($1,$2,$3,$4,decode($5,'hex'),$6,$7,$8)`,
              [
                w.approvalId,
                w.candidateId,
                w.revision,
                w.deploymentId,
                w.specHash.slice(2),
                w.actorKeyId,
                w.budgetMicros,
                w.reason,
              ],
            );
            await db.query(
              "INSERT INTO markets.creation_intents(id,approval_id,state,payload) VALUES ($1,$2,'AWAITING_ADMIN_SIGNATURE',$3)",
              [w.intent.creationIntentId, w.approvalId, w.intent],
            );
            await db.query(
              `INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload)
          VALUES ($1,'market.creation_requested',$2,1,$3)`,
              [
                randomUUID(),
                w.intent.creationIntentId,
                {
                  creationIntentId: w.intent.creationIntentId,
                  approvalId: w.approvalId,
                },
              ],
            );
          },
          async intent(id) {
            const { rows } = await db.query<{ payload: CreationIntent }>(
              "SELECT payload FROM markets.creation_intents WHERE id=$1",
              [id],
            );
            return rows[0]?.payload ?? null;
          },
          async spec(hash) {
            const { rows } = await db.query<{ objectUri: string }>(
              "SELECT object_uri AS \"objectUri\" FROM markets.specs WHERE hash=decode($1,'hex')",
              [hash.slice(2)],
            );
            return rows[0] ?? null;
          },
        });
      }),
  };
}
