import { randomUUID } from "node:crypto";
import { keccak256, stringToHex } from "viem";
import type { Pool } from "pg";
import {
  canonicalJson,
  SIGNING_POLICY_VERSION,
  type KeeperStore,
  type KeeperRequest,
} from "@blink/ports";
import { DeploymentManifest } from "@blink/schemas";
import { createUnitOfWork } from "./database.js";
import { signingIntentWriter } from "./signing-store.js";
import { enqueueJobInTransaction } from "./job-queue.js";

export function postgresKeeperStore(pool: Pool): KeeperStore {
  const uow = createUnitOfWork(pool);
  const writer = signingIntentWriter();
  return {
    async candidates(deploymentId) {
      const { rows } = await pool.query(
        `SELECT m.market_id::text, m.state, m.proposed_at::text, m.challenge_seconds, m.hard_deadline::text, c.block_timestamp::text
        FROM chain.markets m JOIN chain.cursors c USING(deployment_id) JOIN markets.deployments d ON d.id=m.deployment_id
        WHERE m.deployment_id=$1 AND m.state<>'FINAL' AND c.gate_reason IS NULL AND d.enabled`,
        [deploymentId],
      );
      return rows.map((r) => ({
        marketId: r.market_id,
        state: r.state,
        proposedAt: r.proposed_at === null ? null : BigInt(r.proposed_at),
        challengeSeconds: BigInt(r.challenge_seconds),
        hardDeadline: BigInt(r.hard_deadline),
        nowChain: BigInt(r.block_timestamp),
      }));
    },
    prepare: (deploymentId, marketId, kind) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const { rows } = await db.query(
          "SELECT manifest FROM markets.deployments WHERE id=$1 AND enabled",
          [deploymentId],
        );
        const manifest = DeploymentManifest.parse(rows[0]?.manifest);
        const { intentId } = await writer.createIntent(db, {
          deploymentId,
          kind,
          role: "keeper",
          dedupeKey: `finalize:${deploymentId}:${marketId}:${kind}`,
          payload: { marketId },
          createdBy: "keeper",
        });
        const unsignedPayload = {
          to: manifest.contracts.BlinkMarket.toLowerCase(),
          functionName:
            kind === "FINALIZE_UNCHALLENGED"
              ? "finalizeUnchallenged"
              : "finalizeTimeout",
          args: [marketId],
        };
        await writer.createSignRequest(db, {
          intentId,
          role: "keeper",
          unsignedPayload,
          requestHash: keccak256(stringToHex(canonicalJson(unsignedPayload))),
          policyVersion: SIGNING_POLICY_VERSION,
        });
      }),
    async pending(deploymentId) {
      const { rows } = await pool.query<KeeperRequest>(
        `SELECT i.id AS "intentId",i.payload->>'marketId' AS "marketId",i.kind,r.id AS "signRequestId",'0x'||encode(r.request_hash,'hex') AS "requestHash"
        FROM signing.economic_intents i JOIN signing.sign_requests r ON r.intent_id=i.id AND r.artifact_version=1
        WHERE i.deployment_id=$1 AND i.role='keeper' AND i.state IN ('PREPARED','UNKNOWN','SIGNED') ORDER BY i.created_at,i.id`,
        [deploymentId],
      );
      return rows;
    },
    cancel: (request) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        // Same lock order as the signer. If UNKNOWN already produced bytes, dispatch those bytes
        // rather than abandoning its allocated nonce (a revert is still a receipt).
        await db.query(
          "SELECT id FROM signing.sign_requests WHERE id=$1 FOR UPDATE",
          [request.signRequestId],
        );
        const { rows } = await db.query(
          "SELECT state FROM signing.economic_intents WHERE id=$1 FOR UPDATE",
          [request.intentId],
        );
        if (
          !rows[0] ||
          !["PREPARED", "UNKNOWN", "SIGNED"].includes(rows[0].state)
        )
          return;
        const artifacts = await db.query(
          "SELECT id FROM signing.artifacts WHERE sign_request_id=$1",
          [request.signRequestId],
        );
        if (artifacts.rows.length) {
          await enqueueJobInTransaction(db, {
            type: "tx.dispatch",
            dedupeKey: "tx.dispatch:" + request.intentId,
            payload: { intentId: request.intentId },
            maxAttempts: 10,
          });
        } else
          await db.query(
            "UPDATE signing.economic_intents SET state='CANCELLED',updated_at=blink.now(),version=version+1 WHERE id=$1",
            [request.intentId],
          );
      }),
    signed: (request, result) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        await db.query(
          "SELECT id FROM signing.economic_intents WHERE id=$1 FOR UPDATE",
          [request.intentId],
        );
        if (result.state === "SIGNED") {
          await enqueueJobInTransaction(db, {
            type: "tx.dispatch",
            dedupeKey: "tx.dispatch:" + request.intentId,
            payload: { intentId: request.intentId },
            maxAttempts: 10,
          });
        } else {
          const changed = await db.query(
            "UPDATE signing.economic_intents SET state=$2,updated_at=blink.now(),version=version+1 WHERE id=$1 AND state IN ('PREPARED','UNKNOWN') RETURNING id",
            [
              request.intentId,
              result.state === "REJECTED" ? "FAILED" : "UNKNOWN",
            ],
          );
          if (
            changed.rows.length > 0 &&
            result.state === "REJECTED" &&
            result.code === "GAS_ESTIMATE_FAILED"
          )
            await db.query(
              "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES($1,'keeper','keeper.manual_required',$2,$3,$4)",
              [
                randomUUID(),
                request.intentId,
                result.code,
                request.signRequestId,
              ],
            );
        }
      }),
  };
}
