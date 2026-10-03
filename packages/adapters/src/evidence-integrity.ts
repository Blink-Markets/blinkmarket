import { keccak256 } from "viem";
import type { ImmutableObjectStore } from "@blink/ports";
export function evidenceIntegrity(objects: ImmutableObjectStore) {
  return async (uri: string, hash: string) => {
    if (keccak256(await objects.read(uri)).toLowerCase() !== hash.toLowerCase())
      throw new Error("EVIDENCE_HASH_MISMATCH");
  };
}
