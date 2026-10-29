import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { redacted } from "./cdp/redact.ts";

// A string that appears nowhere in the helper; if it shows up in an output, the helper leaked it.
const SENTINEL = "SENTINEL-4f1c9a-do-not-leak";

class SdkError extends Error {
  statusCode = 401;
  response = { data: { errorMessage: SENTINEL } };
  constructor() {
    super(`Invalid API key: ${SENTINEL}`, { cause: new Error(SENTINEL) });
    this.stack = `SdkError: ${SENTINEL}\n    at ${SENTINEL}`;
  }
}
const named = (name: string) => {
  const value = new (class {})();
  Object.defineProperty(value.constructor, "name", { value: name });
  return value;
};

const cases: [string, unknown, string][] = [
  ["an Error subclass", new SdkError(), "CDP_CHECK_FAILED stage=quote error=SdkError status=401"],
  ["a plain object", { status: 500, detail: SENTINEL }, "CDP_CHECK_FAILED stage=quote error=Object status=500"],
  ["a string", SENTINEL, "CDP_CHECK_FAILED stage=quote error=String"],
  ["a constructor name that carries the sentinel", named(SENTINEL), "CDP_CHECK_FAILED stage=quote error=Error"],
  ["null", null, "CDP_CHECK_FAILED stage=quote error=Error"],
];

for (const [label, thrown, message] of cases)
  test(`redacted keeps only the stage, class name and status of ${label}`, async () => {
    const error = await redacted("quote", () => Promise.reject(thrown)).then(
      () => assert.fail("expected a rejection"),
      (e: unknown) => e as Error,
    );
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    for (const text of [String(error), error.stack ?? "", inspect(error, { depth: null, showHidden: true })])
      assert.ok(!text.includes(SENTINEL), text);
  });

test("redacted returns the value of a successful run unchanged", async () => {
  const value = { ok: true };
  assert.equal(await redacted("acquire", async () => value), value);
});

test("run.mjs masks the credential values in everything the child prints, and keeps its exit code", () => {
  const pem = [
    "-----BEGIN EC PRIVATE KEY-----",
    `${SENTINEL}-pem-line-one-0123456789`,
    `${SENTINEL}-pem-line-two-abcdefghij`,
    "-----END EC PRIVATE KEY-----",
  ].join("\n");
  const keyId = `${SENTINEL}-key-id`;
  const walletSecret = `${SENTINEL}-wallet-secret`;
  const { NODE_TEST_CONTEXT: _context, ...parentEnv } = process.env;
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./cdp/run.mjs", import.meta.url)), fileURLToPath(new URL("./cdp/fixtures/leak.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: { ...parentEnv, CDP_API_KEY_ID: keyId, CDP_API_KEY_SECRET: pem, CDP_WALLET_SECRET: walletSecret },
    },
  );
  const output = run.stdout + run.stderr;
  assert.ok(!output.includes(SENTINEL), output);
  // The fixture writes the key id in two pieces, and the test runner prints them on two lines.
  assert.ok(!output.includes(keyId.slice(5)), output);
  for (const line of pem.split("\n").filter((l) => l.trim().length >= 16)) assert.ok(!output.includes(line), line);
  assert.ok(output.includes("[REDACTED:CDP_API_KEY_ID]"), output);
  assert.ok(output.includes("[REDACTED:CDP_WALLET_SECRET]"), output);
  assert.notEqual(run.status, 0, output);
});
