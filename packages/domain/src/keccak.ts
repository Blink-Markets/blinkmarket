// Keccak-256 (the Ethereum variant: pad byte 0x01, not SHA-3's 0x06). The domain may not import
// viem or node:crypto, and the forecast Merkle tree needs a few thousand hashes at most, so this
// stays a small BigInt implementation; tests compare it with viem's keccak256.
const MASK = (1n << 64n) - 1n;
const RATE = 136;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTATIONS = [
  1n, 3n, 6n, 10n, 15n, 21n, 28n, 36n, 45n, 55n, 2n, 14n,
  27n, 41n, 56n, 8n, 25n, 43n, 62n, 18n, 39n, 61n, 20n, 44n,
];
const LANES = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];
const rotl = (x: bigint, n: bigint) => ((x << n) | (x >> (64n - n))) & MASK;

function permute(s: bigint[]): void {
  for (const rc of ROUND_CONSTANTS) {
    const c = [0, 1, 2, 3, 4].map(
      (x) => s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!,
    );
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1n);
      for (let y = 0; y < 25; y += 5) s[x + y] = s[x + y]! ^ d;
    }
    let carried = s[1]!;
    for (let t = 0; t < 24; t++) {
      const lane = LANES[t]!;
      const next = s[lane]!;
      s[lane] = rotl(carried, ROTATIONS[t]!);
      carried = next;
    }
    for (let y = 0; y < 25; y += 5) {
      const row = s.slice(y, y + 5);
      for (let x = 0; x < 5; x++)
        s[y + x] = row[x]! ^ (~row[(x + 1) % 5]! & MASK & row[(x + 2) % 5]!);
    }
    s[0] = s[0]! ^ rc;
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let word = 0n;
      for (let b = 7; b >= 0; b--)
        word = (word << 8n) | BigInt(padded[offset + lane * 8 + b]!);
      state[lane] = state[lane]! ^ word;
    }
    permute(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = Number((state[i >> 3]! >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}
