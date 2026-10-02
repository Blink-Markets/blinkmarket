import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("API bundle runs without workspace packages, tsx or node_modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-api-bundle-"));
  try {
    await copyFile(
      resolve("dist/services/api-server.mjs"),
      join(directory, "server.mjs"),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { buildApi } from './server.mjs';
      const app = buildApi();
      assert.equal((await app.inject('/health/live')).statusCode, 200);
      assert.equal((await app.inject('/health/ready')).statusCode, 503);
      assert.equal((await app.inject('/v1/config')).json().tradingEnabled, false);
      await app.close();
    `,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
      },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual API entry bundle fails closed without identity configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blink-api-entry-"));
  try {
    await copyFile(
      resolve("dist/services/api.mjs"),
      join(directory, "api.mjs"),
    );
    const result = spawnSync(process.execPath, ["api.mjs"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        BLINK_API_MODE: "identity",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /IDENTITY_CONFIGURATION_REQUIRED/);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find package/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
