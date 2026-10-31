import { test } from "node:test";
import assert from "node:assert/strict";

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
    await put("apps/web/bad.ts", 'import { shots } from "../../video/src/script.ts";\n');
    await put("video/src/bad.ts", 'import x from "../../apps/web/x";\n');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [resolve("scripts/check-boundaries.mjs")], { cwd: dir, encoding: "utf8", env });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout + result.stderr, /apps\/web\/package.json: forbidden dependency @blink\/video/);
    assert.match(result.stdout + result.stderr, /apps\/web\/bad\.ts: imports the video workspace/);
    assert.match(result.stdout + result.stderr, /video\/src\/bad\.ts: forbidden video import/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
