import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runProcessGroup } from "../helpers/process-group.ts";

const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
const skip = adminUrl
  ? false
  : "TEST_POSTGRES_ADMIN_URL is not set: autonomous drill requires PostgreSQL";
if (skip) console.error("autonomous test skipped: " + skip);

function run(args: string[], env: NodeJS.ProcessEnv = process.env, hardTimeoutMs = 28 * 60_000) {
  return runProcessGroup(["--import", "tsx", "scripts/alpha-autonomous.ts", ...args], env, hardTimeoutMs);
}

test("every autonomous scenario passes", { skip, timeout: 1_800_000 }, async () => {
  const result = await run(["--backend", "postgres"]);
  assert.equal(result.code, 0, result.output);
  const report = JSON.parse(await readFile("tmp/alpha-autonomous/report.json", "utf8"));
  assert.ok(Object.values(report.scenarios).length >= 5);
  for (const [name, scenario] of Object.entries(report.scenarios))
    assert.equal((scenario as { status: string }).status, "pass", name);
  await writeFile("tmp/alpha-autonomous/postgres-report.json", JSON.stringify(report, null, 2) + "\n");
});

test("drill reports a stalled scenario by name", { skip, timeout: 240_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-autonomous-stall-"));
  try {
    const defaultPath = "examples/agents/worlds/drill.json";
    const world = JSON.parse(await readFile(defaultPath, "utf8"));
    delete world.agents.keeper;
    const worldPath = join(dir, "world.json");
    await mkdir(join(dir, "sources"));
    await copyFile("examples/agents/worlds/sources/normal.txt", join(dir, "sources/normal.txt"));
    await writeFile(worldPath, JSON.stringify(world));
    const result = await run(
      ["--backend", "postgres", "--world", worldPath, "--timeout-deadline-seconds", "60"],
      { ...process.env, BLINK_AUTONOMOUS_WORLD: worldPath },
      180_000,
    );
    assert.notEqual(result.code, 0, result.output);
    const report = JSON.parse(await readFile("tmp/alpha-autonomous/report.json", "utf8"));
    assert.equal(report.result, "fail");
    assert.equal(report.scenarios.timeout.status, "fail");
    assert.match(report.scenarios.timeout.error, /SCENARIO_TIMEOUT:timeout /);
    assert.match(report.error, /SCENARIO_TIMEOUT:timeout /);
    assert.equal(report.lastIndexedStates.timeout, "PENDING");
    assert.match(result.output, /Last indexed states/);
    assert.match(result.output, /Last agent log lines:/);
    assert.ok(result.output.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
