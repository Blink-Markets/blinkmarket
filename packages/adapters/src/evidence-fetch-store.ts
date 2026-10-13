import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { EvidenceFetchStore } from "@blink/ports";
import { createUnitOfWork } from "./database.js";

// Runs as blink_worker: reads reviewed source policy, appends records and attempts, never edits them.
export function postgresEvidenceFetchStore(pool: Pool): EvidenceFetchStore {
  const uow = createUnitOfWork(pool);
  const insertSuccess = (
    input: Parameters<EvidenceFetchStore["recordSuccess"]>[0],
  ) =>
    uow.run(async (context) => {
      const db = uow.client(context),
        evidenceId = randomUUID();
      // observed_at is business time: the database clock, not this host's.
      await db.query(
        `INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,observed_at,published_at,access_policy)
        VALUES ($1,$2,$3,decode($4,'hex'),$5,blink.now(),NULL,$6)`,
        [
          evidenceId,
          input.sourceId,
          input.operatorId,
          input.contentHash.slice(2),
          input.objectUri,
          input.accessPolicy,
        ],
      );
      await db.query(
        `INSERT INTO evidence.fetch_attempts(id,source_id,job_id,state,evidence_id,final_url)
        VALUES ($1,$2,$3,'SUCCEEDED',$4,$5)`,
        [randomUUID(), input.sourceId, input.jobId, evidenceId, input.finalUrl],
      );
      return { evidenceId };
    });
  return {
    source: (sourceId) =>
      uow.run(async (context) => {
        const { rows } = await uow.client(context).query<{
          sourceUrl: string;
          fetchable: boolean;
          allowedMime: string[];
          redirectPrefixes: string[];
          accessPolicy: "PUBLIC" | "PRIVATE";
        }>(
          `SELECT source_url AS "sourceUrl",enabled AND fetch_enabled AS fetchable,
            allowed_mime AS "allowedMime",redirect_prefixes AS "redirectPrefixes",
            fetch_access_policy AS "accessPolicy"
          FROM evidence.sources WHERE id=$1`,
          [sourceId],
        );
        return rows[0] ?? null;
      }),
    hasSucceeded: (jobId) =>
      uow.run(async (context) => {
        const { rows } = await uow
          .client(context)
          .query(
            "SELECT 1 FROM evidence.fetch_attempts WHERE job_id=$1 AND state='SUCCEEDED'",
            [jobId],
          );
        return rows.length > 0;
      }),
    async recordSuccess(input) {
      try {
        return await insertSuccess(input);
      } catch (error) {
        // The transaction has rolled back, including the evidence record written just before it.
        if (isDuplicateSuccess(error)) return null;
        throw error;
      }
    },
    recordFailure: (input) =>
      uow.run(async (context) => {
        const db = uow.client(context);
        await db.query(
          `INSERT INTO evidence.fetch_attempts(id,source_id,job_id,state,error_code)
          VALUES ($1,$2,$3,$4,$5)`,
          [
            randomUUID(),
            input.sourceId,
            input.jobId,
            input.state,
            input.errorCode,
          ],
        );
        if (input.state === "MANUAL")
          await db.query(
            `INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id)
            VALUES ($1,current_user,'evidence.fetch_manual',$2,$3,$4)`,
            [randomUUID(), input.sourceId, input.errorCode, input.jobId],
          );
      }),
  };
}

// The partial unique index on (job_id) WHERE state='SUCCEEDED' makes a duplicate delivery lose.
function isDuplicateSuccess(error: unknown) {
  const { code, constraint } = error as {
    code?: unknown;
    constraint?: unknown;
  };
  return code === "23505" && constraint === "fetch_attempts_job_succeeded";
}
