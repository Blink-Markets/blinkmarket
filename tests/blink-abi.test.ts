import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Abi, AbiParameter } from "viem";
import {
  blinkEventNames,
  blinkMarketAbi,
  blinkTestUsdAbi,
  type BlinkEventName,
} from "../packages/adapters/src/blink-abi.js";

const compiled = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../contracts/artifacts/${name}.json`, import.meta.url),
      "utf8",
    ),
  ).abi as Abi;

// Compares what changes decoding or selectors: names, types, indexed flags, mutability.
// internalType and the constructor are compiler details outside the reader ABI.
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
const readable = (abi: Abi) =>
  abi.filter((item) => item.type !== "constructor");

// EIP712DomainChanged is never emitted by the immutable domain; indexers do not read it.
const cases: [string, Abi, string[]][] = [
  ["BlinkMarket", blinkMarketAbi, ["event EIP712DomainChanged"]],
  ["BlinkTestUSD", blinkTestUsdAbi, []],
];
for (const [artifact, module, ignored] of cases) {
  test(`${artifact} ABI module equals the compiled artifact signature by signature`, () => {
    const generated = new Map(
      readable(compiled(artifact)).map((item) => [keyOf(item), item]),
    );
    const own = readable(module);
    assert.equal(
      new Set(own.map(keyOf)).size,
      own.length,
      "no duplicate or overloaded entries",
    );
    for (const item of own) {
      const match = generated.get(keyOf(item));
      assert.ok(match, `${keyOf(item)} exists in the artifact`);
      assert.deepEqual(shape(item), shape(match), keyOf(item));
    }
    // Nothing the contract exposes is silently missing from the shared module.
    const have = new Set(own.map(keyOf));
    assert.deepEqual(
      [...generated.keys()].filter((k) => !have.has(k) && !ignored.includes(k)),
      [],
    );
  });
}

test("BlinkEventName lists exactly the events of the BlinkMarket ABI module", () => {
  const expected: BlinkEventName[] = [
    "MarketCreated",
    "TradingPauseChanged",
    "TakerAllowedChanged",
    "MakerDeposited",
    "MakerWithdrawn",
    "QuoteFilled",
    "QuoteCancelled",
    "MakerEpochIncremented",
    "OutcomeProposed",
    "OutcomeChallenged",
    "OutcomeFinalized",
    "PositionRedeemed",
  ];
  assert.deepEqual([...blinkEventNames], expected);
  assert.deepEqual(
    (blinkMarketAbi as Abi)
      .flatMap((item) => (item.type === "event" ? [item.name] : []))
      .sort(),
    [...expected].sort(),
  );
});
