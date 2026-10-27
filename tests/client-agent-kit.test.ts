import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  type Abi,
  type AbiParameter,
  type Hex,
} from "viem";
import {
  CREATION_GROUND,
  GM_LT_V1,
  MARKET_STATE,
  OUTCOME,
  QUESTION_CLASS,
  ROLE,
  agentAbi,
  parseMarketSpec,
  quoteTypedData,
  templateIdFor,
  voteCommitment,
} from "../packages/client/src/index.ts";

// Changing the parser's bytes changes this hash. A parser is part of a template, so the change
// must ship as a new template (a new file and a new pinned hash), never as an edit of GM_LT_V1.
const PINNED_PARSER_HASH =
  "0x0eced6cdcd4c8bf1f4a69799383467615b9eb3992e446c5e6ee4cde2f33a4f80";

const compiled = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../contracts/artifacts/${name}.json`, import.meta.url),
      "utf8",
    ),
  ).abi as Abi;

// The same comparison as tests/protocol-abi.test.ts: every field that changes decoding or selectors.
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
    : item.type === "event"
      ? {
          type: item.type,
          name: item.name,
          inputs: item.inputs.map(parameter),
        }
      : assert.fail("unexpected ABI item " + item.type);
const keyOf = (item: Abi[number]) =>
  item.type + " " + ("name" in item ? item.name : "");

const artifacts: Record<keyof typeof agentAbi, string> = {
  registry: "BlinkRegistry",
  jurors: "BlinkJurors",
  markets: "BlinkMarkets",
  resolution: "BlinkResolution",
  faucet: "BlinkFaucet",
  usd: "BlinkTestUSD",
  platformToken: "BlinkToken",
  anchor: "BlinkAnchor",
};

test("agentAbi matches the compiled artifacts", () => {
  for (const [key, artifact] of Object.entries(artifacts)) {
    const generated = new Map(compiled(artifact).map((i) => [keyOf(i), i]));
    const own = agentAbi[key as keyof typeof agentAbi] as Abi;
    assert.ok(own.length > 0, key);
    assert.equal(new Set(own.map(keyOf)).size, own.length, `${key}: no duplicates`);
    for (const item of own) {
      const match = generated.get(keyOf(item));
      assert.ok(match, `${key}: ${keyOf(item)} exists in ${artifact}`);
      assert.deepEqual(shape(item), shape(match), `${key}: ${keyOf(item)}`);
    }
  }
});

test("agentAbi lists what the role steps and the agent reads need", () => {
  const names = (key: keyof typeof agentAbi) =>
    new Set((agentAbi[key] as Abi).map(keyOf));
  const needs: Record<string, string[]> = {
    registry: ["register", "joinRole", "hasRole", "isRegistered", "creditOf"],
    jurors: ["stake", "requestUnstake", "withdrawUnstaked", "slashableStake"],
    markets: [
      "registerTemplate",
      "createMarket",
      "open",
      "depositMaker",
      "withdrawMaker",
      "cancelQuote",
      "fillQuote",
      "redeem",
      "distributeFees",
      "getMarket",
      "getPosition",
    ],
    resolution: [
      "propose",
      "challengeCreation",
      "challengeResult",
      "commitVote",
      "revealVote",
      "settleRound",
      "settleVote",
      "appeal",
      "finalizeDispute",
      "finalizeUnchallenged",
      "finalizeTimeout",
      "getDispute",
    ],
    faucet: ["claim"],
    usd: ["approve", "balanceOf", "allowance"],
    platformToken: ["approve", "balanceOf", "allowance"],
    anchor: ["anchoredAt"],
  };
  for (const [key, functions] of Object.entries(needs))
    for (const fn of functions)
      assert.ok(
        names(key as keyof typeof agentAbi).has(`function ${fn}`),
        `${key}.${fn}`,
      );
});

// The enum blocks of BlinkTypes.sol, name by name in declaration order.
const solidityEnum = (name: string): Record<string, number> => {
  const source = readFileSync(
    new URL("../contracts/src/protocol/BlinkTypes.sol", import.meta.url),
    "utf8",
  );
  const block = new RegExp(`enum ${name}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(block, `enum ${name} in BlinkTypes.sol`);
  return Object.fromEntries(
    block[1]!
      .split(",")
      .map((member) => member.trim())
      .filter(Boolean)
      .map((member, index) => [member, index]),
  );
};

test("enums match the Solidity sources", () => {
  assert.deepEqual({ ...ROLE }, solidityEnum("Role"));
  assert.deepEqual({ ...QUESTION_CLASS }, solidityEnum("QuestionClass"));
  assert.deepEqual({ ...MARKET_STATE }, solidityEnum("MarketState"));
  assert.deepEqual({ ...OUTCOME }, solidityEnum("Outcome"));
});

test("CREATION_GROUND follows the spec order and fits the contract's bound", () => {
  assert.deepEqual(
    { ...CREATION_GROUND },
    { WRONG_CLASS: 0, AMBIGUOUS: 1, MANIPULABLE: 2 },
  );
  const source = readFileSync(
    new URL("../contracts/src/protocol/BlinkResolution.sol", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(ground >= 3\) revert UnknownGround/);
});

test("GM_LT_V1 parserHash pins the parser bytes", () => {
  const bytes = readFileSync(
    new URL("../packages/client/src/templates/gm-lt-v1.ts", import.meta.url),
  );
  assert.equal(
    keccak256(bytes),
    GM_LT_V1.parserHash,
    "templates/gm-lt-v1.ts changed: the parser is part of the template, so a change means a NEW template (new file, new parserHash, new templateId), not an edit of GM_LT_V1",
  );
  assert.equal(GM_LT_V1.parserHash, PINNED_PARSER_HASH);
  assert.equal(GM_LT_V1.uri, `/v1/content/${PINNED_PARSER_HASH}`);
  assert.equal(GM_LT_V1.cls, QUESTION_CLASS.A_COMPUTABLE);
});

test("GM_LT_V1 templateId equals templateIdFor(cls, parserHash, uri)", () => {
  assert.equal(
    GM_LT_V1.templateId,
    templateIdFor(GM_LT_V1.cls, GM_LT_V1.parserHash, GM_LT_V1.uri),
  );
  const register = (agentAbi.markets as Abi).find(
    (i) => i.type === "function" && i.name === "registerTemplate",
  );
  assert.ok(register && register.type === "function");
  // registerTemplate(cls, parserHash, uri) derives its id from the same three values.
  assert.equal(
    GM_LT_V1.templateId,
    keccak256(
      encodeAbiParameters(register.inputs, [
        GM_LT_V1.cls,
        GM_LT_V1.parserHash,
        GM_LT_V1.uri,
      ]),
    ),
  );
});

test("voteCommitment encodes the reveal tuple", () => {
  const reveal = (agentAbi.resolution as Abi).find(
    (i) => i.type === "function" && i.name === "revealVote",
  );
  assert.ok(reveal && reveal.type === "function");
  const [disputeId, choice, salt] = reveal.inputs;
  const input = {
    disputeId: 7n,
    round: 2n,
    juror: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex,
    choice: 1,
    salt: ("0x" + "ab".repeat(32)) as Hex,
  };
  assert.equal(
    voteCommitment(input),
    keccak256(
      encodeAbiParameters(
        [
          disputeId!,
          { type: "uint256", name: "round" },
          { type: "address", name: "juror" },
          choice!,
          salt!,
        ],
        [input.disputeId, input.round, input.juror, input.choice, input.salt],
      ),
    ),
  );
  assert.notEqual(
    voteCommitment({ ...input, choice: 0 }),
    voteCommitment(input),
  );
});

test("quoteTypedData is the typed data BlinkMarkets hashes", () => {
  const quote = {
    marketId: "3",
    specHash: ("0x" + "11".repeat(32)) as Hex,
    maker: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex,
    taker: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Hex,
    side: "1" as const,
    quantity: "10",
    priceBps: "6000",
    validAfter: "100",
    expiresAt: "200",
    nonce: "5",
    epoch: "0",
  };
  const markets = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const typed = quoteTypedData(quote, { generation: { markets } } as never);
  assert.deepEqual(typed.domain, {
    name: "Blink RFQ",
    version: "0.2",
    chainId: 84532,
    verifyingContract: markets,
  });
  assert.equal(typed.message.side, 1);
  assert.equal(typed.message.expiresAt, 200n);
  assert.match(hashTypedData(typed), /^0x[0-9a-f]{64}$/);
});

test("the client re-exports the spec parser so agents never import schemas", () => {
  assert.equal(typeof parseMarketSpec, "function");
});
