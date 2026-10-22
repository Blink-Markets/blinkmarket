import type { Pool } from "pg";
import {
  SIGNING_POLICY_VERSION,
  canonicalJson,
  TX_DISPATCH_MAX_ATTEMPTS,
  type FaucetStore,
} from "@blink/ports";
import { keccak256, stringToHex } from "viem";
import { DeploymentManifest } from "@blink/schemas";
import { createUnitOfWork } from "./database.js";
import { identityTransaction } from "./identity-store.js";
import { signingIntentWriter } from "./signing-store.js";
import { enqueueJobInTransaction } from "./job-queue.js";

export function postgresFaucetStore(pool: Pool): FaucetStore {
  const uow = createUnitOfWork(pool);
  const writer = signingIntentWriter();
  return {
    run: (work) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        return work({
          ...identityTransaction(db),
          async now() {
            return new Date(
              (await db.query("SELECT blink.now() AS now")).rows[0].now,
            );
          },
          async lockAddress(deploymentId, address) {
            const params = [deploymentId, address.slice(2)];
            // Serialize the wallet across API keys without granting updates on guard keys.
            await db.query(
              "SELECT pg_advisory_xact_lock(hashtextextended(json_build_array($1::text,$2::text)::text,0))",
              params,
            );
            await db.query(
              "INSERT INTO faucet.address_guards VALUES($1,decode($2,'hex')) ON CONFLICT DO NOTHING",
              params,
            );
          },
          async allowed(deploymentId, address) {
            const { rows } = await db.query(
              "SELECT allowed FROM chain.takers WHERE deployment_id=$1 AND account=decode($2,'hex')",
              [deploymentId, address.slice(2)],
            );
            return rows[0]?.allowed === true;
          },
          async window(deploymentId, address) {
            const { rows } = await db.query(
              `WITH stamp AS MATERIALIZED (SELECT blink.now() AS now)
            SELECT COALESCE(bool_or(state IN ('QUEUED','SUBMITTED','UNKNOWN')),false) AS pending,
            COALESCE(ceil(extract(epoch from max(succeeded_at) FILTER (WHERE state='SUCCEEDED') + interval '24 hours' - (SELECT now FROM stamp))),0)::text AS retry
            FROM faucet.claims WHERE deployment_id=$1 AND address=decode($2,'hex')`,
              [deploymentId, address.slice(2)],
            );
            return {
              pending: rows[0].pending === true,
              retryAfterSeconds: Math.max(0, Number(rows[0].retry)),
            };
          },
          async createClaim(input) {
            const { rows } = await db.query(
              "SELECT manifest FROM markets.deployments WHERE id=$1 AND enabled",
              [input.deploymentId],
            );
            const manifest = DeploymentManifest.parse(rows[0]?.manifest);
            const amount = "1000000000";
            const { intentId } = await writer.createIntent(db, {
              deploymentId: input.deploymentId,
              kind: "MINT",
              role: "faucet",
              dedupeKey: "faucet:" + input.claimId,
              payload: { to: input.address, amount },
              createdBy: input.actor,
            });
            const unsignedPayload = {
              to: manifest.contracts.BlinkTestUSD.toLowerCase(),
              functionName: "mint",
              args: [input.address, amount],
            };
            await writer.createSignRequest(db, {
              intentId,
              role: "faucet",
              unsignedPayload,
              requestHash: keccak256(
                stringToHex(canonicalJson(unsignedPayload)),
              ),
              policyVersion: SIGNING_POLICY_VERSION,
            });
            await db.query(
              "INSERT INTO faucet.claims(id,deployment_id,agent_id,address,amount_micros,intent_id,state) VALUES($1,$2,$3,decode($4,'hex'),1000000000,$5,'QUEUED')",
              [
                input.claimId,
                input.deploymentId,
                input.agentId,
                input.address.slice(2),
                intentId,
              ],
            );
            await enqueueJobInTransaction(db, {
              type: "faucet.mint",
              dedupeKey: "faucet.mint:" + input.claimId,
              payload: { claimId: input.claimId },
              maxAttempts: 10,
            });
            return intentId;
          },
        });
      }),
    async mintRequest(claimId) {
      const { rows } = await pool.query(
        `SELECT c.intent_id AS "intentId", r.id AS "signRequestId", '0x'||encode(r.request_hash,'hex') AS "requestHash"
        FROM faucet.claims c JOIN signing.sign_requests r ON r.intent_id=c.intent_id AND r.artifact_version=1
        WHERE c.id=$1 AND c.state IN ('QUEUED','UNKNOWN')`,
        [claimId],
      );
      return rows[0] ?? null;
    },
    signed: (claimId, result) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        await db.query(
          "SELECT id FROM signing.economic_intents WHERE id=(SELECT intent_id FROM faucet.claims WHERE id=$1) FOR UPDATE",
          [claimId],
        );
        const { rows } = await db.query(
          "SELECT intent_id FROM faucet.claims WHERE id=$1 AND state IN ('QUEUED','UNKNOWN') FOR UPDATE",
          [claimId],
        );
        if (!rows[0]) return;
        const intentId = rows[0].intent_id;
        if (result.state === "SIGNED")
          await enqueueJobInTransaction(db, {
            type: "tx.dispatch",
            dedupeKey: "tx.dispatch:" + intentId,
            payload: { intentId },
            maxAttempts: TX_DISPATCH_MAX_ATTEMPTS,
          });
        await db.query(
          "UPDATE faucet.claims SET state=$2,updated_at=blink.now() WHERE id=$1",
          [
            claimId,
            result.state === "SIGNED"
              ? "SUBMITTED"
              : result.state === "REJECTED"
                ? "FAILED"
                : "UNKNOWN",
          ],
        );
        if (result.state === "REJECTED")
          await db.query(
            "UPDATE signing.economic_intents SET state='FAILED',updated_at=blink.now(),version=version+1 WHERE id=$1 AND state IN ('PREPARED','UNKNOWN')",
            [intentId],
          );
      }),
    settle: (intentId, outcome) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        await db.query(
          "SELECT id FROM signing.economic_intents WHERE id=$1 FOR UPDATE",
          [intentId],
        );
        // Hold the observed attempt version until the claim update commits. A racing reorg
        // observer either wins first or settles its newer version after this one.
        if (outcome.attempt) {
          const observed = await db.query(
            "SELECT id FROM signing.tx_attempts WHERE id=$1 AND intent_id=$2 AND version=$3 FOR SHARE",
            [outcome.attempt.id, intentId, outcome.attempt.version],
          );
          if (!observed.rows.length) return;
        }
        await db.query(
          `UPDATE faucet.claims SET state=$2,succeeded_at=$3,updated_at=blink.now()
        WHERE intent_id=$1 AND (state<>$2 OR succeeded_at IS DISTINCT FROM $3::timestamptz)`,
          [intentId, outcome.state, outcome.succeededAt ?? null],
        );
      }),
  };
}
