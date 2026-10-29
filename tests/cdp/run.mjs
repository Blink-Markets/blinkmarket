// Runs a test file the way the operator does and masks the CDP credential values in every line it
// prints. Usage: node tests/cdp/run.mjs <test-file>. The child inherits the environment; each line of
// its stdout and stderr goes through the masker (tests/cdp/mask.mjs) as soon as it is complete, and
// a partial last line waits for its newline or the end of the stream. Nothing about the values (the
// text, the length or the count) is ever printed.
import { spawn } from "node:child_process";
import { createMasker } from "./mask.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tests/cdp/run.mjs <test-file>");
  process.exit(2);
}
const mask = createMasker(process.env);

/** Masks and writes each complete line of a stream; resolves once the stream has ended and been written. */
function forward(stream, out) {
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    // A trailing \r stays on its line; the masker sees it and leaves it in place.
    for (const line of lines) out.write(mask(line) + "\n");
  });
  return new Promise((resolve) =>
    stream.on("end", () => {
      if (partial) out.write(mask(partial));
      out.write("", resolve);
    }),
  );
}

// ponytail: isolation none keeps the test in the runner's process, so the reporter cannot re-line what the file prints.
const child = spawn(process.execPath, ["--import", "tsx", "--experimental-test-isolation=none", "--test", file], {
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
const flushed = Promise.all([forward(child.stdout, process.stdout), forward(child.stderr, process.stderr)]);
const exited = new Promise((resolve) => {
  child.on("error", () => resolve(1));
  child.on("close", (code) => resolve(code ?? 1));
});
// Not process.exit: let the parent's own writes drain first.
process.exitCode = await exited;
await flushed;
