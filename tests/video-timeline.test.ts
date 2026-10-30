import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scenes } from "../video/src/script.ts";
import { sceneFrames, scenarioCards } from "../video/src/timeline.ts";
import { FOR_AGENTS, FOR_PEOPLE } from "../apps/web/content/positioning.ts";
import run from "../video/data/drill-run.json" with { type: "json" };

test("scenes are contiguous and add up to the script's length", () => {
  const frames = sceneFrames(scenes, 30);
  frames.forEach((f, i) => assert.equal(f.from, i === 0 ? 0 : frames[i - 1]!.from + frames[i - 1]!.durationInFrames));
  const total = scenes.reduce((s, x) => s + x.seconds, 0);
  assert.ok(total >= 120 && total <= 180, String(total));
});
test("the first scene states both positioning lines", () => {
  assert.ok(scenes[0]!.lines.includes(FOR_PEOPLE) && scenes[0]!.lines.includes(FOR_AGENTS));
});
test("every on-screen line appears verbatim in the script doc", () => {
  const doc = readFileSync("docs/INTRO_VIDEO_SCRIPT.md", "utf8");
  for (const s of scenes) for (const line of s.lines) assert.ok(doc.includes(line), `${s.id}: ${line}`);
});
test("scenario cards come from the real run record", () => {
  const cards = scenarioCards(run as Parameters<typeof scenarioCards>[0]);
  assert.deepEqual(cards.map((c) => c.name), run.scenarios.map((s) => s.name));
  for (const c of cards) assert.equal(c.durationSeconds, run.scenarios.find((s) => s.name === c.name)!.durationSeconds);
});
test("a scenario card lists only events with its market ID", () => {
  const cards = scenarioCards(run as Parameters<typeof scenarioCards>[0]);
  const normal = cards.find((c) => c.name === "normal")!;
  assert.ok(normal.events.length > 0 && !normal.events.some((e) => /committed|revealed|suggestion_claimed/.test(e)), normal.events.join("\n"));
});

test("boundary checker rejects video dependencies and cross-workspace imports", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  await mkdir("tmp", { recursive: true });
  const dir = await mkdtemp(resolve("tmp/video-boundaries-"));
  const put = async (path: string, content: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  };
  try {
    for (const name of ["schemas", "domain", "ports", "application", "adapters", "runtime", "client"]) {
      await put(`packages/${name}/package.json`, "{}");
      await put(`packages/${name}/src/index.ts`, "export {};\n");
    }
    await put("apps/web/package.json", '{"devDependencies":{"@blink/video":"workspace:*"}}');
    await put("apps/worker/package.json", "{}");
    await put("video/src/bad.ts", 'import x from "../../apps/web/x";\n');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [resolve("scripts/check-boundaries.mjs")], { cwd: dir, encoding: "utf8", env });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout + result.stderr, /apps\/web\/package.json: forbidden dependency @blink\/video/);
    assert.match(result.stdout + result.stderr, /video\/src\/bad.ts: forbidden video import/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
