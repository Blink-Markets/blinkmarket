import { randomUUID } from "node:crypto";
import { keccak256 } from "viem";
import type { Pool } from "pg";
import type { ImmutableObjectStore } from "@blink/ports";
import { EvidenceImport } from "@blink/schemas";
import { createUnitOfWork } from "./database.js";

// Offline, human-reviewed imports only. Never fetch a caller-provided URL.
export function evidenceAdmin(pool: Pool, objects: ImmutableObjectStore) {
  const uow = createUnitOfWork(pool);
  return {
    async allowSource(entityId: string, sourceUrl: string, reason: string) {
      const url = new URL(sourceUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !entityId.trim() ||
        entityId.trim().length > 4000 ||
        !reason.trim() ||
        reason.length > 4000
      )
        throw new Error("INVALID_SOURCE");
      return uow.run(async (context) => {
        const db = uow.client(context),
          id = randomUUID();
        await db.query(
          "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES ($1,$2,$3)",
          [id, entityId.trim(), url.href],
        );
        await db.query(
          "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES ($1,current_user,'evidence.source_allowed',$2,$3,$4)",
          [randomUUID(), id, reason, randomUUID()],
        );
        return { sourceId: id };
      });
    },
    async importBytes(input: unknown, bytes: Uint8Array) {
      const data = EvidenceImport.parse(input);
      if (!bytes.length || bytes.length > 10 * 1024 * 1024)
        throw new Error("INVALID_EVIDENCE_SIZE");
      const hash = keccak256(bytes);
      const { uri } = await objects.putIfAbsent(bytes, hash);
      if (keccak256(await objects.read(uri)) !== hash)
        throw new Error("EVIDENCE_HASH_MISMATCH");
      // Archive IO precedes SQL: a failed transaction may leave an unreferenced immutable object, never a dangling committed reference.
      return uow.run(async (context) => {
        const db = uow.client(context),
          id = randomUUID();
        const source = await db.query(
          "SELECT id FROM evidence.sources WHERE id=$1 AND enabled FOR SHARE",
          [data.sourceId],
        );
        if (!source.rows.length) throw new Error("SOURCE_NOT_ALLOWED");
        await db.query(
          `INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,published_at,access_policy,excerpt)
          VALUES ($1,$2,$3,decode($4,'hex'),$5,$6,$7,$8)`,
          [
            id,
            data.sourceId,
            data.operatorId,
            hash.slice(2),
            uri,
            data.publishedAt,
            data.accessPolicy,
            data.excerpt,
          ],
        );
        await db.query(
          "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES ($1,current_user,'evidence.imported',$2,$3,$4)",
          [randomUUID(), id, data.reason, randomUUID()],
        );
        return { evidenceId: id, contentHash: hash };
      });
    },
  };
}
