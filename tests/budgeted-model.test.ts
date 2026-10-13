import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { postgresBudgetLedger } from "../packages/adapters/src/budget-ledger.js";
import { fixtureModelGateway } from "../packages/adapters/src/fixture-model-gateway.js";
import {
  createBudgetedModelCaller,
  ModelCallError,
} from "../packages/application/src/budgeted-model.js";
import {
  maxCostUsdMicros,
  usageCostUsdMicros,
  type ModelRate,
} from "../packages/domain/src/costs.js";
import { JobError } from "../packages/domain/src/jobs.js";
import type { ModelGateway } from "../packages/ports/src/index.js";
import { migratedPglite } from "./helpers/serial-pglite-pool.js";

const rate: ModelRate = {
  inputUsdMicrosPerMillionTokens: 3_000_000n,
  outputUsdMicrosPerMillionTokens: 15_000_000n,
  perRequestUsdMicros: 1000n,
};
// "syshello" is 8 bytes: ceil(8*3) + ceil(1000*15) + 1000.
const MAX_FOR_SMALL_PROMPT = 16_024n;
// Fixture output "ok" is 2 bytes: ceil(8*3) + ceil(2*15) + 1000.
const FIXTURE_ACTUAL = 1_054n;

const request = (
  extra: { model?: string; questionCapUsdMicros?: bigint; jobId?: string } = {},
) => ({
  runId: randomUUID(),
  questionKey: "q1",
  questionCapUsdMicros: 2_000_000n,
  model: "fixture-model",
  promptHash: "0x" + "ab".repeat(32),
  system: "sys",
  input: "hello",
  maxOutputTokens: 1000,
  ...extra,
});

async function withCaller(
  respond: Parameters<typeof fixtureModelGateway>[0]["respond"],
  run: (
    s: Awaited<ReturnType<typeof migratedPglite>>,
    caller: ReturnType<typeof createBudgetedModelCaller>,
    ledger: ReturnType<typeof postgresBudgetLedger>,
  ) => Promise<void>,
  gateway?: (fixture: ModelGateway) => ModelGateway,
) {
  const s = await migratedPglite();
  try {
    const ledger = postgresBudgetLedger(s.pool);
    const fixture = fixtureModelGateway({
      rates: { "fixture-model": rate },
      respond,
    });
    await run(
      s,
      createBudgetedModelCaller({
        ledger,
        gateway: gateway ? gateway(fixture) : fixture,
      }),
      ledger,
    );
  } finally {
    await s.db.close();
  }
}

const reservationRow = async (
  s: Awaited<ReturnType<typeof migratedPglite>>,
  runId: string,
) =>
  (
    await s.pool.query(
      `SELECT state, provider, model, max_usd_micros::text AS max,
              actual_usd_micros::text AS actual, provider_request_id
       FROM budgets.reservations WHERE run_id=$1`,
      [runId],
    )
  ).rows[0];

function modelFailure(retryable: boolean) {
  return (error: unknown) =>
    error instanceof JobError &&
    error.code === "MODEL_CALL_FAILED" &&
    error.retryable === retryable;
}

test("maxCostUsdMicros rounds every component up and adds the per-request fee", () => {
  assert.equal(
    maxCostUsdMicros({ inputBytes: 8, maxOutputTokens: 1000, rate }),
    MAX_FOR_SMALL_PROMPT,
  );
  assert.equal(
    maxCostUsdMicros({
      inputBytes: 1,
      maxOutputTokens: 1,
      rate: { ...rate, perRequestUsdMicros: 0n },
    }),
    // ceil(3e6/1e6) + ceil(15e6/1e6)
    18n,
  );
  assert.equal(
    maxCostUsdMicros({
      inputBytes: 1,
      maxOutputTokens: 1,
      rate: {
        inputUsdMicrosPerMillionTokens: 1n,
        outputUsdMicrosPerMillionTokens: 1n,
        perRequestUsdMicros: 0n,
      },
    }),
    2n,
  );
  assert.throws(() =>
    maxCostUsdMicros({ inputBytes: -1, maxOutputTokens: 1, rate }),
  );
});

test("the fixture gateway bills exactly the bytes it returns and never exceeds the maximum", async () => {
  const outputs = new Map<string, string>();
  const gateway = fixtureModelGateway({
    rates: { "fixture-model": rate },
    respond: (r) => outputs.get(r.promptHash)!,
  });
  const call = (output: string, maxOutputTokens: number) => {
    const promptHash = "0x" + outputs.size;
    outputs.set(promptHash, output);
    return {
      runId: "11111111-1111-4111-8111-111111111111",
      model: "fixture-model",
      promptHash,
      system: "sys",
      input: "héllo",
      maxOutputTokens,
      reservationId: "r",
    };
  };
  const inputTokens = new TextEncoder().encode("syshéllo").length;
  const cost = (outputTokens: number) =>
    usageCostUsdMicros({ inputTokens, outputTokens, rate });

  // Oversized output is cut to the byte limit and billed as returned.
  const oversized = await gateway.call(call("x".repeat(50), 10));
  assert.equal(oversized.output, "x".repeat(10));
  assert.equal(oversized.actualUsdMicros, cost(10));
  assert.equal(
    oversized.actualUsdMicros,
    maxCostUsdMicros({ inputBytes: inputTokens, maxOutputTokens: 10, rate }),
  );
  // A multi-byte character is never split: 3 bytes hold one two-byte character.
  const multibyte = await gateway.call(call("ééé", 3));
  assert.equal(multibyte.output, "é");
  assert.equal(multibyte.actualUsdMicros, cost(2));
  assert.equal((await gateway.call(call("ééé", 4))).output, "éé");
  assert.equal((await gateway.call(call("ééé", 1))).output, "");
  // A leading byte order mark is returned, not silently dropped, because it is billed.
  const bom = await gateway.call(call("﻿A", 10));
  assert.equal(bom.output, "﻿A");
  assert.equal(bom.actualUsdMicros, cost(4));
  // Output within the limit is returned untouched and billed by its own bytes.
  const short = call("ok", 10);
  const first = await gateway.call(short);
  assert.equal(first.output, "ok");
  assert.equal(first.actualUsdMicros, cost(2));
  assert.deepEqual(await gateway.call(short), first);
  assert.equal(gateway.provider, "fixture");
  assert.equal(first.providerRequestId, "fixture-" + short.runId);
  assert.equal(gateway.rate("unknown"), null);
  const failing = fixtureModelGateway({
    provider: "other",
    rates: {},
    respond: () => new ModelCallError("NOT_SENT"),
  });
  assert.equal(failing.provider, "other");
  await assert.rejects(
    failing.call(short),
    (e) => e instanceof ModelCallError && e.kind === "NOT_SENT",
  );
});

test("success reserves the worst case then reconciles the reported cost", () =>
  withCaller(
    () => "ok",
    async (s, caller, ledger) => {
      const input = request({ jobId: randomUUID() });
      const result = await caller.call(input);
      assert.equal(result.output, "ok");
      assert.equal(result.providerRequestId, "fixture-" + input.runId);
      assert.equal(result.actualUsdMicros, FIXTURE_ACTUAL);
      assert.deepEqual(await reservationRow(s, input.runId), {
        state: "RECONCILED",
        provider: "fixture",
        model: "fixture-model",
        max: String(MAX_FOR_SMALL_PROMPT),
        actual: String(FIXTURE_ACTUAL),
        provider_request_id: "fixture-" + input.runId,
      });
      assert.deepEqual(await ledger.totals(), {
        spentUsdMicros: FIXTURE_ACTUAL,
        reservedUsdMicros: 0n,
        unknownUsdMicros: 0n,
      });
      assert.equal(
        (
          await s.pool.query(
            "SELECT job_id FROM budgets.reservations WHERE id=$1",
            [result.reservationId],
          )
        ).rows[0].job_id,
        input.jobId,
      );
    },
  ));

test("a missing provider cost reconciles at the reserved maximum", () =>
  withCaller(
    () => "unused",
    async (s, caller) => {
      const input = request();
      const result = await caller.call(input);
      assert.equal(result.actualUsdMicros, null);
      assert.equal(
        (await reservationRow(s, input.runId)).actual,
        String(MAX_FOR_SMALL_PROMPT),
      );
    },
    () => ({
      provider: "inline",
      rate: () => rate,
      call: async () => ({
        output: "x",
        providerRequestId: "inline-1",
        actualUsdMicros: null,
      }),
    }),
  ));

test("NOT_SENT releases the reservation and is retryable", () =>
  withCaller(
    () => new ModelCallError("NOT_SENT"),
    async (s, caller, ledger) => {
      const input = request();
      await assert.rejects(caller.call(input), modelFailure(true));
      assert.equal((await reservationRow(s, input.runId)).state, "RELEASED");
      assert.deepEqual(await ledger.totals(), {
        spentUsdMicros: 0n,
        reservedUsdMicros: 0n,
        unknownUsdMicros: 0n,
      });
    },
  ));

test("UNKNOWN keeps the reservation occupied and is not retryable", () =>
  withCaller(
    () => new ModelCallError("UNKNOWN", undefined, "req-lost"),
    async (s, caller, ledger) => {
      const input = request();
      await assert.rejects(caller.call(input), modelFailure(false));
      const row = await reservationRow(s, input.runId);
      assert.equal(row.state, "UNKNOWN");
      assert.equal(row.provider_request_id, "req-lost");
      assert.equal(
        (await ledger.totals()).unknownUsdMicros,
        MAX_FOR_SMALL_PROMPT,
      );
    },
  ));

test("an unexpected gateway exception is treated as UNKNOWN, never as free", () =>
  withCaller(
    () => "unused",
    async (s, caller) => {
      const input = request();
      await assert.rejects(caller.call(input), modelFailure(false));
      assert.equal((await reservationRow(s, input.runId)).state, "UNKNOWN");
    },
    () => ({
      provider: "broken",
      rate: () => rate,
      call: async () => {
        throw new TypeError("socket reset");
      },
    }),
  ));

test("FAILED_WITH_USAGE reconciles the reported usage", () =>
  withCaller(
    () => new ModelCallError("FAILED_WITH_USAGE", 777n, "req-billed"),
    async (s, caller, ledger) => {
      const input = request();
      await assert.rejects(caller.call(input), modelFailure(true));
      const row = await reservationRow(s, input.runId);
      assert.equal(row.state, "RECONCILED");
      assert.equal(row.actual, "777");
      assert.equal(row.provider_request_id, "req-billed");
      assert.equal((await ledger.totals()).spentUsdMicros, 777n);
    },
  ));

test("usage above the reservation is recorded in full and closes the gate", () =>
  withCaller(
    () =>
      new ModelCallError(
        "FAILED_WITH_USAGE",
        MAX_FOR_SMALL_PROMPT + 1n,
        "req-over",
      ),
    async (s, caller) => {
      const input = request();
      await assert.rejects(caller.call(input), modelFailure(true));
      assert.equal(
        (await reservationRow(s, input.runId)).actual,
        String(MAX_FOR_SMALL_PROMPT + 1n),
      );
      await assert.rejects(
        caller.call(request()),
        (e) => e instanceof JobError && e.code === "BUDGET_GATE_CLOSED",
      );
    },
  ));

test("FAILED_WITH_USAGE without usable usage stays UNKNOWN", () =>
  withCaller(
    () => new ModelCallError("FAILED_WITH_USAGE"),
    async (s, caller) => {
      const input = request();
      await assert.rejects(caller.call(input), modelFailure(true));
      assert.equal((await reservationRow(s, input.runId)).state, "UNKNOWN");
    },
  ));

test("a model without a rate is refused before any reservation exists", () =>
  withCaller(
    () => "ok",
    async (s, caller) => {
      await assert.rejects(
        caller.call(request({ model: "unpriced" })),
        (e) =>
          e instanceof JobError &&
          e.code === "MODEL_RATE_UNKNOWN" &&
          e.retryable === false,
      );
      assert.equal(
        (await s.pool.query("SELECT id FROM budgets.reservations")).rows.length,
        0,
      );
    },
  ));

test("an exhausted budget stops the call before the provider is reached", () => {
  let reached = false;
  return withCaller(
    () => {
      reached = true;
      return "ok";
    },
    async (_s, caller) => {
      await assert.rejects(
        caller.call(request({ questionCapUsdMicros: 1000n })),
        (e) => e instanceof JobError && e.code === "BUDGET_EXHAUSTED",
      );
      assert.equal(reached, false);
    },
  );
});

test("a retry is a new run and does not release an unknown earlier attempt", () => {
  let first = true;
  return withCaller(
    () => {
      if (first) {
        first = false;
        return new ModelCallError("UNKNOWN");
      }
      return "ok";
    },
    async (_s, caller, ledger) => {
      await assert.rejects(caller.call(request()), modelFailure(false));
      await caller.call(request());
      assert.deepEqual(await ledger.totals(), {
        spentUsdMicros: FIXTURE_ACTUAL,
        reservedUsdMicros: 0n,
        unknownUsdMicros: MAX_FOR_SMALL_PROMPT,
      });
    },
  );
});

test("a request that was never sent does not use up the question's budget", () => {
  let first = true;
  return withCaller(
    () => {
      if (first) {
        first = false;
        return new ModelCallError("NOT_SENT");
      }
      return "ok";
    },
    async (_s, caller, ledger) => {
      // The cap fits exactly one worst-case request.
      const tight = { questionCapUsdMicros: MAX_FOR_SMALL_PROMPT };
      await assert.rejects(caller.call(request(tight)), modelFailure(true));
      await caller.call(request(tight));
      assert.equal((await ledger.totals()).spentUsdMicros, FIXTURE_ACTUAL);
    },
  );
});
