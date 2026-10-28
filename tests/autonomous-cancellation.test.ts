import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
  test(`autonomous launcher cleans its detached group on ${signal}`, { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "blink-launcher-"));
    const marker = join(dir, "group.json");
    const launcherPath = join(dir, "launcher.mjs");
    // The leader reaps its child before exiting, so a leftover group is not an orphaned zombie.
    const leader = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
      child.once('exit', () => process.exit(0));
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ group: process.pid, descendant: child.pid }));
    `;
    const helper = pathToFileURL(join(process.cwd(), "tests/helpers/process-group.ts")).href;
    await writeFile(launcherPath, `
      import { runProcessGroup } from ${JSON.stringify(helper)};
      ${signal === "exit" ? "process.on('SIGTERM', () => process.exit(0));" : ""}
      await runProcessGroup(['-e', ${JSON.stringify(leader)}]);
    `);
    const launcher = spawn(process.execPath, ["--import", "tsx", launcherPath], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(launcher, "close");
    let output = "";
    launcher.stdout.on("data", (chunk) => (output += chunk));
    launcher.stderr.on("data", (chunk) => (output += chunk));
    let group: number | undefined;
    let descendant: number | undefined;
    try {
      for (let i = 0; i < 100; i++) {
        const record = await readFile(marker, "utf8").catch(() => null);
        if (record) { ({ group, descendant } = JSON.parse(record)); break; }
        if (launcher.exitCode !== null) break;
        await delay(50);
      }
      assert.ok(group && descendant, output || "launcher never started its group");
      launcher.kill(signal === "exit" ? "SIGTERM" : signal);
      await closed;
      assert.equal(launcher.exitCode, signal === "exit" ? 0 : signal === "SIGINT" ? 130 : 143, output);
      // Exit cleanup is synchronous SIGKILL; allow the OS to finish removing the group.
      for (let i = 0; i < 40; i++) {
        try { process.kill(-group, 0); } catch { break; }
        await delay(50);
      }
      assert.throws(() => process.kill(-group!, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(descendant!, 0), { code: "ESRCH" });
    } finally {
      launcher.kill("SIGKILL");
      if (group) try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
      await closed;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
