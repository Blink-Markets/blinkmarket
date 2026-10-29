// Test fixture for tests/cdp-redact.test.ts: prints every CDP credential value the way a careless
// SDK might, then dies of an unhandled rejection that carries one. Never part of a test glob.
const values = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"].map((name) => process.env[name] ?? "");
for (const value of values) {
  process.stdout.write(`stdout: ${value}\n`);
  process.stderr.write(`stderr: ${value}\n`);
}
// One value split across two writes inside a single line (and, with luck, two chunks of the pipe).
const [id] = values;
process.stdout.write(`split: ${id.slice(0, 5)}`);
process.stdout.write(`${id.slice(5)} end\n`);
Promise.reject(new Error(`rejected with ${values[1]}`));
await new Promise((r) => setTimeout(r, 200));
