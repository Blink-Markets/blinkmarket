import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { assertNoRoleKeys } from "../packages/runtime/src/index.ts";
import { apiConfig } from "../apps/api/src/config.ts";
import { chainIndexerConfig, indexerConfig } from "../apps/indexer/src/config.ts";
import { workerConfig } from "../apps/worker/src/config.ts";

// P2 spec 2.1: the platform runs the API, the indexer and the worker, and holds no role key.
// Every platform process refuses to start when its environment carries one.
const FORBIDDEN = /PLATFORM_ROLE_KEY_FORBIDDEN/;
const KEY = "0x" + "ab".repeat(32);
const NAME_RULE = /PRIVATE_KEY|MNEMONIC|KEY_FILE|SEED/i;
const HEX_RULE = /^0x[0-9a-fA-F]{64}$/;

const validApi = {
  BLINK_API_MODE: "markets",
  API_DATABASE_URL: "postgresql://blink_api@127.0.0.1/blink",
  WALLET_BINDING_ORIGIN: "https://blink.example",
  SPEC_OBJECT_DIRECTORY: "/var/blink/specs",
  SPEC_PUBLIC_ORIGIN: "https://blink.example",
  BLINK_DEPLOYMENT_ID: "local-anvil",
};
const validIndexer = {
  CHAIN_INDEXER_ENABLED: "true",
  INDEXER_DATABASE_URL: "postgresql://blink_indexer@127.0.0.1/blink",
  INDEXER_DEPLOYMENT_ID: "local-anvil",
  BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
};
const validWorker = {
  WORKER_ENABLED: "true",
  WORKER_DATABASE_URL: "postgresql://blink_worker@127.0.0.1/blink",
};

const offenders: Record<string, string> = {
  MAKER_PRIVATE_KEY: KEY,
  KEEPER_KEY_FILE: "/run/secrets/keeper",
  JUROR_MNEMONIC: "test test test test test test test test test test test junk",
  // A bare 32-byte value is refused under any name.
  SOMETHING_HARMLESS: KEY,
};

test("api, worker and indexer configs reject role keys", () => {
  const configs: [string, Record<string, string>, (env: never) => unknown][] = [
    ["api", validApi, apiConfig],
    ["worker", validWorker, workerConfig],
    ["indexer", validIndexer, indexerConfig],
    ["chain indexer", validIndexer, chainIndexerConfig],
  ];
  for (const [name, valid, load] of configs) {
    assert.doesNotThrow(() => load(valid as never), name + " accepts a clean environment");
    for (const [variable, value] of Object.entries(offenders))
      assert.throws(
        () => load({ ...valid, [variable]: value } as never),
        FORBIDDEN,
        name + " must refuse " + variable,
      );
  }
});

test("assertNoRoleKeys checks names and 32-byte values, names the variable and never the value", () => {
  assert.doesNotThrow(() =>
    assertNoRoleKeys({
      PATH: "/usr/bin",
      API_DATABASE_URL: "postgresql://blink_api:" + "ab".repeat(32) + "@127.0.0.1/blink",
      BLINK_DEPLOYMENT_ID: "a".repeat(64),
      SHORT: "0x" + "ab".repeat(31),
      LONG: "0x" + "ab".repeat(33),
      NO_PREFIX: "ab".repeat(32),
      UNSET_PRIVATE_KEY: undefined,
    }),
  );
  for (const name of ["x_private_key", "DEPLOYER_PRIVATE_KEY", "MNEMONIC", "SIGNER_KEY_FILE", "RNG_SEED"])
    assert.throws(() => assertNoRoleKeys({ [name]: "" }), FORBIDDEN, name);
  for (const value of [KEY, "0x" + "AB".repeat(32), "0x" + "aB".repeat(32)])
    assert.throws(() => assertNoRoleKeys({ ANY: value }), FORBIDDEN);
  try {
    assertNoRoleKeys({ SOME_NAME: KEY });
    assert.fail("must throw");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "PLATFORM_ROLE_KEY_FORBIDDEN");
    assert.equal((error as Error & { variable?: string }).variable, "SOME_NAME");
    assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(KEY));
  }
});

type Service = {
  environment?: Record<string, unknown> | string[];
  env_file?: unknown;
  secrets?: unknown;
  volumes?: (string | Record<string, unknown>)[];
  [key: string]: unknown;
};

test("compose.alpha.yaml has no key env or key volumes", () => {
  const compose = parse(readFileSync("infra/compose.alpha.yaml", "utf8")) as {
    services: Record<string, Service>;
    volumes?: Record<string, unknown>;
    secrets?: unknown;
  };
  assert.deepEqual(Object.keys(compose.services).sort(), ["anvil", "api", "indexer", "postgres", "worker"]);
  assert.equal(compose.secrets, undefined, "no top-level secrets");
  for (const name of Object.keys(compose.volumes ?? {}))
    assert.ok(!/key|seed|mnemonic|secret/i.test(name), "volume " + name);
  for (const [name, service] of Object.entries(compose.services)) {
    const where = "service " + name;
    assert.equal(service.env_file, undefined, where + " reads no env file");
    assert.equal(service.secrets, undefined, where + " mounts no secret");
    const environment = Array.isArray(service.environment)
      ? Object.fromEntries(service.environment.map((entry) => entry.split(/=(.*)/s).slice(0, 2)))
      : (service.environment ?? {});
    for (const [variable, value] of Object.entries(environment)) {
      assert.ok(!NAME_RULE.test(variable), where + " sets " + variable);
      // A value can reference a key variable by name (${...}) as well as hold one.
      assert.ok(!HEX_RULE.test(String(value)), where + " sets a 32-byte value in " + variable);
      assert.ok(!NAME_RULE.test(String(value)), where + ": " + variable + " refers to a key variable");
    }
    for (const volume of service.volumes ?? []) {
      const text = typeof volume === "string" ? volume : JSON.stringify(volume);
      assert.ok(!NAME_RULE.test(text) && !/key|secret|keystore|\.pem/i.test(text), where + " mounts " + text);
      // Only named volumes: no host path can carry a key into a platform container.
      const source = typeof volume === "string" ? volume.split(":")[0]! : String(volume["source"]);
      assert.ok(!/^[./~]/.test(source), where + " bind-mounts " + source);
    }
  }
});

test("the service Dockerfiles bake in no key variable, argument or key file", () => {
  for (const service of ["api", "worker", "indexer"]) {
    const file = "infra/Dockerfile." + service;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      assert.ok(!NAME_RULE.test(line), file + ": " + line);
      assert.ok(!/0x[0-9a-fA-F]{64}/.test(line), file + " carries a 32-byte value");
      assert.ok(!/\.(key|pem)\b|keystore/i.test(line), file + " copies key material: " + line);
    }
  }
});

test(".env.example has no key entries except DEPLOYER_PRIVATE_KEY under the deploy-tool section", () => {
  for (const file of [".env.example", "deployments/base-sepolia/env.example"]) {
    let section = "";
    for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      // A heading is a comment line that ends with a colon-free title; entries may be commented out.
      const heading = /^#\s*(deploy[- ]tool)\b/i.exec(line);
      if (heading) section = "deploy-tool";
      else if (line.trim() === "") section = "";
      const entry = /^#?\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
      if (!entry) continue;
      const where = file + ":" + (index + 1) + " " + entry[1];
      assert.ok(!HEX_RULE.test(entry[2]!.trim()), where + " holds a 32-byte value");
      if (!NAME_RULE.test(entry[1]!)) continue;
      assert.equal(entry[1], "DEPLOYER_PRIVATE_KEY", where + " is a key entry");
      assert.equal(section, "deploy-tool", where + " is outside the deploy-tool section");
      assert.equal(entry[2]!.trim(), "", where + " must stay empty");
    }
  }
});

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".next", "out", "dist", "test-results"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

test("no platform source imports privateKeyToAccount or mnemonicToAccount", () => {
  // scripts/ and tests/ are exempt: the deploy tool and the harness actors use Anvil's public keys.
  const roots = [
    "apps",
    ...readdirSync("packages").map((name) => join("packages", name, "src")),
  ];
  const files = roots.flatMap((root) => {
    try {
      return sources(root);
    } catch {
      return [];
    }
  });
  assert.ok(files.length > 100, "the scan must see the platform sources");
  const banned = /\b(privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey)\b/;
  const hits = files
    .filter((file) => banned.test(readFileSync(file, "utf8")))
    .map((file) => relative(".", file));
  assert.deepEqual(hits, []);
});
