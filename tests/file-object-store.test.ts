import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { fileObjectStore } from "../packages/adapters/src/file-object-store.js";

test("concurrent identical objects publish complete bytes and clean staging files", async () => {
  const root = await mkdtemp(join(tmpdir(), "blink-object-race-"));
  try {
    const bytes = new Uint8Array(1024 * 1024).fill(71);
    const hash = keccak256(bytes);
    const writes = await Promise.all(
      Array.from({ length: 16 }, async () => {
        const store = fileObjectStore(root);
        const result = await store.putIfAbsent(bytes, hash);
        assert.deepEqual(new Uint8Array(await store.read(result.uri)), bytes);
        return result;
      }),
    );
    assert.ok(writes.every((result) => result.uri === "local-object:" + hash));
    assert.deepEqual(await readdir(root), [hash + ".bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abandoned staging does not poison retries; corrupt published objects are never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "blink-object-recovery-"));
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = keccak256(bytes);
    const abandoned = join(root, ".pending-crashed-writer");
    await mkdir(abandoned);
    await writeFile(join(abandoned, "object.bin"), bytes.slice(0, 1));
    const store = fileObjectStore(root);
    const result = await store.putIfAbsent(bytes, hash);
    assert.deepEqual(new Uint8Array(await store.read(result.uri)), bytes);

    const other = new Uint8Array([4, 5, 6]);
    const otherHash = keccak256(other);
    const corrupt = join(root, otherHash + ".bin");
    await writeFile(corrupt, new Uint8Array([4]));
    await assert.rejects(
      store.putIfAbsent(other, otherHash),
      /CORRUPT_EXISTING_OBJECT/,
    );
    assert.deepEqual(
      new Uint8Array(await readFile(corrupt)),
      new Uint8Array([4]),
    );
    assert.deepEqual(
      (await readdir(root)).sort(),
      [".pending-crashed-writer", hash + ".bin", otherHash + ".bin"].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
