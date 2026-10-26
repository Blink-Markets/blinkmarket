import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
function reads(source: string): Set<string> {
  const names = new Set<string>();
  const file = ts.createSourceFile(
    "env-scan.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const aliases = new Set<string>();
  const maps = new Map<string, Set<string>>();
  const helpers = new Set<string>();
  const isProcessEnv = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env";
  const envExpression = (node: ts.Node): boolean =>
    isProcessEnv(node) || (ts.isIdentifier(node) && aliases.has(node.text));
  const visitAliases = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name)
    ) {
      if (envExpression(node.initializer)) aliases.add(node.name.text);
      if (ts.isObjectLiteralExpression(node.initializer)) {
        const values = new Set<string>();
        for (const property of node.initializer.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.initializer) &&
            /^[A-Z][A-Z0-9_]*$/.test(property.initializer.text)
          )
            values.add(property.initializer.text);
        }
        if (values.size) maps.set(node.name.text, values);
      }
    }
    ts.forEachChild(node, visitAliases);
  };
  // Resolve chained env aliases before collecting reads.
  for (let i = 0; i < 4; i++) visitAliases(file);

  const findHelpers = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      const helper = node.initializer;
      const helperBody = helper.body;
      let dynamicEnvRead = false;
      const inspect = (child: ts.Node) => {
        if (
          ts.isElementAccessExpression(child) &&
          child.argumentExpression &&
          ts.isIdentifier(child.argumentExpression)
        ) {
          const expression = child.expression;
          if (
            envExpression(expression) ||
            (ts.isIdentifier(expression) &&
              helper.parameters.some(
                (p) =>
                  ts.isIdentifier(p.name) && p.name.text === expression.text,
              ))
          )
            dynamicEnvRead = true;
        }
        ts.forEachChild(child, inspect);
      };
      inspect(helperBody);
      if (dynamicEnvRead) helpers.add(node.name.text);
    }
    ts.forEachChild(node, findHelpers);
  };
  findHelpers(file);

  const addString = (node: ts.Expression) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^[A-Z][A-Z0-9_]*$/.test(node.text)
    )
      names.add(node.text);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      envExpression(node.initializer)
    ) {
      for (const element of node.name.elements) {
        if (ts.isIdentifier(element.name))
          names.add(
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text,
          );
      }
    }
    if (ts.isPropertyAccessExpression(node) && envExpression(node.expression))
      names.add(node.name.text);
    if (
      ts.isElementAccessExpression(node) &&
      envExpression(node.expression) &&
      node.argumentExpression
    ) {
      if (
        ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)
      )
        addString(node.argumentExpression);
      else if (
        ts.isElementAccessExpression(node.argumentExpression) &&
        ts.isIdentifier(node.argumentExpression.expression)
      ) {
        for (const value of maps.get(node.argumentExpression.expression.text) ??
          [])
          names.add(value);
      }
    }
    if (ts.isCallExpression(node)) {
      const envArgument = node.arguments.some(envExpression);
      const helperCall =
        ts.isIdentifier(node.expression) && helpers.has(node.expression.text);
      if (envArgument || helperCall)
        for (const argument of node.arguments) addString(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const rel = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(rel)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(rel);
  }
  return result;
}

function assertVariableCoverage(
  discovered: Set<string>,
  docs: string,
  example: string,
) {
  const listed = new Set(
    [...docs.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)].map((m) => m[0]),
  );
  const exampleNames = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
  );
  const absentFromRunbook = [...discovered]
    .filter((name) => !listed.has(name))
    .sort();
  assert.deepEqual(absentFromRunbook, []);
  const intentionallyUnset = new Set([
    "BLINK_ALLOW_TEST_CLOCK",
    "DEPLOYER_PRIVATE_KEY",
  ]);
  assert.deepEqual(
    [...discovered]
      .filter(
        (name) => !exampleNames.has(name) && !intentionallyUnset.has(name),
      )
      .sort(),
    [],
  );
}

function baseProfile(dir: string, overrides: Record<string, string> = {}) {
  return {
    BLINK_CHAIN_ID: "84532",
    BLINK_API_MODE: "markets",
    API_HOST: "0.0.0.0",
    API_PORT: "3001",
    API_TRUSTED_PROXIES: "127.0.0.1",
    API_DATABASE_URL: "postgresql://api:fake@db.internal/blink",
    WALLET_BINDING_ORIGIN: "https://api.example.test",
    SPEC_OBJECT_DIRECTORY: "/data/specs",
    SPEC_PUBLIC_ORIGIN: "https://api.example.test",
    EVIDENCE_OBJECT_DIRECTORY: "/data/evidence",
    BLINK_DEPLOYMENT_ID: "alpha-test",
    BASE_SEPOLIA_RPC_URL: "https://rpc.example.test/fake-token",
    WORKER_ENABLED: "true",
    WORKER_DATABASE_URL: "postgresql://worker:fake@db.internal/blink",
    CHAIN_INDEXER_ENABLED: "true",
    INDEXER_DATABASE_URL: "postgresql://indexer:fake@db.internal/blink",
    INDEXER_DEPLOYMENT_ID: "alpha-test",
    ALERT_SINK: "file",
    ALERT_FILE_PATH: path.join(dir, "alerts.jsonl"),
    ...overrides,
  };
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
  const services = await Promise.all(
    ["apps/api/src", "apps/worker/src", "apps/indexer/src"].map(sourceFiles),
  );
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const runbookCommands = [
    ...docs.matchAll(/\bpnpm\s+([a-z][a-z0-9:-]*)/g),
  ].map((m) => m[1]!);
  const toolFiles = new Set<string>(["scripts/deploy-preflight.ts"]);
  for (const command of runbookCommands) {
    const script = packageJson.scripts[command];
    if (!script) continue;
    for (const match of script.matchAll(/(?:^|\s)(scripts\/[^\s;&]+\.ts)\b/g))
      toolFiles.add(match[1]!);
  }
  const sources = await Promise.all(
    [...services.flat(), ...toolFiles].map((f) =>
      readFile(path.join(root, f), "utf8"),
    ),
  );
  const discovered = new Set(sources.flatMap((s) => [...reads(s)]));
  assertVariableCoverage(discovered, docs, example);
  assert.ok(discovered.has("BLINK_ALLOW_TEST_CLOCK"));
  assert.ok(discovered.has("DEPLOYER_PRIVATE_KEY"));
});

test("the variable derivation fails when a fixture reads an undocumented variable", async () => {
  const fixture =
    "const alias = process.env; const chainedAlias = alias; const { EXISTING_VAR } = chainedAlias; const { OTHER_VAR: renamed } = process.env; alias['BRACKET_VAR']; process.env['PROCESS_BRACKET_VAR']; const helper = (env, name) => env[name]; helper(alias, 'HELPER_VAR');";
  const discovered = reads(fixture);
  assert.ok(discovered.has("EXISTING_VAR"));
  assert.ok(discovered.has("OTHER_VAR"));
  assert.ok(discovered.has("BRACKET_VAR"));
  assert.ok(discovered.has("PROCESS_BRACKET_VAR"));
  assert.ok(discovered.has("HELPER_VAR"));
  assert.throws(
    () =>
      assertVariableCoverage(
        discovered,
        "EXISTING_VAR OTHER_VAR BRACKET_VAR PROCESS_BRACKET_VAR",
        "EXISTING_VAR=1\nOTHER_VAR=1\nBRACKET_VAR=1\nPROCESS_BRACKET_VAR=1",
      ),
    /HELPER_VAR/,
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
  const dir = await mkdtemp(path.join(tmpdir(), "blink-public-secret-"));
  for (const [name, secret] of [
    ["NEXT_PUBLIC_STATUS", "0x" + "a".repeat(64)],
    [
      "NEXT_PUBLIC_STATUS",
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
    ],
    ["NEXT_PUBLIC_STATUS", "https://user:pass@example.test"],
    ["NEXT_PUBLIC_STATUS", "api_key=supersecret123"],
    [
      "NEXT_PUBLIC_STATUS",
      `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(32)}.${"b".repeat(32)}`,
    ],
    ["NEXT_PUBLIC_STATUS", "opaque-" + "Ab9_-".repeat(8)],
    ["NEXT_PUBLIC_STATUS", "AKIA1234567890ABCDEF"],
    ["NEXT_PUBLIC_STATUS", "sk-ant-api03-abcdefghijklmnop"],
    ["NEXT_PUBLIC_STATUS", "ghp_abcdefghijklmnopqrstuvwx123456"],
    ["NEXT_PUBLIC_STATUS", "a".repeat(32)],
    ["NEXT_PUBLIC_STATUS", `https://rpc.example.test/v2/${"a".repeat(40)}`],
    ["NEXT_PUBLIC_STATUS", "https://rpc.example.test/?key=long-secret-value"],
    ["NEXT_PUBLIC_API_TOKEN", "opaque-value"],
  ] as const) {
    const f = await fixture(baseProfile(dir, { [name]: secret }));
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
  await rm(dir, { recursive: true, force: true });
});

test("complete fake Base Sepolia service profile passes offline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blink-valid-profile-"));
  const f = await fixture(
    baseProfile(dir, {
      NEXT_PUBLIC_API_URL: "https://api.example.test/v1",
      NEXT_PUBLIC_CHAIN_ID: "84532",
    }),
  );
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

function assertCode(output: string, expected: string) {
  assert.ok(
    output
      .split(/\r?\n/)
      .some(
        (line) =>
          line.trim() === expected || line.trim().startsWith(`${expected}:`),
      ),
    `expected exact preflight code ${expected}; received:\n${output}`,
  );
}

const hostCases = [
  ["10.0.0.1.evil.com", "PREFLIGHT_WEBHOOK_HTTPS"],
  ["localhost.evil.com", "PREFLIGHT_WEBHOOK_HTTPS"],
  ["2130706433", null],
  ["[::ffff:127.0.0.1]", "PREFLIGHT_WEBHOOK_HTTPS"],
  ["[fd00::1]", "PREFLIGHT_WEBHOOK_HTTPS"],
  ["[::1]", null],
  ["172.16.0.1", "PREFLIGHT_WEBHOOK_HTTPS"],
  ["172.32.0.1", "PREFLIGHT_WEBHOOK_HTTPS"],
  ["192.168.1.1", "PREFLIGHT_WEBHOOK_HTTPS"],
  ["169.254.169.254", "PREFLIGHT_WEBHOOK_HTTPS"],
] as const;

test("webhook URLs require HTTPS except for actual loopback hosts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blink-webhook-hosts-"));
  try {
    for (const [host, code] of hostCases) {
      const f = await fixture(
        baseProfile(dir, {
          ALERT_SINK: "webhook",
          ALERT_FILE_PATH: "",
          ALERT_WEBHOOK_URL: `http://${host}/hook`,
        }),
      );
      try {
        const out = run(f.envFile);
        if (code) {
          assert.notEqual(out.status, 0, host);
          assertCode(out.stdout + out.stderr, code);
        } else {
          assert.equal(out.status, 0, `${host}: ${out.stdout + out.stderr}`);
          assert.match(out.stdout, /DEPLOY PREFLIGHT ok/);
        }
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("test-clock override is forbidden in a Base Sepolia deployment env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blink-test-clock-"));
  const f = await fixture(baseProfile(dir, { BLINK_ALLOW_TEST_CLOCK: "true" }));
  try {
    const out = run(f.envFile);
    assert.notEqual(out.status, 0);
    assertCode(out.stdout + out.stderr, "PREFLIGHT_TEST_CLOCK_FORBIDDEN");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("deployer private key is rejected from a service env file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blink-deployer-key-"));
  const f = await fixture(
    baseProfile(dir, { DEPLOYER_PRIVATE_KEY: "fake-deployer-key-value" }),
  );
  try {
    const out = run(f.envFile);
    assert.notEqual(out.status, 0);
    assertCode(out.stdout + out.stderr, "PREFLIGHT_DEPLOYER_KEY_FORBIDDEN");
    assert.doesNotMatch(out.stdout + out.stderr, /fake-deployer-key-value/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("role keys are rejected from a service env file by name or by value, without echoing the value", async () => {
  const bare = "0x" + "cd".repeat(32);
  for (const [name, overrides] of [
    ["MAKER_PRIVATE_KEY", { MAKER_PRIVATE_KEY: bare }],
    ["KEEPER_KEY_FILE", { KEEPER_KEY_FILE: "/run/secrets/keeper" }],
    ["JUROR_MNEMONIC", { JUROR_MNEMONIC: "twelve words stand in here" }],
    ["SOME_ORDINARY_NAME", { SOME_ORDINARY_NAME: bare }],
  ] as const) {
    const dir = await mkdtemp(path.join(tmpdir(), "blink-role-key-"));
    const f = await fixture(baseProfile(dir, overrides));
    try {
      const out = run(f.envFile);
      const text = out.stdout + out.stderr;
      assert.notEqual(out.status, 0, name);
      assertCode(text, "PREFLIGHT_PLATFORM_ROLE_KEY_FORBIDDEN");
      assert.ok(text.includes(name), name + " is named");
      assert.doesNotMatch(text, /cdcdcdcd|run\/secrets|twelve words/);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
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

async function preflightWith(overrides: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "blink-preflight-case-"));
  const f = await fixture(baseProfile(dir, overrides));
  try {
    const out = run(f.envFile);
    return { status: out.status, output: out.stdout + out.stderr };
  } finally {
    await rm(f.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
}

test("API_TRUSTED_PROXIES is required and must name private or loopback proxies", async () => {
  for (const [value, code] of [
    [null, "PREFLIGHT_API_TRUSTED_PROXIES"],
    ["", "PREFLIGHT_API_TRUSTED_PROXIES"],
    ["203.0.113.9", "PREFLIGHT_API_TRUSTED_PROXIES"],
    ["127.0.0.1,203.0.113.9", "PREFLIGHT_API_TRUSTED_PROXIES"],
    ["127.0.0.1/1", "PREFLIGHT_API_TRUSTED_PROXIES"],
    ["10.0.0.0/7", "PREFLIGHT_API_TRUSTED_PROXIES"],
    ["192.168.0.0/15", "PREFLIGHT_API_TRUSTED_PROXIES"],
    ["::1/127", "PREFLIGHT_API_TRUSTED_PROXIES"],
    ["127.0.0.1,::1", null],
    ["10.0.0.0/8", null],
    ["172.16.0.0/12", null],
  ] as const) {
    const dir = await mkdtemp(path.join(tmpdir(), "blink-proxies-"));
    const profile = baseProfile(dir, { API_TRUSTED_PROXIES: value ?? "" });
    if (value === null)
      delete (profile as Record<string, string>).API_TRUSTED_PROXIES;
    const f = await fixture(profile);
    try {
      const out = run(f.envFile);
      const output = out.stdout + out.stderr;
      if (code) {
        assert.notEqual(out.status, 0, String(value));
        assertCode(output, code);
      } else assert.equal(out.status, 0, `${value}: ${output}`);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  }
});
