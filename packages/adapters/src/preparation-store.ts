import type { Pool, PoolClient } from "pg";
import type { CandidateRecord, EvidenceMetadata } from "@blink/schemas";
import type { PreparationStore, PreparationTransaction } from "@blink/ports";
import { randomUUID } from "node:crypto";
import { createUnitOfWork } from "./database.js";
import { identityTransaction } from "./identity-store.js";

export function postgresPreparationStore(pool: Pool): PreparationStore {
  const uow = createUnitOfWork(pool);
  return {
    run: (work) =>
      uow.run(async (context) => {
        const client = uow.client(context);
        return work(preparationTransaction(client));
      }),
  };
}

export function preparationTransaction(
  client: PoolClient,
): PreparationTransaction {
  return {
    ...identityTransaction(client),
    async evidence(id) {
      const { rows } = await client.query<{
        operatorId: string;
        entityId: string;
        enabled: boolean;
        metadata: EvidenceMetadata;
      }>(
        `SELECT r.operator_id AS "operatorId",s.entity_id AS "entityId",s.enabled,
          jsonb_build_object('evidenceId',r.id,'sourceUrl',s.source_url,
            'observedAt',to_char(r.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'publishedAt',to_char(r.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'contentHash','0x'||encode(r.content_hash,'hex'),'accessPolicy',r.access_policy,'excerpt',r.excerpt) AS metadata
          FROM evidence.records r JOIN evidence.sources s ON s.id=r.source_id WHERE r.id=$1
          FOR SHARE OF s`,
        [id],
      );
      return rows[0] ?? null;
    },
    async candidate(id, lock) {
      const { rows } = await client.query<{
        operator_id: string;
        current_revision: number;
      }>(
        `SELECT operator_id,current_revision FROM discovery.candidates WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
        [id],
      );
      const head = rows[0];
      if (!head) return null;
      const history = await client.query<{ snapshot: CandidateRecord }>(
        "SELECT snapshot FROM discovery.candidate_revisions WHERE candidate_id=$1 AND revision<=$2 ORDER BY revision",
        [id, head.current_revision],
      );
      const revisions = history.rows.map((r) => r.snapshot);
      return {
        operatorId: head.operator_id,
        candidate: revisions.at(-1)!,
        revisions,
      };
    },
    async appendCandidate(operatorId, record, create) {
      if (create)
        await client.query(
          "INSERT INTO discovery.candidates(id,operator_id,current_revision) VALUES ($1,$2,$3)",
          [record.candidateId, operatorId, record.revision],
        );
      await client.query(
        "INSERT INTO discovery.candidate_revisions(candidate_id,revision,snapshot) VALUES ($1,$2,$3)",
        [record.candidateId, record.revision, record],
      );
      for (const evidenceId of record.evidenceIds)
        await client.query(
          "INSERT INTO discovery.candidate_evidence(candidate_id,revision,evidence_id) VALUES ($1,$2,$3)",
          [record.candidateId, record.revision, evidenceId],
        );
      if (!create)
        await client.query(
          "UPDATE discovery.candidates SET current_revision=$2 WHERE id=$1",
          [record.candidateId, record.revision],
        );
    },
    async recordAudit(actor, action, resource, reason, requestId) {
      await client.query(
        "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [randomUUID(), actor, action, resource, reason, requestId],
      );
    },
  };
}
