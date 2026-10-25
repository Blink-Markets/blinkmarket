import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePacked, keccak256 as viemKeccak, toBytes } from "viem";
import {
  forecastLeaf,
  hashPair,
  merkleProof,
  merkleRoot,
  verifyProof,
} from "../packages/domain/src/forecast-merkle.ts";
import { keccak256 } from "../packages/domain/src/keccak.ts";

const hex = (data: Uint8Array) =>
  "0x" + Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
// The digests, leaves and root of contracts/test/protocol/ForecastMerkle.t.sol, where
// OpenZeppelin MerkleProof.verify accepts every leaf's proof against PINNED_ROOT.
const digests = [0, 1, 2, 3, 4].map((i) =>
  viemKeccak(encodePacked(["string", "uint256"], ["blink-forecast-digest-", BigInt(i)])),
);
const PINNED_ROOT =
  "0x7afdf524a16341781fad2ea11713a925f30da75940cf6144379c5e0397bdab40";

test("keccak256 matches viem for every padding length", () => {
  for (const length of [0, 1, 31, 32, 64, 135, 136, 137, 272, 300]) {
    const input = Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff);
    assert.equal(hex(keccak256(input)), viemKeccak(input), "length " + length);
  }
  assert.equal(
    hex(keccak256(toBytes("abc"))),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
});

test("the leaf is the double hash of the digest", () => {
  const digest = digests[0]!;
  assert.equal(forecastLeaf(digest), viemKeccak(viemKeccak(digest)));
});

test("root of one leaf is the leaf", () => {
  const leaf = forecastLeaf(digests[0]!);
  assert.equal(merkleRoot([leaf]), leaf);
  assert.deepEqual(merkleProof([leaf], leaf), []);
});

test("empty window has no root", () => {
  assert.equal(merkleRoot([]), null);
});

test("order independent", () => {
  const leaves = digests.map(forecastLeaf);
  const root = merkleRoot(leaves);
  assert.equal(merkleRoot([...leaves].reverse()), root);
  assert.equal(merkleRoot([leaves[3]!, leaves[0]!, leaves[4]!, leaves[1]!, leaves[2]!]), root);
  // A repeated leaf is one leaf.
  assert.equal(merkleRoot([...leaves, leaves[2]!]), root);
  // Hex case does not matter.
  assert.equal(merkleRoot(leaves.map((l) => "0x" + l.slice(2).toUpperCase())), root);
});

test("proof verifies for every leaf", () => {
  const leaves = digests.map(forecastLeaf);
  const root = merkleRoot(leaves)!;
  const stranger = forecastLeaf(viemKeccak("0x01"));
  assert.equal(root, PINNED_ROOT);
  for (const leaf of leaves) {
    const proof = merkleProof(leaves, leaf);
    assert.ok(verifyProof(proof, root, leaf));
    assert.equal(verifyProof(proof, root, stranger), false);
  }
  // Trees of every small size verify, including the odd last node carried up.
  for (let n = 1; n <= 12; n++) {
    const set = Array.from({ length: n }, (_, i) =>
      forecastLeaf(viemKeccak(encodePacked(["uint256"], [BigInt(i)]))),
    );
    const treeRoot = merkleRoot(set)!;
    for (const leaf of set)
      assert.ok(verifyProof(merkleProof(set, leaf), treeRoot, leaf), `n=${n}`);
  }
  assert.throws(() => merkleProof(leaves, stranger), /LEAF_NOT_IN_TREE/);
});

test("pairs hash in sorted order", () => {
  const [a, b] = [forecastLeaf(digests[0]!), forecastLeaf(digests[1]!)];
  const [low, high] = a < b ? [a, b] : [b, a];
  assert.equal(hashPair(a, b), viemKeccak((low + high.slice(2)) as `0x${string}`));
  assert.equal(hashPair(b, a), hashPair(a, b));
});
