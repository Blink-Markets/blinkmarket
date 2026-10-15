import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runLocalAlpha } from "../../scripts/local-alpha.ts";

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

test(
  "real local services settle three REPLAY outcomes and survive both restore drills",
  { timeout: 240_000 },
  async () => {
    const report = await runLocalAlpha();
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
    assert.ok(report.wallTimeMs < 240_000);
  },
);
