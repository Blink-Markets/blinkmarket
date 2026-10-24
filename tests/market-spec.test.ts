import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256 } from "viem";
import { parseMarketSpec } from "../packages/schemas/src/index.ts";

const hash = (c: string) => "0x" + c.repeat(64);
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const specB = {
  schema: "blink.market-spec/0.2",
  title: "Will the Base Sepolia gas price exceed 1 gwei on 2026-12-01?",
  question: "Does the median gas price of block 1,000,000 exceed 1 gwei?",
  class: "B",
  resolution: { yes: "Median above 1 gwei.", no: "Median at or below 1 gwei." },
  sources: ["https://sepolia.basescan.org/"],
};
const specA = {
  ...specB,
  class: "A",
  computation: {
    templateId: hash("1"),
    parserHash: hash("2"),
    extraction: "Read baseFeePerGas of block 1,000,000.",
  },
};

test("a valid B spec parses", () => {
  const result = parseMarketSpec(encode(specB));
  assert.ok(result.ok);
  assert.equal(result.spec.class, "B");
  assert.equal(result.spec.resolution.invalid, undefined);
});

test("a class A spec needs computation", () => {
  assert.ok(parseMarketSpec(encode(specA)).ok);
  const { computation: _computation, ...withoutComputation } = specA;
  const result = parseMarketSpec(encode(withoutComputation));
  assert.equal(result.ok, false);
});

test("a BOM or invalid UTF-8 fails", () => {
  const bytes = encode(specB);
  const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]);
  const bom = parseMarketSpec(withBom);
  assert.deepEqual(bom, { ok: false, reason: "BOM" });
  const bad = Uint8Array.from([...bytes.slice(0, -2), 0xff, 0xfe, 0x7d]);
  const invalid = parseMarketSpec(bad);
  assert.deepEqual(invalid, { ok: false, reason: "INVALID_UTF8" });
});

test("non-JSON, unknown fields, http sources and long titles fail", () => {
  assert.equal(parseMarketSpec(new TextEncoder().encode("nope")).ok, false);
  assert.equal(parseMarketSpec(encode({ ...specB, extra: 1 })).ok, false);
  assert.equal(
    parseMarketSpec(encode({ ...specB, sources: ["http://example.com/"] })).ok,
    false,
  );
  assert.equal(
    parseMarketSpec(encode({ ...specB, title: "x".repeat(201) })).ok,
    false,
  );
  assert.equal(parseMarketSpec(encode({ ...specB, title: "" })).ok, false);
});

test("suggestionId round-trips", () => {
  const suggestionId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const result = parseMarketSpec(encode({ ...specB, suggestionId }));
  assert.ok(result.ok);
  assert.equal(result.spec.suggestionId, suggestionId);
  assert.equal(
    parseMarketSpec(encode({ ...specB, suggestionId: "not-a-uuid" })).ok,
    false,
  );
});

test("the parse result keeps the input bytes", () => {
  // Pretty-printed with a trailing newline: re-serializing would change the hash.
  const bytes = new TextEncoder().encode(JSON.stringify(specB, null, 2) + "\n");
  const result = parseMarketSpec(bytes);
  assert.ok(result.ok);
  assert.equal(keccak256(result.bytes), keccak256(bytes));
  assert.equal(result.bytes, bytes);
});
