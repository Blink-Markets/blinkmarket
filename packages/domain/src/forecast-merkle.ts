import type { Hash } from "@blink/schemas";
import { keccak256 } from "./keccak.ts";

// The forecast window tree, compatible with OpenZeppelin MerkleProof.verify: sorted-pair hashing,
// and a leaf that is hashed twice so a leaf can never be read as an inner node.
const bytes = (hex: string) =>
  Uint8Array.from(hex.slice(2).match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (data: Uint8Array): Hash =>
  "0x" + Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
const HASH = /^0x[0-9a-f]{64}$/;
const norm = (value: string): Hash => {
  const lower = value.toLowerCase();
  if (!HASH.test(lower)) throw new Error("INVALID_HASH");
  return lower;
};

/** keccak256(bytes.concat(keccak256(abi.encode(digest)))): the leaf of a forecast digest. */
export const forecastLeaf = (digest: Hash): Hash =>
  hex(keccak256(keccak256(bytes(norm(digest)))));

/** keccak256(concat(min(a, b), max(a, b))), the OpenZeppelin commutative pair hash. */
export function hashPair(a: Hash, b: Hash): Hash {
  const [low, high] = a < b ? [a, b] : [b, a];
  return hex(keccak256(Uint8Array.from([...bytes(low), ...bytes(high)])));
}

const sortedUnique = (leaves: readonly Hash[]) => [
  ...new Set(leaves.map(norm)),
].sort();

/** The root of the sorted, de-duplicated leaves; an odd last node moves up unchanged. No leaves, no root. */
export function merkleRoot(leaves: readonly Hash[]): Hash | null {
  let level = sortedUnique(leaves);
  if (level.length === 0) return null;
  while (level.length > 1) {
    const next: Hash[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(
        i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!,
      );
    level = next;
  }
  return level[0]!;
}

/** The sibling path of `leaf`, for BlinkAnchor-side or off-chain MerkleProof.verify. */
export function merkleProof(leaves: readonly Hash[], leaf: Hash): Hash[] {
  let level = sortedUnique(leaves);
  let index = level.indexOf(norm(leaf));
  if (index < 0) throw new Error("LEAF_NOT_IN_TREE");
  const proof: Hash[] = [];
  while (level.length > 1) {
    const sibling = level[index ^ 1];
    if (sibling !== undefined) proof.push(sibling);
    const next: Hash[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(
        i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!,
      );
    level = next;
    index >>= 1;
  }
  return proof;
}

/** OpenZeppelin MerkleProof.verify. */
export const verifyProof = (proof: readonly Hash[], root: Hash, leaf: Hash) =>
  proof.reduce((node, sibling) => hashPair(node, sibling), norm(leaf)) ===
  norm(root);
