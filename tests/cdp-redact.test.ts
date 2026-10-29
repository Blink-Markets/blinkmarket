import assert from "node:assert/strict";
import { inspect } from "node:util";
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
