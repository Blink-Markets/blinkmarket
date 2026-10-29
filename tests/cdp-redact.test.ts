import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// @ts-expect-error Plain JS module without a declaration file (it also runs under plain Node).
import { createMasker } from "./cdp/mask.mjs";
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

// Values built from Q, Z and digits only, characters that appear nowhere in a marker or in the text around them.
const KEY_ID = "QQ11ZZ22";
const WALLET = "QQ11ZZ22Q9Z8Q7Z6"; // starts with the key id
const PEM_LINES = ["Q1Z2Q3Z4Q5Z6Q7Z8Q9", "Z9Q8Z7Q6Z5Q4Z3Q2Z1"];
const PEM = ["-----BEGIN KEY-----", ...PEM_LINES, "-----END KEY-----"].join("\n");
const maskOf = (env: Record<string, string>) => createMasker(env);
/** No 2-character piece of a value may survive in the output. */
const assertNoFragment = (output: string, values: string[]) => {
  for (const value of values)
    for (let i = 0; i + 2 <= value.length; i++) assert.ok(!output.includes(value.slice(i, i + 2)), `${value.slice(i, i + 2)} in ${output}`);
};

test("createMasker covers a key id that is a prefix of the wallet secret", () => {
  const mask = maskOf({ CDP_API_KEY_ID: KEY_ID, CDP_WALLET_SECRET: WALLET });
  const out = mask(`a ${WALLET} b ${KEY_ID} c`);
  assert.equal(out, "a [REDACTED:CDP_WALLET_SECRET] b [REDACTED:CDP_API_KEY_ID] c");
  assertNoFragment(out, [KEY_ID, WALLET]);
});

test("createMasker merges values that overlap into one span", () => {
  const first = "Q1Z2Q3Z4Q5Z6Q7Z8";
  const second = "Q5Z6Q7Z8Q9Z9Q8Z8"; // starts with the last half of the first
  const mask = maskOf({ CDP_API_KEY_SECRET: first, CDP_WALLET_SECRET: second });
  const out = mask("x Q1Z2Q3Z4Q5Z6Q7Z8Q9Z9Q8Z8 y");
  assert.equal(out, "x [REDACTED:CDP_API_KEY_SECRET] y");
  assertNoFragment(out, [first, second]);
});

test("createMasker masks a value repeated on one line, and a CRLF line keeps its CR", () => {
  const mask = maskOf({ CDP_API_KEY_ID: KEY_ID });
  assert.equal(mask(`${KEY_ID}${KEY_ID} and ${KEY_ID}`), "[REDACTED:CDP_API_KEY_ID] and [REDACTED:CDP_API_KEY_ID]");
  assert.equal(mask(`id ${KEY_ID}\r`), "id [REDACTED:CDP_API_KEY_ID]\r");
});

test("createMasker masks each long line of a multi-line key on its own, and leaves other lines alone", () => {
  const mask = maskOf({ CDP_API_KEY_SECRET: PEM });
  for (const line of PEM_LINES) {
    const out = mask(`> ${line}`);
    assert.equal(out, "> [REDACTED:CDP_API_KEY_SECRET]");
    assertNoFragment(out, PEM_LINES);
  }
  // The header is 16 or more characters, so it counts as a line of the key too.
  assert.equal(mask("-----BEGIN KEY-----"), "[REDACTED:CDP_API_KEY_SECRET]");
  assert.equal(mask("nothing to hide here"), "nothing to hide here");
});

test("createMasker with no credential set returns every line unchanged", () => {
  assert.equal(maskOf({})("QQ11ZZ22"), "QQ11ZZ22");
});

test("run.mjs passes the exit code of the child through exactly", () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./cdp/run.mjs", import.meta.url)), fileURLToPath(new URL("./cdp/fixtures/exit.mjs", import.meta.url))], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")),
  });
  assert.match(run.stdout, /exiting/);
  assert.equal(run.status, 3);
});
