import type { Pool } from "pg";
import { keccak256 } from "viem";
import type {
  ContentMediaType,
  ContentObject,
  ContentStore,
  ImmutableObjectStore,
  SpecArchive,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";

// fileObjectStore names an object by its hash, so the record needs no URI column.
const objectUri = (hash: string) => "local-object:" + hash;
const bytea = (hex: string) => hex.slice(2);

/** Reads archived bytes and accepts them only when keccak256(bytes) is the expected hash. */
export function verifiedArchive(objects: ImmutableObjectStore): SpecArchive {
  return {
    async read(uri, hash) {
      const bytes = await objects.read(uri);
      if (keccak256(bytes).toLowerCase() !== hash.toLowerCase())
        throw new Error("OBJECT_HASH_MISMATCH");
      return bytes;
    },
  };
}

export function postgresContentStore(
  pool: Pool,
  objects: ImmutableObjectStore,
): ContentStore {
  const uow = createUnitOfWork(pool);
  const archive = verifiedArchive(objects);
  const row = (r: { size: number; media_type: string }, hash: string) =>
    ({
      hash,
      size: r.size,
      mediaType: r.media_type as ContentMediaType,
    }) satisfies ContentObject;
  return {
    async put(input) {
      // The bytes land first: a record never points at missing bytes. An orphaned object after a
      // failed insert is harmless, because the next upload of the same bytes finds it.
      await objects.putIfAbsent(input.bytes, input.hash);
      return uow.run(async (ctx) => {
        const db = uow.client(ctx);
        await db.query(
          `INSERT INTO content.objects(hash,size,media_type,uploader)
           VALUES (decode($1,'hex'),$2,$3,decode($4,'hex')) ON CONFLICT (hash) DO NOTHING`,
          [
            bytea(input.hash),
            input.bytes.length,
            input.mediaType,
            bytea(input.uploader),
          ],
        );
        if (input.suggestionId)
          await db.query(
            `INSERT INTO suggestions.spec_links(spec_hash,suggestion_id,linked_by)
             SELECT decode($1,'hex'),i.id,decode($3,'hex') FROM suggestions.items i WHERE i.id=$2
             ON CONFLICT DO NOTHING`,
            [bytea(input.hash), input.suggestionId, bytea(input.uploader)],
          );
        const { rows } = await db.query<{ size: number; media_type: string }>(
          "SELECT size,media_type FROM content.objects WHERE hash=decode($1,'hex')",
          [bytea(input.hash)],
        );
        return row(rows[0]!, input.hash);
      });
    },
    async get(hash) {
      const { rows } = await pool.query<{ size: number; media_type: string }>(
        "SELECT size,media_type FROM content.objects WHERE hash=decode($1,'hex')",
        [bytea(hash)],
      );
      if (!rows[0]) return null;
      return {
        object: row(rows[0], hash),
        bytes: await archive.read(objectUri(hash), hash),
      };
    },
  };
}
