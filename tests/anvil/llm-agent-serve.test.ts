import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const READY_TIMEOUT_MS = 200_000;
const EXIT_TIMEOUT_MS = 60_000;

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "alpha:serve prints the platform URLs, serves the deployment and exits 0 on SIGINT with no process left",
  { timeout: 300_000 },
  async () => {
    // detached: its own process group, so Anvil and the services can be checked after it exits.
    const child = spawn("pnpm", ["alpha:serve"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pgid = child.pid!;
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (!out.includes("READY")) {
        assert.ok(child.exitCode === null, `alpha:serve exited early: ${err}${out}`);
        assert.ok(Date.now() < deadline, `alpha:serve not ready: ${err}${out}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      const apiUrl = /^BLINK_API_URL=(\S+)$/m.exec(out)?.[1];
      const rpcUrl = /^BLINK_RPC_URL=(\S+)$/m.exec(out)?.[1];
      assert.match(apiUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(rpcUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(out, /^FUNDED_TEST_ACCOUNT=0x[0-9a-fA-F]{40} /m);
      assert.doesNotMatch(out, /0x[0-9a-fA-F]{64}/);
      const response = await fetch(`${apiUrl}/v1/deployment`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { deployment: { chainId: number } };
      assert.equal(body.deployment.chainId, 84532);

      process.kill(pgid, "SIGINT");
      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no exit after SIGINT")), EXIT_TIMEOUT_MS)),
      ]);
      assert.deepEqual(result, { code: 0, signal: null });
      const goneBy = Date.now() + 10_000;
      while (processGroupAlive(pgid) && Date.now() < goneBy) await new Promise((r) => setTimeout(r, 100));
      assert.equal(processGroupAlive(pgid), false, "a process of the group is still alive");
    } finally {
      if (processGroupAlive(pgid)) process.kill(-pgid, "SIGKILL");
    }
  },
);
