import { keccak256 } from "viem";
import { MarketSpec, MarketSpecV011, type NewMarketSpec } from "@blink/schemas";
import type { ImmutableObjectStore } from "@blink/ports";

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            stable((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function encodeNewSpec(
  input: unknown,
  nowSeconds: bigint,
): { spec: NewMarketSpec; bytes: Uint8Array; hash: `0x${string}` } {
  const spec = MarketSpecV011.parse(input);
  if (BigInt(spec.closeAt) <= nowSeconds) throw new Error("MARKET_CLOSED");
  if (
    spec.mode === "LIVE" &&
    (/fixture|placeholder|configured_|not.real/i.test(
      spec.entityId + " " + spec.fiscalPeriod,
    ) ||
      spec.sourceEvidenceIds.some((id) =>
        /fixture|placeholder|configured_/i.test(id),
      ) ||
      spec.sourceAllowlist.some((url) => {
        const h = new URL(url).hostname;
        return (
          h === "example.com" ||
          h.endsWith(".example.com") ||
          h === "localhost" ||
          h.endsWith(".invalid")
        );
      }))
  )
    throw new Error("PLACEHOLDER_LIVE_SPEC");
  const bytes = new TextEncoder().encode(stable(spec));
  return { spec, bytes, hash: keccak256(bytes) };
}
export function verifySpecBytes(bytes: Uint8Array, expectedHash: string) {
  if (keccak256(bytes).toLowerCase() !== expectedHash.toLowerCase())
    throw new Error("SPEC_HASH_MISMATCH");
  return MarketSpec.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
export function createSpecArchive(store: ImmutableObjectStore) {
  return {
    async freeze(input: unknown, nowSeconds: bigint) {
      const frozen = encodeNewSpec(input, nowSeconds);
      const { uri } = await store.putIfAbsent(frozen.bytes, frozen.hash);
      const persisted = await store.read(uri);
      verifySpecBytes(persisted, frozen.hash);
      return { hash: frozen.hash, uri, bytes: persisted };
    },
    async read(uri: string, hash: string) {
      const bytes = await store.read(uri);
      verifySpecBytes(bytes, hash);
      return bytes; // Return the stored bytes, never a reserialized JSON representation.
    },
  };
}
