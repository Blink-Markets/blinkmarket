// Runs a test file the way the operator does and masks the CDP credential values in everything it
// prints. Usage: node tests/cdp/run.mjs <test-file>. The child inherits the environment; its stdout and
// stderr are read as they come and each known value is replaced by [REDACTED:<NAME>] before it is
// forwarded, even when the runner has broken it across lines. A multi-line value (a PEM key) is also
// masked line by line. Nothing about the values
// (the text, the length or the count) is ever printed.
import { spawn } from "node:child_process";

const NAMES = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"];
const MIN_LINE_LENGTH = 16;
// A value may reach the pipe in pieces, and a reporter that writes in between can break it across
// lines ("# " prefixed by the TAP reporter). A value is therefore matched with an optional line
// break and prefix between any two of its characters. The file runs in the runner's own process
// (isolation none), so nothing but the reporter's own lines can come between two pieces.
const BREAK = String.raw`(?:\r?\n[ #]*)?`;
// A value split into more pieces than this, each costing a break and a prefix, is not caught.
const HOLD_FACTOR = 4;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** One mask per value (and per long line of a multi-line value), longest first so a whole value goes before its lines. */
const masks = NAMES.flatMap((name) => {
  const value = process.env[name];
  if (!value) return [];
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= MIN_LINE_LENGTH);
  return [...new Set([value, ...(value.includes("\n") ? lines : [])])].map((text) => ({
    length: text.length,
    pattern: new RegExp([...text].map(escapeRegex).join(BREAK), "g"),
    marker: `[REDACTED:${name}]`,
  }));
}).sort((a, b) => b.length - a.length);

const mask = (text) => masks.reduce((out, { pattern, marker }) => out.replace(pattern, marker), text);
// Only this many trailing characters wait for more input, in case a value continues in the next chunk.
const hold = HOLD_FACTOR * Math.max(0, ...masks.map((m) => m.length));

/** Masks and forwards a stream; the last `hold` characters wait for more input until the stream ends. */
function forward(stream, out) {
  let held = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    held = mask(held + chunk);
    const cut = held.length - hold;
    if (cut > 0) {
      out.write(held.slice(0, cut));
      held = held.slice(cut);
    }
  });
  stream.on("end", () => {
    out.write(mask(held));
    held = "";
  });
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node tests/cdp/run.mjs <test-file>");
  process.exit(2);
}
const child = spawn(process.execPath, ["--import", "tsx", "--experimental-test-isolation=none", "--test", file], {
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("close", (code) => process.exit(code ?? 1));
