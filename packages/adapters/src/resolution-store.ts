import { keccak256 } from "viem";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ResolutionStore, ResolutionTransaction } from "@blink/ports";
import { createUnitOfWork } from "./database.js";
import { identityTransaction } from "./identity-store.js";
/** An evidence object that is missing or corrupt: a per-record problem for an operator, not a failed scan. */
export type EvidenceUnreadableCode =
  | "EVIDENCE_OBJECT_MISSING"
  | "EVIDENCE_HASH_MISMATCH"
  | "EVIDENCE_OBJECT_INVALID";
export class EvidenceUnreadableError extends Error {
  constructor(readonly code: EvidenceUnreadableCode) {
    super(code);
  }
}
export function postgresResolutionStore(pool: Pool): ResolutionStore {
  const uow = createUnitOfWork(pool);
  return {
    run: (work) =>
      uow.run((ctx) => work(resolutionTransaction(uow.client(ctx)))),
  };
}
function resolutionTransaction(db: PoolClient): ResolutionTransaction {
  return {
    ...identityTransaction(db),
    async marketExists(deploymentId, marketId) {
      return (
        (
          await db.query(
            "SELECT 1 FROM chain.markets WHERE deployment_id=$1 AND market_id=$2",
            [deploymentId, marketId],
          )
        ).rows.length === 1
      );
    },
    async evidenceAllowed(ids, operatorId) {
      return (
        (
          await db.query(
            "SELECT id FROM evidence.records WHERE id=ANY($1::uuid[]) AND (access_policy IN ('PUBLIC','EXCERPT') OR operator_id=$2)",
            [ids, operatorId],
          )
        ).rows.length === new Set(ids.map((id) => id.toLowerCase())).size
      );
    },
    async submitReport(id, deploymentId, marketId, principal, input) {
      await db.query(
        "INSERT INTO resolution.reports(id,deployment_id,market_id,agent_id,operator_id,outcome,evidence_ids,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          deploymentId,
          marketId,
          principal.agentId,
          principal.operatorId,
          input.outcome,
          input.evidenceIds,
          input.reason,
        ],
      );
    },
    async reportExists(id) {
      return (
        (await db.query("SELECT id FROM resolution.reports WHERE id=$1", [id]))
          .rows.length === 1
      );
    },
    async appendEvent(id, state, actor, reason) {
      await db.query(
        "INSERT INTO resolution.report_events(id,report_id,state,actor,reason) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), id, state, actor, reason],
      );
    },
    async auditResolution(actor, action, reportId, reason, requestId) {
      await db.query(
        "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), actor, action, reportId, reason, requestId],
      );
    },
    async reports(deploymentId, marketId, state, limit, after) {
      const result = await db.query(
        `SELECT r.id AS "reportId",r.deployment_id AS "deploymentId",r.market_id::text AS "marketId",r.agent_id AS "agentId",r.operator_id AS "operatorId",r.outcome,r.evidence_ids AS "evidenceIds",r.reason,r.created_at AS "createdAt",e.state,e.reason AS "stateReason"
 FROM resolution.reports r JOIN LATERAL (SELECT state,reason FROM resolution.report_events WHERE report_id=r.id ORDER BY sequence DESC LIMIT 1) e ON true
 WHERE r.deployment_id=$1 AND ($2::numeric IS NULL OR r.market_id=$2) AND ($3::text IS NULL OR e.state=$3) AND ($5::uuid IS NULL OR r.id>$5) ORDER BY r.id LIMIT $4`,
        [deploymentId, marketId, state, limit, after],
      );
      return result.rows.map((r) => ({
        ...r,
        createdAt: new Date(r.createdAt).toISOString(),
      }));
    },
  };
}

export function postgresResolutionJobsStore(
  pool: Pool,
): import("@blink/ports").ResolutionJobsStore {
  const uow = createUnitOfWork(pool);
  return {
    async parseEvidence(version, parse, signal) {
      await uow.run(async (ctx) => {
        const db = uow.client(ctx);
        // Serialize periodic scans, including manual-review audit deduplication.
        await db.query("SELECT pg_advisory_xact_lock(84532,14)");
        const { rows } = await db.query<{
          deployment_id: string;
          market_id: string;
          evidence_id: string;
          object_uri: string;
          hash: string;
          threshold_bps: number;
        }>(
          `SELECT DISTINCT m.deployment_id,m.market_id::text,e.id AS evidence_id,e.object_uri,'0x'||encode(e.content_hash,'hex') AS hash,(r.snapshot->>'thresholdBps')::integer AS threshold_bps
 FROM chain.markets m JOIN markets.approvals a ON a.deployment_id=m.deployment_id AND a.spec_hash=m.spec_hash
 JOIN discovery.candidate_revisions r ON r.candidate_id=a.candidate_id AND r.revision=a.revision
 JOIN evidence.sources src ON src.entity_id=r.snapshot->>'entityId'
 JOIN evidence.records e ON e.source_id=src.id
 WHERE m.close_at<=extract(epoch from blink.now()) AND e.observed_at>to_timestamp(m.close_at::double precision)
 AND r.snapshot->>'templateId'='GM_LT_V1'
 AND NOT EXISTS(SELECT 1 FROM resolution.suggestions s WHERE s.deployment_id=m.deployment_id AND s.market_id=m.market_id AND s.evidence_id=e.id AND s.parser_version=$1)
 AND NOT EXISTS(SELECT 1 FROM operations.audit_log l WHERE l.action='resolution.manual_required' AND l.resource=jsonb_build_array(m.deployment_id,m.market_id::text,e.id::text,$1::text)::text)`,
          [version],
        );
        for (const row of rows) {
          signal.throwIfAborted();
          let result;
          try {
            result = await parse({
              uri: row.object_uri,
              hash: row.hash,
              thresholdBps: row.threshold_bps,
            });
          } catch (error) {
            // Only expected per-record read failures are isolated; cancellation and
            // anything unexpected still fail (and roll back) the whole scan.
            if (!(error instanceof EvidenceUnreadableError)) throw error;
            signal.throwIfAborted();
            // Surface once per evidence/code/version; the next scan retries the read.
            await db.query(
              `INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id)
 SELECT $1::uuid,'resolution.parse','resolution.evidence_unreadable',jsonb_build_array($2::text,$3::text,$4::text)::text,$3,'resolution.parse'
 WHERE NOT EXISTS(SELECT 1 FROM operations.audit_log WHERE action='resolution.evidence_unreadable' AND resource=jsonb_build_array($2::text,$3::text,$4::text)::text)`,
              [randomUUID(), row.evidence_id, error.code, version],
            );
            continue;
          }
          signal.throwIfAborted();
          if ("ambiguous" in result) {
            await db.query(
              "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES($1,'resolution.parse','resolution.manual_required',jsonb_build_array($2::text,$3::text,$4::text,$5::text)::text,$6,'resolution.parse')",
              [
                randomUUID(),
                row.deployment_id,
                row.market_id,
                row.evidence_id,
                version,
                result.reason,
              ],
            );
          } else {
            await db.query(
              "INSERT INTO resolution.suggestions(id,deployment_id,market_id,evidence_id,value_bps,outcome,locator,parser_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
              [
                randomUUID(),
                row.deployment_id,
                row.market_id,
                row.evidence_id,
                result.valueBps,
                result.outcome,
                result.locator,
                version,
              ],
            );
          }
        }
      });
    },
    async alertDeadlines(thresholds, signal) {
      await uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const { rows } = await db.query<{
          deployment_id: string;
          market_id: string;
          mode: "LIVE" | "REPLAY";
          kind: string;
          deadline: string;
          remaining: string;
        }>(`WITH deadlines AS (
 SELECT deployment_id,market_id,mode,'HARD_DEADLINE' AS kind,hard_deadline AS deadline FROM chain.markets WHERE state<>'FINAL'
 UNION ALL SELECT deployment_id,market_id,mode,'CHALLENGE_END',proposed_at+challenge_seconds FROM chain.markets WHERE state='PROPOSED' AND proposed_at IS NOT NULL
 ) SELECT deployment_id,market_id::text,mode,kind,deadline::text,(deadline-floor(extract(epoch from blink.now())))::text AS remaining FROM deadlines`);
        for (const row of rows)
          for (const threshold of thresholds[row.mode]) {
            signal.throwIfAborted();
            if (
              BigInt(row.remaining) <= 0n ||
              BigInt(row.remaining) > BigInt(threshold)
            )
              continue;
            const inserted = await db.query(
              "INSERT INTO resolution.alerts_sent(deployment_id,market_id,kind,threshold_seconds) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING market_id",
              [row.deployment_id, row.market_id, row.kind, threshold],
            );
            if (!inserted.rows.length) continue;
            await db.query(
              "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES($1,'alert.deadline',$2,$3,$4)",
              [
                randomUUID(),
                JSON.stringify([
                  "resolution",
                  row.deployment_id,
                  row.market_id,
                  row.kind,
                ]),
                threshold,
                {
                  deploymentId: row.deployment_id,
                  marketId: row.market_id,
                  kind: row.kind,
                  thresholdSeconds: threshold,
                  deadline: row.deadline,
                  mode: row.mode,
                },
              ],
            );
          }
      });
    },
  };
}

function unreadable(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  if (code === "ENOENT") return new EvidenceUnreadableError("EVIDENCE_OBJECT_MISSING");
  if (message === "OBJECT_HASH_MISMATCH")
    return new EvidenceUnreadableError("EVIDENCE_HASH_MISMATCH");
  if (message === "INVALID_OBJECT_URI" || message === "INVALID_OBJECT_HASH")
    return new EvidenceUnreadableError("EVIDENCE_OBJECT_INVALID");
  return error;
}

export function resolutionEvidenceReader(
  objects: import("@blink/ports").ImmutableObjectStore,
) {
  return async (uri: string, hash: string) => {
    const bytes = await objects.read(uri).catch((error) => {
      throw unreadable(error);
    });
    if (keccak256(bytes).toLowerCase() !== hash.toLowerCase())
      throw new EvidenceUnreadableError("EVIDENCE_HASH_MISMATCH");
    // Binary documents have no parseable text. Returning "" lets the parser report NONE
    // (an auditor reviews it) instead of failing the scan for every other market.
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return "";
    }
  };
}
