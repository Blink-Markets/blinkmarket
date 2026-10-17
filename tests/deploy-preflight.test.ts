import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const parserFiles = [
  "apps/api/src/config.ts",
  "apps/worker/src/config.ts",
  "apps/indexer/src/config.ts",
  "apps/signer/src/config.ts",
];
const commandFiles = [
  "scripts/migrate.ts",
  "scripts/register-deployment.ts",
  "scripts/verify-deployment.ts",
  "scripts/deploy-contracts.ts",
  "scripts/restore-prepare.ts",
  "scripts/ops-status.ts",
];

function reads(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /\b(?:env|process\.env)\.([A-Z][A-Z0-9_]*)\b/g,
  ))
    names.add(match[1]!);
  for (const match of source.matchAll(
    /\b(?:env|process\.env)\s*\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g,
  ))
    names.add(match[1]!);
  for (const match of source.matchAll(
    /\b(?:value|integer)\(\s*(?:env\s*,\s*)?["'`]([A-Z][A-Z0-9_]*)["'`]/g,
  ))
    names.add(match[1]!);
  // Capture finite dynamic env lookups such as keyFileVariables[role] and forecasterKeys.
  for (const object of source.matchAll(
    /const\s+\w+(?:Keys|Variables)\s*=\s*\{([\s\S]*?)\}\s*as const/g,
  ))
    for (const match of object[1]!.matchAll(/:\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g))
      names.add(match[1]!);
  return names;
}

async function fixture(values: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "blink-preflight-"));
  const envFile = path.join(dir, "env");
  await writeFile(
    envFile,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );
  return { dir, envFile };
}

function run(envFile: string) {
  return spawnSync("pnpm", ["deploy:preflight", envFile], {
    cwd: root,
    encoding: "utf8",
  });
}

test("every mechanically discovered config and runbook command variable is listed", async () => {
  const docs = await readFile(
    path.join(root, "docs/DEPLOYMENT_RUNBOOK.md"),
    "utf8",
  );
  const example = await readFile(
    path.join(root, "deployments/base-sepolia/env.example"),
    "utf8",
  );
  const listed = new Set(
    [...docs.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)].map((m) => m[0]),
  );
  const exampleNames = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
  );
  const sources = await Promise.all(
    [...parserFiles, ...commandFiles].map((f) =>
      readFile(path.join(root, f), "utf8"),
    ),
  );
  const discovered = new Set(sources.flatMap((s) => [...reads(s)]));
  assert.deepEqual(
    [...discovered].filter((name) => !listed.has(name)).sort(),
    [],
  );
  assert.deepEqual(
    [...discovered].filter((name) => !exampleNames.has(name)).sort(),
    [],
  );
});

test("placeholder marker rejection does not echo its value", async () => {
  const f = await fixture({
    BLINK_CHAIN_ID: "84532",
    ALERT_SINK: "webhook",
    ALERT_WEBHOOK_URL: "<TO BE PROVIDED: private-secret-url>",
  });
  try {
    const out = run(f.envFile);
    assert.notEqual(out.status, 0);
    assert.match(out.stdout + out.stderr, /PREFLIGHT_PLACEHOLDER/);
    assert.doesNotMatch(out.stdout + out.stderr, /private-secret-url/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("chain mismatch has a distinct refusal code, including mainnet", async () => {
  for (const [chain, code] of [
    ["8453", "MAINNET_REFUSED"],
    ["1", "PREFLIGHT_CHAIN_ID"],
  ] as const) {
    const f = await fixture({
      BLINK_CHAIN_ID: chain,
      ALERT_SINK: "file",
      ALERT_FILE_PATH: "/tmp/alerts.jsonl",
    });
    try {
      const out = run(f.envFile);
      assert.notEqual(out.status, 0);
      assert.match(out.stdout + out.stderr, new RegExp(code));
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test("secret-shaped NEXT_PUBLIC values are rejected without printing values", async () => {
  for (const [name, secret] of [
    ["NEXT_PUBLIC_STATUS", "0x" + "a".repeat(64)],
    [
      "NEXT_PUBLIC_STATUS",
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
    ],
    ["NEXT_PUBLIC_STATUS", "https://user:pass@example.test"],
    ["NEXT_PUBLIC_STATUS", "api_key=supersecret123"],
    ["NEXT_PUBLIC_API_TOKEN", "opaque-value"],
  ] as const) {
    const f = await fixture({
      BLINK_CHAIN_ID: "84532",
      ALERT_SINK: "file",
      ALERT_FILE_PATH: "/tmp/a",
      [name!]: secret!,
    });
    try {
      const out = run(f.envFile);
      assert.notEqual(out.status, 0);
      assert.match(out.stdout + out.stderr, /PREFLIGHT_PUBLIC_SECRET/);
      assert.doesNotMatch(
        out.stdout + out.stderr,
        new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test("complete fake Base Sepolia service profile passes offline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blink-valid-profile-"));
  const key = path.join(dir, "maker.key");
  await writeFile(key, "fake-key-material");
  await chmod(key, 0o600);
  const f = await fixture({
    BLINK_CHAIN_ID: "84532",
    BLINK_API_MODE: "trading",
    API_HOST: "0.0.0.0",
    API_PORT: "3001",
    API_DATABASE_URL: "postgresql://api:fake@db.internal/blink",
    WALLET_BINDING_ORIGIN: "https://api.example.test",
    SPEC_OBJECT_DIRECTORY: "/data/specs",
    SPEC_PUBLIC_ORIGIN: "https://api.example.test/specs",
    EVIDENCE_OBJECT_DIRECTORY: "/data/evidence",
    BLINK_DEPLOYMENT_ID: "alpha-test",
    SIGNER_URL: "http://10.0.0.4:3004",
    SIGNER_CALLER_TOKEN: "fake-api-caller-token",
    BASE_SEPOLIA_RPC_URL: "https://rpc.example.test/fake-token",
    WORKER_ENABLED: "true",
    WORKER_DATABASE_URL: "postgresql://worker:fake@db.internal/blink",
    WORKER_SIGNER_CALLER_TOKEN: "fake-worker-caller-token",
    CHAIN_INDEXER_ENABLED: "true",
    INDEXER_DATABASE_URL: "postgresql://indexer:fake@db.internal/blink",
    INDEXER_DEPLOYMENT_ID: "alpha-test",
    SIGNER_ENABLED: "true",
    SIGNER_DATABASE_URL: "postgresql://signer:fake@db.internal/blink",
    SIGNER_DEPLOYMENT_ID: "alpha-test",
    SIGNER_CALLERS: JSON.stringify([
      { name: "api", tokenSha256: "a".repeat(64), roles: ["maker"] },
    ]),
    SIGNER_MAKER_KEY_FILE: key,
    ALERT_SINK: "file",
    ALERT_FILE_PATH: path.join(dir, "alerts.jsonl"),
  });
  try {
    const out = run(f.envFile);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    console.log(out.stdout.trim());
    assert.match(out.stdout, /DEPLOY PREFLIGHT ok/);
    assert.doesNotMatch(
      out.stdout + out.stderr,
      /fake-api-caller-token|fake-worker-caller-token|fake-token/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("key files must exist and have exactly mode 0600", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blink-key-"));
  const key = path.join(dir, "signer.key");
  await writeFile(key, "fake-not-a-key");
  await chmod(key, 0o640);
  for (const [value, code] of [
    [path.join(dir, "missing.key"), "PREFLIGHT_KEY_FILE_MISSING"],
    [key, "PREFLIGHT_KEY_FILE_MODE"],
  ] as const) {
    const f = await fixture({
      BLINK_CHAIN_ID: "84532",
      ALERT_SINK: "file",
      ALERT_FILE_PATH: "/tmp/a",
      SIGNER_MAKER_KEY_FILE: value,
    });
    try {
      const out = run(f.envFile);
      assert.notEqual(out.status, 0);
      assert.match(out.stdout + out.stderr, new RegExp(code));
      assert.doesNotMatch(
        out.stdout + out.stderr,
        new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
  await rm(dir, { recursive: true, force: true });
});

test("signer URL must be loopback or private", async () => {
  const f = await fixture({
    BLINK_CHAIN_ID: "84532",
    ALERT_SINK: "file",
    ALERT_FILE_PATH: "/tmp/a",
    SIGNER_URL: "https://signer.example.test",
  });
  try {
    const out = run(f.envFile);
    assert.notEqual(out.status, 0);
    assert.match(out.stdout + out.stderr, /PREFLIGHT_SIGNER_URL/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("production profile requires an explicit non-stdout alert sink", async () => {
  for (const values of [{}, { ALERT_SINK: "stdout" }]) {
    const f = await fixture({ BLINK_CHAIN_ID: "84532", ...values });
    try {
      const out = run(f.envFile);
      assert.notEqual(out.status, 0);
      assert.match(out.stdout + out.stderr, /PREFLIGHT_ALERT_SINK/);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test("non-loopback webhook requires HTTPS", async () => {
  const f = await fixture({
    BLINK_CHAIN_ID: "84532",
    ALERT_SINK: "webhook",
    ALERT_WEBHOOK_URL: "http://alerts.example.test/hook",
  });
  try {
    const out = run(f.envFile);
    assert.notEqual(out.status, 0);
    assert.match(out.stdout + out.stderr, /PREFLIGHT_WEBHOOK_HTTPS/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
