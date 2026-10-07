import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { CreationChainStatus, DeploymentManifest } from "@blink/schemas";
import type { CreationIntent, CreationTrackerStore } from "@blink/ports";
import { createUnitOfWork } from "./database.js";

export function untrackedCreation(id: string): CreationChainStatus {
  return {
    creationIntentId: id,
    state: "NOT_TRACKED",
    txHash: null,
    marketId: null,
    blockNumber: null,
    blockHash: null,
    headNumber: null,
    headHash: null,
    confirmations: "0",
    requiredConfirmations: 12,
    version: 0,
    observedAt: null,
  };
}
export function postgresCreationTrackerStore(pool: Pool): CreationTrackerStore {
  const uow = createUnitOfWork(pool);
  return {
    load: (id) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const { rows } = await db.query(
          `SELECT i.payload,d.manifest,d.enabled,p.payload AS status
        FROM markets.creation_intents i JOIN markets.deployments d ON d.id=i.payload->>'deploymentId'
        LEFT JOIN chain.creation_projections p ON p.intent_id=i.id WHERE i.id=$1`,
          [id],
        );
        const row = rows[0];
        if (!row) return null;
        if (!row.enabled) throw new Error("DEPLOYMENT_DISABLED");
        return {
          intent: row.payload as CreationIntent,
          manifest: DeploymentManifest.parse(row.manifest),
          status: row.status
            ? CreationChainStatus.parse(row.status)
            : untrackedCreation(id),
        };
      }),
    save: (id, expectedVersion, observation) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const identity = await db.query(
          `SELECT d.id,d.enabled FROM markets.creation_intents i
        JOIN markets.deployments d ON d.id=i.payload->>'deploymentId' WHERE i.id=$1 FOR SHARE OF d`,
          [id],
        );
        const deployment = identity.rows[0];
        if (!deployment?.enabled) throw new Error("DEPLOYMENT_DISABLED");
        await db.query(
          "INSERT INTO chain.creation_projections(intent_id,deployment_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [id, deployment.id, untrackedCreation(id)],
        );
        const existing = await db.query(
          "SELECT version,state,payload FROM chain.creation_projections WHERE intent_id=$1 FOR UPDATE",
          [id],
        );
        const row = existing.rows[0]!;
        if (Number(row.version) !== expectedVersion)
          throw new Error("STALE_CREATION_OBSERVATION");
        const old = CreationChainStatus.parse(row.payload);
        if (old.txHash && old.txHash !== observation.txHash)
          throw new Error("TRACKED_TRANSACTION_CONFLICT");
        const clock = await db.query("SELECT clock_timestamp() AS now");
        const status = CreationChainStatus.parse({
          ...observation,
          creationIntentId: id,
          version: expectedVersion + 1,
          observedAt: new Date(clock.rows[0]!.now as string).toISOString(),
        });
        await db.query(
          "INSERT INTO chain.creation_observations(id,intent_id,version,payload) VALUES($1,$2,$3,$4)",
          [randomUUID(), id, status.version, status],
        );
        await db.query(
          "UPDATE chain.creation_projections SET version=$2,state=$3,market_id=$4,payload=$5,updated_at=clock_timestamp() WHERE intent_id=$1",
          [id, status.version, status.state, status.marketId, status],
        );
        if (
          old.state !== status.state ||
          old.blockHash !== status.blockHash ||
          old.marketId !== status.marketId
        ) {
          await db.query(
            "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,'market.creation_observed',$2,$3,$4)",
            [randomUUID(), id, status.version, status],
          );
          await db.query(
            "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES($1,current_user,'market.creation_observed',$2,$3,$4)",
            [
              randomUUID(),
              id,
              JSON.stringify({
                from: old.state,
                to: status.state,
                txHash: status.txHash,
                headHash: status.headHash,
              }),
              randomUUID(),
            ],
          );
        }
        return status;
      }),
  };
}
