import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ALPHA_DEADLINE_MS, runLocalAlpha } from "../../scripts/local-alpha.ts";
import { databaseTraces, leakedTraces } from "../helpers/postgres-traces.js";

// Anvil processes started by this process (tsx may keep an esbuild child of its own).
const anvils = () =>
  spawnSync("pgrep", ["-P", String(process.pid), "-f", "/bin/anvil"], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean);

test("local Alpha refuses to start without an explicit PostgreSQL administrator", () => {
  const env = { ...process.env };
  delete env.TEST_POSTGRES_ADMIN_URL;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/local-alpha.ts"],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_POSTGRES_ADMIN_URL_REQUIRED/);
});

// Aborts a real run at several points, from before Anvil exists through mid-scenario, and
// requires that nothing is left behind: no Anvil, no random database, no service login.
for (const point of [undefined, 0, 150, 300, 600]) {
  test(
    `an aborted run fails with its stage and leaves nothing behind (${point === undefined ? "at once" : `${point} ms after Anvil starts`})`,
    { timeout: 120_000 },
    async () => {
      const before = await databaseTraces();
      const controller = new AbortController();
      const run = runLocalAlpha({
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(ALPHA_DEADLINE_MS),
        ]),
      });
      const settled = run.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        if (point !== undefined) {
          for (let n = 0; n < 1200 && anvils().length === 0; n++)
            await delay(25);
          assert.equal(anvils().length, 1, "Anvil started");
          await delay(point);
        }
        const abortedAt = Date.now();
        controller.abort(new Error("test abort"));
        const error = await settled;
        assert.match(String(error), /LIFECYCLE_ABORTED during .+: test abort/);
        assert.ok(Date.now() - abortedAt < 30_000, "teardown is bounded");
        assert.deepEqual(anvils(), []);
        assert.deepEqual(await leakedTraces(before), []);
      } finally {
        // A failed assertion above must not leave the run going.
        controller.abort(new Error("test ended"));
        await settled;
      }
    },
  );
}

// The test's own timeout leaves the harness deadline room to tear down and report the stage.
test(
  "real local services settle three REPLAY outcomes and survive both restore drills",
  { timeout: 240_000 },
  async (t) => {
    const signal = AbortSignal.any([
      t.signal,
      AbortSignal.timeout(ALPHA_DEADLINE_MS),
    ]);
    const report = await runLocalAlpha({ signal });
    console.log(`ALPHA wall time: ${report.wallTimeMs} ms`);
    assert.deepEqual(
      report.scenarios.map((s) => [
        s.scenario,
        s.outcome,
        s.takerPayoutMicros,
        s.makerPayoutMicros,
      ]),
      [
        ["normal", "YES", "10000000", "0"],
        ["dispute", "NO", "0", "10000000"],
        ["timeout", "INVALID", "5000000", "5000000"],
      ],
    );
    assert.equal(report.rebuildVerified, true);
    assert.equal(report.reindexIdentical, true);
    assert.equal(report.liveRows, 0);
    assert.ok(report.wallTimeMs < ALPHA_DEADLINE_MS);
  },
);
