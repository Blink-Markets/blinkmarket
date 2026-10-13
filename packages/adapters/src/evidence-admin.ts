import { randomUUID } from "node:crypto";
import { keccak256 } from "viem";
import type { Pool } from "pg";
import { checkFetchUrl, type ImmutableObjectStore } from "@blink/ports";
import { EvidenceImport } from "@blink/schemas";
import { createUnitOfWork } from "./database.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mimeType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
// Fields left undefined keep their stored value; reviewed lists replace the stored ones.
function parseFetchPolicy(input: unknown) {
  const fail = (): never => {
    throw new Error("INVALID_FETCH_POLICY");
  };
  const data = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  const list = (value: unknown) =>
    value === undefined
      ? undefined
      : Array.isArray(value) &&
          value.length <= 50 &&
          value.every((v) => typeof v === "string")
        ? (value as string[])
        : fail();
  const unique = (values: string[] | undefined) =>
    values && [...new Set(values)];
  const { sourceId, reason, accessPolicy } = data;
  if (typeof sourceId !== "string" || !uuid.test(sourceId)) fail();
  if (typeof reason !== "string" || !reason.trim() || reason.length > 4000)
    fail();
  if (
    accessPolicy !== undefined &&
    accessPolicy !== "PUBLIC" &&
    accessPolicy !== "PRIVATE"
  )
    fail();
  const redirectPrefixes = unique(
    list(data["redirectPrefixes"])?.map((prefix) => {
      // A prefix must itself be a URL the fetcher would accept as a first request.
      const checked = checkFetchUrl(
        prefix,
        { exactUrl: prefix, redirectPrefixes: [] },
        0,
      );
      return checked.ok ? new URL(prefix).href : fail();
    }),
  );
  const allowedMime = unique(
    list(data["allowedMime"])?.map((type) => {
      const normalized = type.trim().toLowerCase();
      return mimeType.test(normalized) ? normalized : fail();
    }),
  );
  if (allowedMime && !allowedMime.length) fail();
  return {
    sourceId: sourceId as string,
    reason: reason as string,
    accessPolicy: accessPolicy as "PUBLIC" | "PRIVATE" | undefined,
    redirectPrefixes,
    allowedMime,
  };
}

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
    // Records the reviewed fetch policy that the worker's evidence.fetch job obeys.
    async enableFetch(input: unknown) {
      const data = parseFetchPolicy(input);
      return uow.run(async (context) => {
        const db = uow.client(context);
        const updated = await db.query(
          `UPDATE evidence.sources SET fetch_enabled=true,
            redirect_prefixes=COALESCE($2::text[],redirect_prefixes),
            allowed_mime=COALESCE($3::text[],allowed_mime),
            fetch_access_policy=COALESCE($4,fetch_access_policy)
          WHERE id=$1 AND enabled RETURNING id`,
          [
            data.sourceId,
            data.redirectPrefixes ?? null,
            data.allowedMime ?? null,
            data.accessPolicy ?? null,
          ],
        );
        if (!updated.rows.length) throw new Error("SOURCE_NOT_ALLOWED");
        await db.query(
          "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES ($1,current_user,'evidence.fetch_enabled',$2,$3,$4)",
          [randomUUID(), data.sourceId, data.reason, randomUUID()],
        );
        return { sourceId: data.sourceId };
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
