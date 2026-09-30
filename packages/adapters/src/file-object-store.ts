import { readFile, open, mkdir, mkdtemp, link, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { keccak256 } from "viem";
import type { ImmutableObjectStore } from "@blink/ports";
export function fileObjectStore(directory: string): ImmutableObjectStore {
  const root = resolve(directory);
  const file = (hash: string) => {
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("INVALID_OBJECT_HASH");
    return join(root, hash + ".bin");
  };
  return {
    async putIfAbsent(bytes, contentHash) {
      if (keccak256(bytes) !== contentHash)
        throw new Error("OBJECT_HASH_MISMATCH");
      const destination = file(contentHash);
      await mkdir(root, { recursive: true });
      // Keep staging on the same filesystem; only publish a complete, synced file.
      const staging = await mkdtemp(join(root, ".pending-"));
      try {
        const temporary = join(staging, "object.bin");
        const handle = await open(temporary, "wx", 0o444);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          // Unlike rename, link atomically publishes WITHOUT replacing an object.
          await link(temporary, destination);
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
        }
        const stored = await readFile(destination);
        if (keccak256(stored) !== contentHash)
          throw new Error("CORRUPT_EXISTING_OBJECT");
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return { uri: "local-object:" + contentHash };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    async read(uri) {
      if (!uri.startsWith("local-object:"))
        throw new Error("INVALID_OBJECT_URI");
      const hash = uri.slice("local-object:".length);
      const bytes = await readFile(file(hash));
      if (keccak256(bytes) !== hash) throw new Error("OBJECT_HASH_MISMATCH");
      return bytes;
    },
  };
}
