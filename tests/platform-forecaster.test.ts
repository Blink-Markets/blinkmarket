import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { keccak256 } from "viem";
import { JobError } from "../packages/domain/src/jobs.ts";
import {
  EVIDENCE_HEADER,
  FORECAST_PROMPTS,
  forecastPrompt,
} from "../packages/domain/src/prompts.ts";
import type { PlatformRole } from "../packages/domain/src/prompts.ts";
import { MarketView } from "../packages/schemas/src/research.ts";
import type {
  JobQueue,
  JobSpec,
  ModelGateway,
} from "../packages/ports/src/index.js";
import { postgresPlatformRunStore } from "../packages/adapters/src/platform-run-store.js";
import {
  createForecastDispatchHandler,
  createForecastRunHandler,
} from "../packages/application/src/platform-forecaster.js";
import {
  hashText,
  recordingPool,
  researchFixture,
  testRate,
} from "./helpers/research.js";

const hash = (bytes: Uint8Array) => keccak256(bytes);
const MODELS = {
  FORECASTER_A: "model-a",
  FORECASTER_B: "model-b",
  BASELINE: "model-base",
} as const;
const PROBABILITY = { "model-a": 0.61, "model-b": 0.62, "model-base": 0.5 };
const BUDGET = 1_500_000n;
const jobError = (code: string, retryable: boolean) => (error: unknown) =>
  error instanceof JobError &&
  error.code === code &&
  error.retryable === retryable;
const idsIn = (input: string) =>
  [...input.matchAll(new RegExp(`^${EVIDENCE_HEADER}(.+)$`, "gm"))].map(
    (match) => match[1]!,
  );

interface SetupOptions {
  respond?: (request: { model: string; input: string; call: number }) => string;
  wrap?: (gateway: ModelGateway) => ModelGateway;
  budgetMicros?: bigint;
  deadlineInSeconds?: number;
  hashes?: Partial<Record<PlatformRole, string>>;
  statements?: string[];
}
async function setup(options: SetupOptions = {}) {
  const r = await researchFixture();
  try {
    return await build(r, options);
  } catch (error) {
    // The fixture owns a listening server; a failed setup must not leave it running.
    await r.close();
    throw error;
  }
}
async function build(
  r: Awaited<ReturnType<typeof researchFixture>>,
  options: SetupOptions,
) {
  const sourceId = await r.addSource();
  const operatorId = r.agents.discovery.operatorId;
  const early = await r.addEvidence({
    sourceId,
    operatorId,
    text: "EARLY filing text",
    observedAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  const late = await r.addEvidence({
    sourceId,
    operatorId,
    text: "LATE filing text published after the cutoff",
    observedAt: new Date(Date.now() - 600_000).toISOString(),
  });
  const market = await r.addMarket({
    evidenceIds: [early.evidenceId, late.evidenceId],
    budgetMicros: options.budgetMicros ?? BUDGET,
  });
  for (const role of Object.keys(MODELS) as PlatformRole[])
    await r.registerAgent(
      role,
      MODELS[role],
      options.hashes?.[role] ?? hashText(FORECAST_PROMPTS[role]),
    );
  const windowId = await r.addWindow(options.deadlineInSeconds ?? 600);
  let calls = 0;
  const inputs: string[] = [];
  const model = r.modelCaller(
    (request) => {
      calls += 1;
      inputs.push(request.input);
      const respond =
        options.respond ??
        ((req) =>
          JSON.stringify({
            probability: PROBABILITY[req.model as keyof typeof PROBABILITY],
            rationale: "Fixture rationale.",
            evidenceIds: idsIn(req.input).slice(0, 1),
          }));
      return respond({
        model: request.model,
        input: request.input,
        call: calls,
      });
    },
    {
      "model-a": testRate,
      "model-b": testRate,
      "model-base": testRate,
    },
    options.wrap,
  );
  const pool = options.statements
    ? recordingPool(r.worker, options.statements)
    : r.worker;
  const store = postgresPlatformRunStore(pool);
  const common = {
    store,
    objects: r.objects,
    model,
    apis: r.clients,
    hash,
    newId: randomUUID,
  };
  const forecast = createForecastRunHandler({
    ...common,
    roles: ["FORECASTER_A", "FORECASTER_B"],
  });
  const baseline = createForecastRunHandler({
    ...common,
    roles: ["BASELINE"],
  });
  const run = (
    handler: typeof forecast,
    role: PlatformRole,
    window = windowId,
  ) =>
    handler({
      job: { id: randomUUID(), payload: { windowId: window, role } },
      signal: new AbortController().signal,
    });
  const runs = () =>
    r.query<{
      id: string;
      agent_id: string;
      purpose: string;
      state: string;
      submission_id: string | null;
      reservation_id: string | null;
      prompt_hash: string;
      input_hash: string;
      data_cutoff: Date;
    }>(
      `SELECT id,agent_id,purpose,state,submission_id,reservation_id,
              '0x'||encode(prompt_hash,'hex') AS prompt_hash,
              '0x'||encode(input_hash,'hex') AS input_hash,data_cutoff
       FROM forecasts.model_runs ORDER BY created_at,id`,
    );
  const submissions = () =>
    r.query<{ agent_id: string; probability: number; evidence_ids: string[] }>(
      "SELECT agent_id,probability::float8 AS probability,evidence_ids FROM forecasts.submissions ORDER BY agent_id",
    );
  const reservations = () =>
    r.query<{ run_id: string; question_key: string; cap: string }>(
      `SELECT r.run_id,r.question_key,q.cap_usd_micros::text AS cap
       FROM budgets.reservations r JOIN budgets.questions q USING (question_key)
       ORDER BY r.created_at`,
    );
  return {
    r,
    early,
    late,
    market,
    windowId,
    store,
    forecast,
    baseline,
    run,
    runs,
    submissions,
    reservations,
    inputs,
    calls: () => calls,
  };
}

test("A and B submit with their own keys and the baseline under its agent, keyed by run id", async () => {
  const s = await setup();
  try {
    await s.run(s.forecast, "FORECASTER_A");
    await s.run(s.forecast, "FORECASTER_B");
    await s.run(s.baseline, "BASELINE");
    const submissions = await s.submissions();
    const byAgent = new Map(submissions.map((x) => [x.agent_id, x]));
    assert.equal(submissions.length, 3);
    assert.equal(
      byAgent.get(s.r.agents.FORECASTER_A.agentId)!.probability,
      0.61,
    );
    assert.equal(
      byAgent.get(s.r.agents.FORECASTER_B.agentId)!.probability,
      0.62,
    );
    assert.equal(byAgent.get(s.r.agents.BASELINE.agentId)!.probability, 0.5);
    for (const submission of submissions)
      assert.deepEqual(submission.evidence_ids, [s.early.evidenceId]);

    const runs = await s.runs();
    assert.deepEqual(
      runs.map((x) => [x.purpose, x.state]),
      [
        ["FORECAST", "SUBMITTED"],
        ["FORECAST", "SUBMITTED"],
        ["BASELINE", "SUBMITTED"],
      ],
    );
    const [window] = await s.r.query<{ open_at: Date }>(
      "SELECT open_at FROM forecasts.windows WHERE id=$1",
      [s.windowId],
    );
    for (const run of runs) {
      assert.ok(run.submission_id && run.reservation_id);
      assert.deepEqual(run.data_cutoff, window!.open_at);
    }
    const agentRun = (role: PlatformRole) =>
      runs.find((x) => x.agent_id === s.r.agents[role].agentId)!;
    for (const role of ["FORECASTER_A", "FORECASTER_B", "BASELINE"] as const) {
      const prompt = forecastPrompt(
        role,
        JSON.parse(
          new TextDecoder().decode(s.r.specObjects.objects.get("memory:spec")!),
        ),
        [{ evidenceId: s.early.evidenceId, text: "EARLY filing text" }],
      );
      assert.equal(agentRun(role).prompt_hash, hashText(prompt.system));
      assert.equal(agentRun(role).input_hash, hashText(prompt.input));
    }
    // The submission idempotency key is the model run id.
    const keys = await s.r.query<{ key: string }>(
      "SELECT key FROM operations.idempotency_records WHERE endpoint_scope='POST /v1/markets/1/forecasts' ORDER BY key",
    );
    assert.deepEqual(
      keys.map((x) => x.key),
      runs.map((x) => x.id).sort(),
    );
    // Budget: one question per candidate, capped by the approval's research budget.
    const reservations = await s.reservations();
    assert.equal(reservations.length, 3);
    for (const reservation of reservations) {
      assert.equal(
        reservation.question_key,
        "candidate:" + s.market.candidateId,
      );
      assert.equal(reservation.cap, String(BUDGET));
    }
  } finally {
    await s.r.close();
  }
});

test("evidence observed after the data cutoff never reaches the prompt or a citation", async () => {
  const s = await setup();
  try {
    await s.run(s.forecast, "FORECASTER_A");
    const input = s.inputs[0]!;
    assert.match(input, /EARLY filing text/);
    assert.ok(input.includes(EVIDENCE_HEADER + s.early.evidenceId));
    assert.doesNotMatch(input, /LATE filing text/);
    assert.ok(!input.includes(s.late.evidenceId));
  } finally {
    await s.r.close();
  }
});

test("a citation outside the allowed evidence is a schema error: one retry, then a final non-retryable failure", async () => {
  let lateId = "";
  const s = await setup({
    respond: () =>
      JSON.stringify({
        probability: 0.4,
        rationale: "Cites the late filing.",
        evidenceIds: [lateId],
      }),
  });
  lateId = s.late.evidenceId;
  try {
    await assert.rejects(
      s.run(s.forecast, "FORECASTER_A"),
      jobError("SCHEMA_INVALID", false),
    );
    assert.equal(s.calls(), 2);
    assert.deepEqual(
      (await s.runs()).map((x) => x.state),
      ["SCHEMA_INVALID", "SCHEMA_INVALID"],
    );
    assert.equal((await s.submissions()).length, 0);
    assert.equal((await s.reservations()).length, 2);
  } finally {
    await s.r.close();
  }
});

test("one schema error is retried with a new run and the retry's id keys the submission", async () => {
  const s = await setup({
    respond: ({ call, input }) =>
      call === 1
        ? '{"probability":0.1234567,"rationale":"too precise","evidenceIds":[]}'
        : JSON.stringify({
            probability: 0.7,
            rationale: "Second try.",
            evidenceIds: idsIn(input),
          }),
  });
  try {
    await s.run(s.forecast, "FORECASTER_A");
    const runs = await s.runs();
    assert.deepEqual(
      runs.map((x) => x.state),
      ["SCHEMA_INVALID", "SUBMITTED"],
    );
    const [submission] = await s.submissions();
    assert.equal(submission!.probability, 0.7);
    assert.deepEqual(submission!.evidence_ids, [s.early.evidenceId]);
    const keys = await s.r.query<{ key: string }>(
      "SELECT key FROM operations.idempotency_records WHERE endpoint_scope='POST /v1/markets/1/forecasts'",
    );
    assert.deepEqual(keys, [{ key: runs[1]!.id }]);
    assert.equal((await s.reservations()).length, 2);
  } finally {
    await s.r.close();
  }
});

test("a submission the database clock finds late is LATE: no retry and no second model call", async () => {
  const s = await setup({
    wrap: (gateway) => ({
      ...gateway,
      async call(request) {
        // The model "takes" ten minutes: the window closes while it thinks.
        await s.r.asOwner(() =>
          s.r.t.db.query(
            "SELECT set_config('blink.test_clock_offset_seconds','700',false)",
          ),
        );
        return gateway.call(request);
      },
    }),
  });
  try {
    await s.run(s.forecast, "FORECASTER_A");
    assert.deepEqual(
      (await s.runs()).map((x) => x.state),
      ["LATE"],
    );
    assert.equal((await s.submissions()).length, 0);
    assert.equal(s.calls(), 1);
    // The settled LATE run is not repeated on redelivery.
    await s.run(s.forecast, "FORECASTER_A");
    assert.equal(s.calls(), 1);
    assert.equal((await s.runs()).length, 1);
  } finally {
    await s.r.close();
  }
});

test("a window that is already closed is LATE without any model call", async () => {
  const s = await setup({ deadlineInSeconds: -10 });
  try {
    await s.run(s.forecast, "FORECASTER_B");
    assert.deepEqual(
      (await s.runs()).map((x) => x.state),
      ["LATE"],
    );
    assert.equal(s.calls(), 0);
    assert.equal((await s.reservations()).length, 0);
  } finally {
    await s.r.close();
  }
});

test("a prompt that does not match the registered hash fails without a model call or retry", async () => {
  const s = await setup({
    hashes: { FORECASTER_A: hashText("an older prompt version") },
  });
  try {
    await assert.rejects(
      s.run(s.forecast, "FORECASTER_A"),
      jobError("PROMPT_MISMATCH", false),
    );
    assert.equal(s.calls(), 0);
    assert.equal((await s.runs()).length, 0);
    // The other forecaster, registered with the right hash, is unaffected.
    await s.run(s.forecast, "FORECASTER_B");
    assert.equal((await s.submissions()).length, 1);
  } finally {
    await s.r.close();
  }
});

test("an exhausted research budget fails the run without a model call", async () => {
  const s = await setup({ budgetMicros: 1n });
  try {
    await assert.rejects(
      s.run(s.forecast, "FORECASTER_A"),
      jobError("BUDGET_EXHAUSTED", false),
    );
    assert.equal(s.calls(), 0);
    assert.deepEqual(
      (await s.runs()).map((x) => x.state),
      ["FAILED"],
    );
    assert.equal((await s.submissions()).length, 0);
  } finally {
    await s.r.close();
  }
});

test("the runner never reads submissions or snapshots, and the worker role cannot", async () => {
  const statements: string[] = [];
  const s = await setup({ statements });
  try {
    await s.run(s.forecast, "FORECASTER_A");
    await s.run(s.baseline, "BASELINE");
    assert.ok(statements.length > 0);
    assert.equal(
      statements.filter((sql) => /forecasts\.(submissions|snapshots)/.test(sql))
        .length,
      0,
    );
    await s.r.t.setRole("blink_worker");
    await assert.rejects(
      s.r.t.db.query("SELECT * FROM forecasts.submissions"),
      /permission denied/,
    );
    await assert.rejects(
      s.r.t.db.query("SELECT * FROM forecasts.snapshots"),
      /permission denied/,
    );
    await s.r.t.setRole(null);
  } finally {
    await s.r.close();
  }
});

test("redelivery after a settled run makes no model call; an API refusal is a final failure", async () => {
  const s = await setup();
  try {
    await s.run(s.forecast, "FORECASTER_A");
    await s.run(s.forecast, "FORECASTER_A");
    assert.equal(s.calls(), 1);
    assert.equal((await s.submissions()).length, 1);
    // Lose the run record, as after a crash before it was updated: the forecast exists, the API says so.
    await s.r.query("DELETE FROM forecasts.model_runs");
    await assert.rejects(
      s.run(s.forecast, "FORECASTER_A"),
      jobError("FORECAST_ALREADY_SUBMITTED", false),
    );
    assert.deepEqual(
      (await s.runs()).map((x) => x.state),
      ["FAILED"],
    );
    assert.equal((await s.submissions()).length, 1);
  } finally {
    await s.r.close();
  }
});

test("a job cannot run a role it does not own, and an unregistered role fails for good", async () => {
  const s = await setup();
  try {
    await assert.rejects(
      s.run(s.baseline, "FORECASTER_A"),
      jobError("INVALID_PAYLOAD", false),
    );
    await assert.rejects(
      s.forecast({
        job: {
          id: randomUUID(),
          payload: { windowId: "nope", role: "FORECASTER_A" },
        },
        signal: new AbortController().signal,
      }),
      jobError("INVALID_PAYLOAD", false),
    );
    await assert.rejects(
      s.run(s.forecast, "FORECASTER_A", randomUUID()),
      jobError("WINDOW_NOT_FOUND", false),
    );
    assert.equal(s.calls(), 0);
  } finally {
    await s.r.close();
  }
});

test("dispatch enqueues each configured role once for open windows of open markets only", async () => {
  const s = await setup();
  try {
    await s.r.addWindow(-10);
    const queued: JobSpec[] = [];
    const queue = {
      async enqueue(spec: JobSpec) {
        const created = !queued.some((q) => q.dedupeKey === spec.dedupeKey);
        if (created) queued.push(spec);
        return { jobId: randomUUID(), created };
      },
    } as unknown as JobQueue;
    const dispatch = createForecastDispatchHandler({
      store: s.store,
      queue,
      roles: ["FORECASTER_A", "FORECASTER_B", "BASELINE"],
    });
    const ctx = {
      job: { id: randomUUID(), payload: {} },
      signal: new AbortController().signal,
    };
    await dispatch(ctx);
    await dispatch(ctx);
    assert.deepEqual(
      queued.map((q) => [q.type, q.dedupeKey, q.payload]),
      [
        [
          "forecast.run",
          `forecast.run:${s.windowId}:FORECASTER_A`,
          { windowId: s.windowId, role: "FORECASTER_A" },
        ],
        [
          "forecast.run",
          `forecast.run:${s.windowId}:FORECASTER_B`,
          { windowId: s.windowId, role: "FORECASTER_B" },
        ],
        [
          "baseline.run",
          `forecast.run:${s.windowId}:BASELINE`,
          { windowId: s.windowId, role: "BASELINE" },
        ],
      ],
    );
    // A market that is no longer OPEN is skipped.
    await s.r.query("UPDATE chain.markets SET state='FINAL'");
    queued.length = 0;
    await dispatch(ctx);
    assert.equal(queued.length, 0);
  } finally {
    await s.r.close();
  }
});

test("the client lists forecast windows and the market through the real API", async () => {
  const s = await setup();
  try {
    const client = s.r.clients.FORECASTER_A;
    const windows = (await client.listForecastWindows({
      deploymentId: "d1",
      marketId: "1",
    })) as { items: { windowId: string; status: string }[] };
    assert.deepEqual(
      windows.items.map((w) => [w.windowId, w.status]),
      [[s.windowId, "OPEN"]],
    );
    const market = MarketView.parse(
      await client.getMarket({
        deploymentId: "d1",
        marketId: "1",
        mode: "REPLAY",
      }),
    );
    assert.equal(market.specHash, s.market.specHash);
    assert.deepEqual(market.spec.sourceEvidenceIds, [
      s.early.evidenceId,
      s.late.evidenceId,
    ]);
  } finally {
    await s.r.close();
  }
});
