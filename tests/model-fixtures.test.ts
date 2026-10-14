import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { keccak256, toBytes } from "viem";
import {
  loadModelFixtureGateway,
  modelFixtureGateway,
} from "../packages/adapters/src/model-fixtures.js";
import { ModelCallError } from "../packages/domain/src/costs.ts";
import {
  FORECAST_PROMPTS,
  discoveryPrompt,
  forecastPrompt,
} from "../packages/domain/src/prompts.ts";
import {
  DiscoveryOutput,
  ForecastOutput,
  MarketSpec,
} from "../packages/schemas/src/index.ts";

const rates = {
  "model-x": {
    inputUsdMicrosPerMillionTokens: "3000000",
    outputUsdMicrosPerMillionTokens: "15000000",
    perRequestUsdMicros: "1000",
  },
};
const request = (
  model: string,
  input: string,
  promptHash = "0x" + "11".repeat(32),
) => ({
  runId: randomUUID(),
  model,
  promptHash,
  system: "system",
  input,
  maxOutputTokens: 800,
  reservationId: randomUUID(),
});
const inputHash = (input: string) => keccak256(toBytes(input));

test("an exact model, prompt and input match beats the model's default output", async () => {
  const promptHash = "0x" + "aa".repeat(32);
  const gateway = modelFixtureGateway({
    rates,
    defaults: { "model-x": "default answer" },
    outputs: [
      {
        model: "model-x",
        promptHash,
        inputHash: inputHash("special"),
        output: { answer: 1 },
      },
    ],
  });
  assert.equal(gateway.rate("model-x")?.perRequestUsdMicros, 1000n);
  assert.equal(gateway.rate("other"), null);
  const exact = await gateway.call(request("model-x", "special", promptHash));
  assert.equal(exact.output, '{"answer":1}');
  // The same input under another prompt hash falls back to the default.
  assert.equal(
    (await gateway.call(request("model-x", "special"))).output,
    "default answer",
  );
  assert.equal(
    (await gateway.call(request("model-x", "anything"))).output,
    "default answer",
  );
});

test("a call with no matching fixture is never sent", async () => {
  const gateway = modelFixtureGateway({ rates, defaults: {}, outputs: [] });
  await assert.rejects(
    gateway.call(request("model-x", "nothing matches")),
    (error) => error instanceof ModelCallError && error.kind === "NOT_SENT",
  );
});

test("$EVIDENCE_IDS expands to the evidence ids shown in the prompt", async () => {
  const gateway = modelFixtureGateway({
    rates,
    defaults: {
      "model-x": {
        probability: 0.5,
        rationale: "r",
        evidenceIds: ["$EVIDENCE_IDS"],
      },
    },
  });
  const a = randomUUID();
  const b = randomUUID();
  const output = (
    await gateway.call(
      request(
        "model-x",
        `MARKET\n{}\n\nEVIDENCE_ID: ${a}\ntext\nEVIDENCE_ID: ${b}\n`,
      ),
    )
  ).output;
  assert.deepEqual(JSON.parse(output).evidenceIds, [a, b]);
});

test("malformed fixture files are rejected", () => {
  for (const bad of [
    null,
    [],
    { rates: { m: { inputUsdMicrosPerMillionTokens: "1.5" } } },
    { rates: { m: { ...rates["model-x"], perRequestUsdMicros: "-1" } } },
    { rates, defaults: { "model-x": 5 } },
    {
      rates,
      outputs: [
        { model: "model-x", promptHash: "nope", inputHash: "0x", output: "x" },
      ],
    },
  ])
    assert.throws(() => modelFixtureGateway(bad), /INVALID_MODEL_FIXTURES/);
});

test("gm-replay.json drives the replay run: valid discovery and forecast answers for its models", async () => {
  const file = new URL(
    "../fixtures/replay/models/gm-replay.json",
    import.meta.url,
  );
  const gateway = await loadModelFixtureGateway(file.pathname);
  const models = JSON.parse(await readFile(file, "utf8")).defaults as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(models).sort(), [
    "gm-replay-baseline",
    "gm-replay-discovery",
    "gm-replay-forecaster-a",
    "gm-replay-forecaster-b",
  ]);
  for (const model of Object.keys(models)) assert.ok(gateway.rate(model));

  const discovery = await gateway.call(
    request("gm-replay-discovery", discoveryPrompt("Replay document").input),
  );
  assert.ok(DiscoveryOutput.safeParse(JSON.parse(discovery.output)).success);
  assert.ok("entityId" in JSON.parse(discovery.output));

  const spec = MarketSpec.parse(
    JSON.parse(
      await readFile(
        new URL("../fixtures/replay/market-spec.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const evidenceId = randomUUID();
  for (const [role, model] of [
    ["FORECASTER_A", "gm-replay-forecaster-a"],
    ["FORECASTER_B", "gm-replay-forecaster-b"],
    ["BASELINE", "gm-replay-baseline"],
  ] as const) {
    const prompt = forecastPrompt(role, spec, [{ evidenceId, text: "doc" }]);
    const answer = await gateway.call(request(model, prompt.input));
    const parsed = ForecastOutput.parse(JSON.parse(answer.output));
    assert.deepEqual(parsed.evidenceIds, [evidenceId]);
    assert.ok(FORECAST_PROMPTS[role].length > 0);
  }
});
