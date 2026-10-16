import { assertRuntimeRole } from "./runtime-role.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ArtifactRecord,
  AttemptRecord,
  DispatchStore,
  DispatchTransaction,
  Hex,
  IntentRecord,
  SignerStore,
  SignerTransaction,
  SigningIntentWriter,
  SigningSqlClient,
  SignRequestRecord,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";

type Row = Record<string, unknown>;
// bytea and numeric columns are read as hex and decimal text so no driver conversion is relied on.
const hexOf = (column: string, alias: string) =>
  `'0x' || encode(${column}, 'hex') AS ${alias}`;
const bytes = (value: string) => value.replace(/^0x/, "");

const intentColumns = `id, deployment_id, kind, role, payload, state`;
const intentOf = (row: Row): IntentRecord => ({
  id: String(row.id),
  deploymentId: String(row.deployment_id),
  kind: row.kind as IntentRecord["kind"],
  role: row.role as IntentRecord["role"],
  payload: row.payload as Record<string, unknown>,
  state: row.state as IntentRecord["state"],
});
const requestColumns = `id, intent_id, artifact_version, role, ${hexOf("request_hash", "request_hash")}, unsigned_payload, policy_version, state, reject_code`;
const requestOf = (row: Row): SignRequestRecord => ({
  id: String(row.id),
  intentId: String(row.intent_id),
  artifactVersion: Number(row.artifact_version),
  role: row.role as SignRequestRecord["role"],
  requestHash: row.request_hash as Hex,
  unsignedPayload: row.unsigned_payload as Record<string, unknown>,
  policyVersion: String(row.policy_version),
  state: row.state as SignRequestRecord["state"],
  rejectCode: (row.reject_code as string | null) ?? null,
});
const artifactColumns = `a.id, a.sign_request_id, r.artifact_version, ${hexOf("a.artifact_hash", "artifact_hash")}, a.signature, a.raw_transaction, a.max_cost_wei::text AS max_cost_wei, a.created_at`;
const artifactOf = (row: Row): ArtifactRecord => ({
  id: String(row.id),
  signRequestId: String(row.sign_request_id),
  artifactVersion: Number(row.artifact_version),
  artifactHash: row.artifact_hash as Hex,
  signature: (row.signature as Hex | null) ?? null,
  rawTransaction: (row.raw_transaction as Hex | null) ?? null,
  maxCostWei:
    row.max_cost_wei == null ? null : BigInt(String(row.max_cost_wei)),
  createdAt: new Date(row.created_at as string | Date),
});
const attemptColumns = `id, intent_id, artifact_id, ${hexOf("tx_hash", "tx_hash")}, nonce::text AS nonce, replacement_of, gas_limit::text AS gas_limit, max_fee_per_gas::text AS max_fee_per_gas, max_priority_fee_per_gas::text AS max_priority_fee_per_gas, max_cost_wei::text AS max_cost_wei, status, ${hexOf("receipt_block_hash", "receipt_block_hash")}, receipt_block_number::text AS receipt_block_number, receipt_status, gas_reserved_wei::text AS gas_reserved_wei, gas_spent_wei::text AS gas_spent_wei, submitted_at, version`;
const attemptOf = (row: Row): AttemptRecord => ({
  id: String(row.id),
  intentId: String(row.intent_id),
  artifactId: String(row.artifact_id),
  txHash: row.tx_hash as Hex,
  nonce: BigInt(String(row.nonce)),
  replacementOf: (row.replacement_of as string | null) ?? null,
  gasLimit: BigInt(String(row.gas_limit)),
  maxFeePerGas: BigInt(String(row.max_fee_per_gas)),
  maxPriorityFeePerGas: BigInt(String(row.max_priority_fee_per_gas)),
  maxCostWei: BigInt(String(row.max_cost_wei)),
  status: row.status as AttemptRecord["status"],
  receiptBlockHash: (row.receipt_block_hash as Hex | null) ?? null,
  receiptBlockNumber:
    row.receipt_block_number == null
      ? null
      : BigInt(String(row.receipt_block_number)),
  receiptStatus: (row.receipt_status as "success" | "reverted" | null) ?? null,
  gasReservedWei: BigInt(String(row.gas_reserved_wei)),
  gasSpentWei: BigInt(String(row.gas_spent_wei)),
  submittedAt:
    row.submitted_at == null
      ? null
      : new Date(row.submitted_at as string | Date),
  version: Number(row.version),
});

export function signingIntentWriter(): SigningIntentWriter {
  return {
    async createIntent(client, input) {
      // The payload hash is taken over PostgreSQL's normalized jsonb text, so key order and
      // whitespace in the caller's JSON cannot change it.
      const payload = JSON.stringify(input.payload);
      const inserted = await client.query(
        `INSERT INTO signing.economic_intents(id, deployment_id, kind, role, dedupe_key, payload, payload_hash, created_by)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, sha256(convert_to($6::jsonb::text, 'UTF8')), $7)
        ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [
          randomUUID(),
          input.deploymentId,
          input.kind,
          input.role,
          input.dedupeKey,
          payload,
          input.createdBy,
        ],
      );
      if (inserted.rows[0])
        return { intentId: String(inserted.rows[0].id), created: true };
      // The key was used before: only an identical economic intent may reuse it.
      const { rows } = await client.query(
        `SELECT id, deployment_id = $2 AND kind = $3 AND role = $4 AND payload = $5::jsonb AS same
        FROM signing.economic_intents WHERE dedupe_key = $1`,
        [input.dedupeKey, input.deploymentId, input.kind, input.role, payload],
      );
      if (rows[0]?.same !== true) throw new Error("INTENT_DEDUPE_CONFLICT");
      return { intentId: String(rows[0].id), created: false };
    },
    async createSignRequest(client, input) {
      const requestHash = bytes(input.requestHash);
      const version = input.artifactVersion ?? 1;
      const inserted = await client.query(
        `INSERT INTO signing.sign_requests(id, intent_id, artifact_version, role, request_hash, unsigned_payload, policy_version)
        VALUES ($1, $2, $3, $4, decode($5, 'hex'), $6::jsonb, $7)
        ON CONFLICT (role, intent_id, artifact_version) DO NOTHING RETURNING id`,
        [
          randomUUID(),
          input.intentId,
          version,
          input.role,
          requestHash,
          JSON.stringify(input.unsignedPayload),
          input.policyVersion,
        ],
      );
      if (inserted.rows[0])
        return { signRequestId: String(inserted.rows[0].id) };
      const { rows } = await client.query(
        `SELECT id, request_hash = decode($4, 'hex') AND unsigned_payload = $5::jsonb AS same
        FROM signing.sign_requests WHERE role = $1 AND intent_id = $2 AND artifact_version = $3`,
        [
          input.role,
          input.intentId,
          version,
          requestHash,
          JSON.stringify(input.unsignedPayload),
        ],
      );
      if (rows[0]?.same !== true) throw new Error("SIGN_REQUEST_CONFLICT");
      return { signRequestId: String(rows[0].id) };
    },
  };
}

function signerTransaction(client: PoolClient): SignerTransaction {
  const q = async (sql: string, params?: unknown[]) =>
    (await client.query(sql, params)).rows as Row[];
  // One business-clock reading per transaction: the artifact timestamp and the gas day agree.
  let now: Date | undefined;
  const clock = async () =>
    (now ??= new Date(
      (await q("SELECT blink.now() AS now"))[0]!.now as string | Date,
    ));
  const gasDay = async () => (await clock()).toISOString().slice(0, 10);
  return {
    client,
    async lockSignRequest(id) {
      const rows = await q(
        `SELECT ${requestColumns} FROM signing.sign_requests WHERE id = $1 FOR UPDATE`,
        [id],
      );
      return rows[0] ? requestOf(rows[0]) : null;
    },
    async lockIntent(id) {
      const rows = await q(
        `SELECT ${intentColumns} FROM signing.economic_intents WHERE id = $1 FOR UPDATE`,
        [id],
      );
      return rows[0] ? intentOf(rows[0]) : null;
    },
    async artifactOf(signRequestId) {
      const rows = await q(
        `SELECT ${artifactColumns} FROM signing.artifacts a JOIN signing.sign_requests r ON r.id = a.sign_request_id
        WHERE a.sign_request_id = $1`,
        [signRequestId],
      );
      return rows[0] ? artifactOf(rows[0]) : null;
    },
    async signedVersions(intentId) {
      const rows = await q(
        `SELECT ${artifactColumns}, r.unsigned_payload FROM signing.artifacts a
        JOIN signing.sign_requests r ON r.id = a.sign_request_id
        WHERE r.intent_id = $1 ORDER BY r.artifact_version`,
        [intentId],
      );
      return rows.map((row) => ({
        ...artifactOf(row),
        unsignedPayload: row.unsigned_payload as Record<string, unknown>,
      }));
    },
    async deploymentEnabled(deploymentId) {
      const rows = await q(
        "SELECT enabled FROM markets.deployments WHERE id = $1",
        [deploymentId],
      );
      return rows[0]?.enabled === true;
    },
    async market(deploymentId, marketId) {
      const rows = await q(
        `SELECT state, close_at::text AS close_at, ${hexOf("spec_hash", "spec_hash")}
        FROM chain.markets WHERE deployment_id = $1 AND market_id = $2::numeric`,
        [deploymentId, marketId.toString()],
      );
      const row = rows[0];
      return row
        ? {
            state: String(row.state),
            closeAt: BigInt(String(row.close_at)),
            specHash: row.spec_hash as Hex,
          }
        : null;
    },
    async makerEpoch(deploymentId) {
      const rows = await q(
        "SELECT epoch::text AS epoch FROM chain.maker_state WHERE deployment_id = $1",
        [deploymentId],
      );
      return rows[0] ? BigInt(String(rows[0].epoch)) : null;
    },
    async lockSender(chainId, sender) {
      await q(
        `INSERT INTO signing.sender_guards(chain_id, sender) VALUES ($1, decode($2, 'hex')) ON CONFLICT DO NOTHING`,
        [chainId, bytes(sender)],
      );
      await q(
        `SELECT 1 FROM signing.sender_guards WHERE chain_id = $1 AND sender = decode($2, 'hex') FOR UPDATE`,
        [chainId, bytes(sender)],
      );
    },
    async allocationOf(intentId) {
      const rows = await q(
        "SELECT nonce::text AS nonce FROM signing.nonce_allocations WHERE intent_id = $1",
        [intentId],
      );
      return rows[0] ? BigInt(String(rows[0].nonce)) : null;
    },
    async maxAllocatedNonce(chainId, sender) {
      const rows = await q(
        `SELECT max(nonce)::text AS nonce FROM signing.nonce_allocations WHERE chain_id = $1 AND sender = decode($2, 'hex')`,
        [chainId, bytes(sender)],
      );
      return rows[0]?.nonce == null ? null : BigInt(String(rows[0].nonce));
    },
    async allocateNonce({ chainId, sender, nonce, intentId }) {
      await q(
        `INSERT INTO signing.nonce_allocations(chain_id, sender, nonce, intent_id) VALUES ($1, decode($2, 'hex'), $3::numeric, $4)`,
        [chainId, bytes(sender), nonce.toString(), intentId],
      );
    },
    async gasUsage(role) {
      const day = await gasDay();
      await q(
        "INSERT INTO signing.gas_spend(role, day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING",
        [role, day],
      );
      const rows = await q(
        `SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend
        WHERE role = $1 AND day = $2::date FOR UPDATE`,
        [role, day],
      );
      return {
        reservedWei: BigInt(String(rows[0]!.reserved)),
        spentWei: BigInt(String(rows[0]!.spent)),
      };
    },
    async insertPlan(plan, role) {
      const createdAt = await clock();
      const day = await gasDay();
      await q(
        `INSERT INTO signing.signing_plans(sign_request_id, intent_id, sender, nonce, gas_limit, max_fee_per_gas,
          max_priority_fee_per_gas, l1_fee_wei, max_cost_wei, created_at)
        VALUES ($1, $2, decode($3, 'hex'), $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10)`,
        [
          plan.signRequestId,
          plan.intentId,
          bytes(plan.sender),
          plan.nonce.toString(),
          plan.gasLimit.toString(),
          plan.maxFeePerGas.toString(),
          plan.maxPriorityFeePerGas.toString(),
          plan.l1FeeWei.toString(),
          plan.maxCostWei.toString(),
          createdAt,
        ],
      );
      await q(
        "INSERT INTO signing.gas_spend(role, day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING",
        [role, day],
      );
      await q(
        `UPDATE signing.gas_spend SET reserved_wei = reserved_wei + $3::numeric WHERE role = $1 AND day = $2::date`,
        [role, day, plan.maxCostWei.toString()],
      );
      return { ...plan, createdAt };
    },
    async planOf(signRequestId) {
      const rows = await q(
        `SELECT sign_request_id, intent_id, ${hexOf("sender", "sender")}, nonce::text AS nonce, gas_limit::text AS gas_limit,
          max_fee_per_gas::text AS max_fee_per_gas, max_priority_fee_per_gas::text AS max_priority_fee_per_gas,
          l1_fee_wei::text AS l1_fee_wei, max_cost_wei::text AS max_cost_wei, created_at
        FROM signing.signing_plans WHERE sign_request_id = $1`,
        [signRequestId],
      );
      const row = rows[0];
      return row
        ? {
            signRequestId: String(row.sign_request_id),
            intentId: String(row.intent_id),
            sender: row.sender as Hex,
            nonce: BigInt(String(row.nonce)),
            gasLimit: BigInt(String(row.gas_limit)),
            maxFeePerGas: BigInt(String(row.max_fee_per_gas)),
            maxPriorityFeePerGas: BigInt(String(row.max_priority_fee_per_gas)),
            l1FeeWei: BigInt(String(row.l1_fee_wei)),
            maxCostWei: BigInt(String(row.max_cost_wei)),
            createdAt: new Date(row.created_at as string | Date),
          }
        : null;
    },
    async releasePlan(plan, role) {
      await q(
        `UPDATE signing.gas_spend SET reserved_wei = GREATEST(reserved_wei - $3::numeric, 0) WHERE role = $1 AND day = $2::date`,
        [
          role,
          plan.createdAt.toISOString().slice(0, 10),
          plan.maxCostWei.toString(),
        ],
      );
    },
    async insertArtifact(input) {
      await q(
        `INSERT INTO signing.artifacts(id, sign_request_id, artifact_hash, signature, raw_transaction, max_cost_wei, created_at)
        VALUES ($1, $2, decode($3, 'hex'), $4, $5, $6::numeric, $7)`,
        [
          input.id,
          input.signRequestId,
          bytes(input.artifactHash),
          input.signature,
          input.rawTransaction,
          input.maxCostWei === null ? null : input.maxCostWei.toString(),
          await clock(),
        ],
      );
    },
    async markSigned(signRequestId, intentId) {
      await q(
        `UPDATE signing.sign_requests SET state = 'SIGNED', updated_at = clock_timestamp() WHERE id = $1 AND state = 'REQUESTED'`,
        [signRequestId],
      );
      await q(
        `UPDATE signing.economic_intents SET state = 'SIGNED', updated_at = clock_timestamp(), version = version + 1
        WHERE id = $1 AND state IN ('PREPARED','UNKNOWN')`,
        [intentId],
      );
    },
    async markRejected(signRequestId, code) {
      await q(
        `UPDATE signing.sign_requests SET state = 'REJECTED', reject_code = $2, updated_at = clock_timestamp()
        WHERE id = $1 AND state = 'REQUESTED'`,
        [signRequestId, code],
      );
    },
    async audit({ actor, action, resource, reason, requestId }) {
      await q(
        `INSERT INTO operations.audit_log(id, actor, action, resource, reason, request_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), actor, action, resource, reason, requestId],
      );
    },
  };
}

export function postgresSignerStore(pool: Pool): SignerStore {
  const uow = createUnitOfWork(pool);
  return {
    run: (work) => uow.run((tx) => work(signerTransaction(uow.client(tx)))),
    async loadDeployment(deploymentId) {
      const { rows } = await pool.query(
        "SELECT manifest, enabled FROM markets.deployments WHERE id = $1",
        [deploymentId],
      );
      const row = rows[0];
      return row
        ? { manifest: row.manifest, enabled: row.enabled === true }
        : null;
    },
  };
}

function dispatchTransaction(client: PoolClient): DispatchTransaction {
  const q = async (sql: string, params?: unknown[]) =>
    (await client.query(sql, params)).rows as Row[];
  const writer = signingIntentWriter();
  return {
    async snapshot(intentId) {
      const intents = await q(
        `SELECT ${intentColumns} FROM signing.economic_intents WHERE id = $1 FOR UPDATE`,
        [intentId],
      );
      if (!intents[0]) return null;
      const requests = await q(
        `SELECT ${requestColumns} FROM signing.sign_requests WHERE intent_id = $1 ORDER BY artifact_version`,
        [intentId],
      );
      const artifacts = await q(
        `SELECT ${artifactColumns} FROM signing.artifacts a JOIN signing.sign_requests r ON r.id = a.sign_request_id
        WHERE r.intent_id = $1 ORDER BY r.artifact_version`,
        [intentId],
      );
      const attempts = await q(
        // Version order: the newest signed version is last.
        `SELECT ${attemptColumns} FROM signing.tx_attempts t WHERE t.intent_id = $1 ORDER BY
          (SELECT r.artifact_version FROM signing.artifacts a JOIN signing.sign_requests r ON r.id = a.sign_request_id
          WHERE a.id = t.artifact_id)`,
        [intentId],
      );
      const now = (await q("SELECT blink.now() AS now"))[0]!.now as
        string | Date;
      return {
        intent: intentOf(intents[0]),
        signRequests: requests.map(requestOf),
        artifacts: artifacts.map(artifactOf),
        attempts: attempts.map(attemptOf),
        now: new Date(now),
      };
    },
    async insertAttempt(a) {
      await q(
        `INSERT INTO signing.tx_attempts(id, intent_id, artifact_id, tx_hash, nonce, replacement_of, gas_limit,
          max_fee_per_gas, max_priority_fee_per_gas, max_cost_wei, gas_reserved_wei, status)
        VALUES ($1, $2, $3, decode($4, 'hex'), $5::numeric, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $10::numeric, 'SIGNED')
        ON CONFLICT DO NOTHING`,
        [
          a.id,
          a.intentId,
          a.artifactId,
          bytes(a.txHash),
          a.nonce.toString(),
          a.replacementOf,
          a.gasLimit.toString(),
          a.maxFeePerGas.toString(),
          a.maxPriorityFeePerGas.toString(),
          a.maxCostWei.toString(),
        ],
      );
    },
    async updateAttempt(id, expectedVersion, patch) {
      const params: unknown[] = [id, expectedVersion, patch.status];
      const sets = ["status = $3"];
      const add = (column: string, cast: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = ${cast.replace("?", "$" + params.length)}`);
      };
      if (patch.receiptBlockHash !== undefined)
        add(
          "receipt_block_hash",
          "decode(?, 'hex')",
          patch.receiptBlockHash === null
            ? null
            : bytes(patch.receiptBlockHash),
        );
      if (patch.receiptBlockNumber !== undefined)
        add(
          "receipt_block_number",
          "?::numeric",
          patch.receiptBlockNumber === null
            ? null
            : patch.receiptBlockNumber.toString(),
        );
      if (patch.receiptStatus !== undefined)
        add("receipt_status", "?", patch.receiptStatus);
      if (patch.gasReservedWei !== undefined)
        add("gas_reserved_wei", "?::numeric", patch.gasReservedWei.toString());
      if (patch.gasSpentWei !== undefined)
        add("gas_spent_wei", "?::numeric", patch.gasSpentWei.toString());
      if (patch.submittedAt === "now") sets.push("submitted_at = blink.now()");
      const rows = await q(
        `UPDATE signing.tx_attempts SET ${sets.join(", ")}, updated_at = clock_timestamp(), version = version + 1
        WHERE id = $1 AND version = $2 RETURNING id`,
        params,
      );
      return rows.length === 1;
    },
    async setIntentState(intentId, state) {
      // A settled or cancelled intent never moves again, whatever a late writer believes.
      await q(
        `UPDATE signing.economic_intents SET state = $2, updated_at = clock_timestamp(), version = version + 1
        WHERE id = $1 AND state <> $2 AND state NOT IN ('FINALIZED', 'FAILED', 'CANCELLED')`,
        [intentId, state],
      );
    },
    async applyGasDelta(artifactId, reservedDelta, spentDelta) {
      if (reservedDelta === 0n && spentDelta === 0n) return;
      const rows = await q(
        `UPDATE signing.gas_spend g
        SET reserved_wei = GREATEST(g.reserved_wei + $2::numeric, 0), spent_wei = GREATEST(g.spent_wei + $3::numeric, 0)
        FROM signing.artifacts a
          JOIN signing.sign_requests r ON r.id = a.sign_request_id
          JOIN signing.signing_plans p ON p.sign_request_id = r.id
        WHERE a.id = $1 AND g.role = r.role AND g.day = (p.created_at AT TIME ZONE 'UTC')::date
        RETURNING g.role`,
        [artifactId, reservedDelta.toString(), spentDelta.toString()],
      );
      if (rows.length !== 1) throw new Error("GAS_RESERVATION_MISSING");
    },
    createSignRequest: (input) =>
      writer.createSignRequest(client as SigningSqlClient, input),
  };
}

export function postgresDispatchStore(pool: Pool): DispatchStore {
  const uow = createUnitOfWork(pool);
  return {
    run: (work) => uow.run((tx) => work(dispatchTransaction(uow.client(tx)))),
  };
}

// The signer must run as an ordinary, non-owner login that belongs to blink_signer and nothing
// else. The authenticated login (session_user) is judged, not just the effective role: a
// privileged connection that merely starts with role=blink_signer can switch back.
export async function assertSignerRuntimeRole(
  client: Pick<PoolClient, "query">,
) {
  await assertRuntimeRole(
    client,
    "blink_signer",
    "UNSAFE_SIGNER_DATABASE_ROLE",
  );
}
