import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Abi, AbiParameter } from "viem";
import {
  protocolAbi,
  type ProtocolContractName,
} from "../packages/adapters/src/protocol-abi.js";

const compiled = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../contracts/artifacts/${name}.json`, import.meta.url),
      "utf8",
    ),
  ).abi as Abi;

// Same comparison as tests/blink-abi.test.ts: what changes decoding or selectors.
const parameter = (p: AbiParameter): unknown => ({
  type: p.type,
  name: p.name ?? "",
  indexed: "indexed" in p && p.indexed === true,
  components: "components" in p ? p.components.map(parameter) : undefined,
});
const shape = (item: Abi[number]) =>
  item.type === "function"
    ? {
        type: item.type,
        name: item.name,
        stateMutability: item.stateMutability,
        inputs: item.inputs.map(parameter),
        outputs: item.outputs.map(parameter),
      }
    : item.type === "event" || item.type === "error"
      ? {
          type: item.type,
          name: item.name,
          inputs: item.inputs.map(parameter),
        }
      : assert.fail("unexpected ABI item " + item.type);
const keyOf = (item: Abi[number]) =>
  item.type + " " + ("name" in item ? item.name : "");

const artifacts: Record<ProtocolContractName, string> = {
  registry: "BlinkRegistry",
  jurors: "BlinkJurors",
  markets: "BlinkMarkets",
  resolution: "BlinkResolution",
  faucet: "BlinkFaucet",
  token: "BlinkToken",
  governor: "BlinkGovernor",
  anchor: "BlinkAnchor",
  priceSource: "FixedPriceSource",
};
// Governor is an OpenZeppelin base with 50+ functions; the module lists the ones callers use.
const requiredGovernorFunctions = [
  "propose",
  "castVote",
  "execute",
  "state",
  "successor",
  "pendingSuccessor",
  "successorEffectiveAt",
];

for (const [key, artifact] of Object.entries(artifacts)) {
  test(`${key} ABI equals ${artifact} signature by signature`, () => {
    const generated = new Map(
      compiled(artifact)
        .filter(
          (item) => item.type !== "constructor" && item.type !== "receive",
        )
        .map((item) => [keyOf(item), item]),
    );
    const own = protocolAbi[key as ProtocolContractName] as Abi;
    assert.equal(
      new Set(own.map(keyOf)).size,
      own.length,
      "no duplicate or overloaded entries",
    );
    for (const item of own) {
      const match = generated.get(keyOf(item));
      assert.ok(match, `${keyOf(item)} exists in ${artifact}`);
      assert.deepEqual(shape(item), shape(match), keyOf(item));
    }
    const have = new Set(own.map(keyOf));
    const missing = [...generated.keys()].filter((k) => !have.has(k));
    // Events and errors decode logs and reverts: none may be missing anywhere.
    assert.deepEqual(
      missing.filter((k) => !k.startsWith("function ")),
      [],
    );
    if (key === "governor")
      for (const name of requiredGovernorFunctions)
        assert.ok(have.has(`function ${name}`), `governor.${name}`);
    else assert.deepEqual(missing, []);
  });
}

test("protocol ABI holds the delegation and anchor surface P2 reads", () => {
  const names = (key: ProtocolContractName, type: string) =>
    (protocolAbi[key] as Abi).flatMap((i) =>
      i.type === type && "name" in i ? [i.name] : [],
    );
  for (const fn of ["delegate", "getVotes", "balanceOf", "approve"])
    assert.ok(names("token", "function").includes(fn), fn);
  assert.ok(names("governor", "event").includes("SuccessorAdopted"));
  assert.deepEqual(names("anchor", "event"), ["Anchored"]);
  assert.ok(names("anchor", "function").includes("anchoredAt"));
});
