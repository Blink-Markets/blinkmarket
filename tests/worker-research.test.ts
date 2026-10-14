import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { researchConfig } from "../apps/worker/src/config.js";
import { buildResearch } from "../apps/worker/src/handlers.js";
import { postgresJobQueue } from "../packages/adapters/src/job-queue.js";
import { createTestDatabase } from "./helpers/database.js";
import { poolAs } from "./helpers/research.js";

const fixtures = new URL(
  "../fixtures/replay/models/gm-replay.json",
  import.meta.url,
).pathname;
const operator = randomUUID();
const evidence = {
  WORKER_EVIDENCE_DIRECTORY: "/var/blink/evidence",
  WORKER_PLATFORM_OPERATOR_ID: operator,
};
const agents = {
  WORKER_API_URL: "http://127.0.0.1:1",
  WORKER_MODEL_FIXTURES: fixtures,
  ...evidence,
};

test("research configuration is off unless present and all-or-nothing per feature", () => {
  assert.deepEqual(researchConfig({}), {
    evidence: null,
    api: null,
    modelFixtures: null,
    discovery: null,
    forecasters: {},
  });
  const full = researchConfig({
    ...agents,
    WORKER_DISCOVERY_API_KEY: " d ",
    WORKER_DISCOVERY_MODEL: "gm-replay-discovery",
    WORKER_FORECASTER_A_API_KEY: "a",
    WORKER_FORECASTER_B_API_KEY: "b",
    WORKER_BASELINE_API_KEY: "c",
  });
  assert.deepEqual(full, {
    evidence: {
      directory: "/var/blink/evidence",
      platformOperatorId: operator,
    },
    api: { url: "http://127.0.0.1:1" },
    modelFixtures: fixtures,
    discovery: { apiKey: "d", model: "gm-replay-discovery" },
    forecasters: { FORECASTER_A: "a", FORECASTER_B: "b", BASELINE: "c" },
  });
  const incomplete: [Record<string, string>, string][] = [
    [
      { WORKER_EVIDENCE_DIRECTORY: "/x" },
      "WORKER_EVIDENCE_CONFIGURATION_INCOMPLETE",
    ],
    [
      { WORKER_PLATFORM_OPERATOR_ID: operator },
      "WORKER_EVIDENCE_CONFIGURATION_INCOMPLETE",
    ],
    [
      { WORKER_EVIDENCE_DIRECTORY: "/x", WORKER_PLATFORM_OPERATOR_ID: "nope" },
      "INVALID_WORKER_PLATFORM_OPERATOR_ID",
    ],
    [
      { ...agents, WORKER_DISCOVERY_API_KEY: "d" },
      "WORKER_DISCOVERY_CONFIGURATION_INCOMPLETE",
    ],
    [
      {
        WORKER_DISCOVERY_API_KEY: "d",
        WORKER_DISCOVERY_MODEL: "m",
        ...evidence,
      },
      "WORKER_DISCOVERY_CONFIGURATION_INCOMPLETE",
    ],
    [
      { ...evidence, WORKER_FORECASTER_A_API_KEY: "a" },
      "WORKER_FORECASTER_CONFIGURATION_INCOMPLETE",
    ],
    [
      { ...agents, WORKER_API_URL: "", WORKER_BASELINE_API_KEY: "c" },
      "WORKER_FORECASTER_CONFIGURATION_INCOMPLETE",
    ],
  ];
  for (const [env, code] of incomplete)
    assert.throws(
      () => researchConfig(env),
      new RegExp("^Error: " + code + "$"),
    );
});

async function withWorker(
  env: Record<string, string>,
  run: (
    research: Awaited<ReturnType<typeof buildResearch>>,
    queue: ReturnType<typeof postgresJobQueue>,
    t: Awaited<ReturnType<typeof createTestDatabase>>,
  ) => Promise<void>,
) {
  const t = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "blink-worker-research-"));
  try {
    const pool = poolAs(t, "blink_worker");
    const queue = postgresJobQueue(pool);
    const research = await buildResearch({
      pool,
      queue,
      config: researchConfig({
        ...env,
        ...(env["WORKER_EVIDENCE_DIRECTORY"]
          ? { WORKER_EVIDENCE_DIRECTORY: directory }
          : {}),
      }),
    });
    await run(research, queue, t);
  } finally {
    await t.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const queued = async (t: Awaited<ReturnType<typeof createTestDatabase>>) => {
  await t.setRole(null);
  return (
    await t.db.query<{ type: string }>(
      "SELECT type FROM operations.jobs ORDER BY type",
    )
  ).rows.map((row) => row.type);
};

test("a worker without research configuration still schedules forecast windows and nothing else", async () => {
  await withWorker({}, async (research, _queue, t) => {
    assert.deepEqual(Object.keys(research.handlers), ["forecast.schedule"]);
    await research.tick();
    await research.tick();
    assert.deepEqual(await queued(t), ["forecast.schedule"]);
  });
});

test("evidence configuration alone registers only the fetcher", async () => {
  await withWorker(evidence, async (research) => {
    assert.deepEqual(Object.keys(research.handlers).sort(), [
      "evidence.fetch",
      "forecast.schedule",
    ]);
  });
});

test("full configuration registers every research job and its periodic schedule", async () => {
  await withWorker(
    {
      ...agents,
      WORKER_DISCOVERY_API_KEY: "d",
      WORKER_DISCOVERY_MODEL: "gm-replay-discovery",
      WORKER_FORECASTER_A_API_KEY: "a",
      WORKER_FORECASTER_B_API_KEY: "b",
      WORKER_BASELINE_API_KEY: "c",
    },
    async (research, _queue, t) => {
      assert.deepEqual(Object.keys(research.handlers).sort(), [
        "baseline.run",
        "discovery.scan",
        "evidence.fetch",
        "forecast.dispatch",
        "forecast.run",
        "forecast.schedule",
      ]);
      await t.db.exec("RESET ROLE");
      const sourceId = randomUUID();
      await t.db.query(
        "INSERT INTO evidence.sources(id,entity_id,source_url,fetch_enabled) VALUES ($1,'ACME','https://ir.example.test/a',true)",
        [sourceId],
      );
      await t.db.query(
        "INSERT INTO evidence.sources(id,entity_id,source_url) VALUES ($1,'OTHER','https://ir.example.test/b')",
        [randomUUID()],
      );
      await research.tick();
      await research.tick();
      assert.deepEqual(await queued(t), [
        "discovery.scan",
        "forecast.dispatch",
        "forecast.schedule",
      ]);
    },
  );
});
