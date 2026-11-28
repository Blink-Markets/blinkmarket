import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { VAULT_PORT_KEYS, type VaultPort } from "../packages/mechanism-model/src/index.ts";

// Q13 plan, sections 9 and 11 (rulings 2 and 3): the model is pure, offline and imported by no app or service.

const PACKAGE = "packages/mechanism-model";
const SKIP = new Set(["node_modules", "dist", ".next", "out", "test-results"]);

function sourceFiles(directory: string, skip: (path: string) => boolean = () => false): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    if (skip(path)) return [];
    if (entry.isDirectory()) return sourceFiles(path, skip);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function parse(path: string, text = readFileSync(path, "utf8")): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

// Every module specifier of a source: static imports and exports, import() and require().
function specifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);
}

const FORBIDDEN_MODULE =
  /^(?:node:)?(?:viem|ethers|net|http|https|http2|dgram|tls|dns|child_process|worker_threads|cluster|module)(?:\/.*)?$|^(?:@ethersproject|@anthropic-ai|undici|ws|axios|node-fetch|got)(?:\/.*)?$/;
const FORBIDDEN_IDENTIFIERS = new Set([
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "EventSource",
  "WebTransport",
  "WebSocketStream",
  "sendBeacon",
]);
// Names that are refused only as a bare reference or call (`eval(x)`, `new Function(x)`), never as a property name
// (`engine.eval`), a declared member (`interface I { eval(): void }`) or a type (`let f: Function`).
const FORBIDDEN_BARE = new Set(["eval", "Function"]);
// Is this identifier a use of a variable or global, as opposed to a property name, a declared name or a type name?
function isBareReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if ("name" in parent && (parent as { name?: ts.Node }).name === id) return false; // a declaration or member name
  return true;
}

// `globalThis.<name>` or `self.<name>`: the global reached through the global object.
function isGlobalMember(node: ts.Node, member: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "globalThis" || node.expression.text === "self") &&
    node.name.text === member
  );
}

// Is this node the global named `name`: the bare identifier or globalThis.name?
function isGlobalNamed(node: ts.Node, name: string): boolean {
  return (ts.isIdentifier(node) && node.text === name && isBareReference(node)) || isGlobalMember(node, name);
}

// Network and dynamic-code references of a source: the network names anywhere (identifier or string literal, so
// `globalThis.fetch` and `globalThis["fetch"]` are caught), `eval` and `Function` as bare references, and
// `process.binding` however it is reached.
function forbiddenReferences(file: ts.SourceFile): string[] {
  const found = names(file).filter((n) => FORBIDDEN_IDENTIFIERS.has(n));
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && FORBIDDEN_BARE.has(node.text) && isBareReference(node)) found.push(node.text);
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "binding" && isGlobalNamed(node.expression, "process")) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "binding" &&
        isGlobalNamed(node.expression, "process"))
    )
      found.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// The entry file of each command of a q13:* package.json script is the first non-flag token after tsx or node
// (and after the value of `--import`). Only that entry must lie under scripts/q13/; arguments such as
// `--out tmp/q13/report.json` are not checked.
function q13ScriptProblems(command: string): string[] {
  const problems: string[] = [];
  for (const segment of command.split(/&&|;|\|\|/).map((part) => part.trim()).filter(Boolean)) {
    const tokens = segment.split(/\s+/).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    const [runner, ...rest] = tokens;
    if (runner !== "tsx" && runner !== "node") {
      problems.push(`${segment}: a q13:* script must run tsx or node, not ${runner ?? "nothing"}`);
      continue;
    }
    let entry: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i]!;
      if (token === "--import" || token === "-r" || token === "--require") i++;
      else if (!token.startsWith("-")) {
        entry = token;
        break;
      }
    }
    if (entry === undefined) problems.push(`${segment}: no entry file`);
    else if (!isHarnessPath(entry.replace(/^\.\//, ""))) problems.push(`${segment}: entry ${entry} is outside scripts/q13/`);
  }
  return problems;
}

const MANIFEST_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// Identifier and string-literal texts of a source, with `globalThis.fetch` reported as its member `fetch`.
function names(file: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// Every import() and require() call whose argument is not one string literal: its target cannot be scanned.
function dynamicLoads(file: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [target] = node.arguments;
      if (node.arguments.length !== 1 || !target || !ts.isStringLiteralLike(target)) found.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// Sources of nondeterminism and host access, banned inside the package only (a model run must be reproducible):
// Math.random and Date.now in every form (member, element access, destructuring, through globalThis), a Date with no
// argument, performance, crypto and process as globals, and the names random, getRandomValues, randomUUID,
// randomBytes and hrtime wherever they appear.
const NONDETERMINISTIC_NAMES = new Set(["random", "getRandomValues", "randomUUID", "randomBytes", "hrtime"]);
function nondeterminism(file: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      if (NONDETERMINISTIC_NAMES.has(node.text)) found.push(node.text);
      if (["process", "performance", "crypto"].includes(node.text) && isBareReference(node)) found.push(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      for (const root of ["process", "performance", "crypto"]) if (isGlobalMember(node, root)) found.push(node.getText(file));
      if (node.name.text === "now" && isGlobalNamed(node.expression, "Date")) found.push(node.getText(file));
      if (node.name.text === "random" && isGlobalNamed(node.expression, "Math")) found.push(node.getText(file));
    }
    // Math[...] and Date[...]: a computed member cannot be told from Math.random.
    if (ts.isElementAccessExpression(node) && (isGlobalNamed(node.expression, "Math") || isGlobalNamed(node.expression, "Date")))
      found.push(node.getText(file));
    // const { ...rest } = Math and const { ["random"]: r } = Math: a destructuring that names its members by rest or
    // by a computed key (a plain `{ random }` is caught by the name rule above; `{ floor }` is harmless).
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      (isGlobalNamed(node.initializer, "Math") || isGlobalNamed(node.initializer, "Date")) &&
      node.name.elements.some((element) => element.dotDotDotToken || (element.propertyName && !ts.isIdentifier(element.propertyName)))
    )
      found.push(node.getText(file));
    // const { now } = Date.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isGlobalNamed(node.initializer, "Date") &&
      node.name.elements.some((element) => (element.propertyName ?? element.name).getText(file) === "now")
    )
      found.push(node.getText(file));
    // new Date() and Date(): the current time.
    if (ts.isNewExpression(node) && isGlobalNamed(node.expression, "Date") && (node.arguments?.length ?? 0) === 0)
      found.push(node.getText(file));
    if (ts.isCallExpression(node) && isGlobalNamed(node.expression, "Date")) found.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// Does a manifest name the model anywhere in a dependency field (key or value: workspace:, link:, file: and npm: aliases)?
function dependsOnModel(manifest: Record<string, unknown>): string[] {
  return MANIFEST_FIELDS.flatMap((field) =>
    Object.entries((manifest[field] ?? {}) as Record<string, string>)
      .filter(([key, value]) => /mechanism-model/.test(key) || /mechanism-model/.test(String(value)))
      .map(([key, value]) => `${field}.${key}=${value}`),
  );
}

// What is wrong with the `VaultPort` interface of a source (I-25).
const FORBIDDEN_PORT_MEMBER = /^(deposit|mint|withdraw|redeem|max.*)$/;
function vaultPortProblems(file: ts.SourceFile): string[] {
  const problems: string[] = [];
  let seen = 0;
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "VaultPort") {
      seen++;
      if (node.heritageClauses?.length) problems.push("VaultPort extends or implements another type");
      for (const member of node.members) {
        if (!(ts.isPropertySignature(member) || ts.isMethodSignature(member)) || !ts.isIdentifier(member.name)) {
          problems.push(`member is not a named property or method: ${member.getText(file)}`);
          continue;
        }
        if (FORBIDDEN_PORT_MEMBER.test(member.name.text)) problems.push(`forbidden member ${member.name.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (seen !== 1) problems.push(`expected one VaultPort interface, found ${seen}`);
  return problems;
}

// Directory predicates, on posix paths. The prefix tests include the trailing slash so that a sibling such as
// scripts/q13/llmish or scripts/q13-extra is neither skipped nor mistaken for the llm folder.
const toPosix = (path: string) => path.split(sep).join("/");
const isLlmPath = (path: string) => path === "scripts/q13/llm" || path.startsWith("scripts/q13/llm/");
const isHarnessPath = (path: string) => path === "scripts/q13" || path.startsWith("scripts/q13/");

// While scripts/q13 does not exist (before the harness task), the harness scans see no file. They are not
// weakened by that: the "q13 scripts" test below turns the missing directory into a hard assertion as soon as
// the root package.json declares a q13:* script, and every scan then must see harness files.
const harnessFiles = () => sourceFiles("scripts/q13", (path) => isLlmPath(toPosix(path)));
const guardedFiles = () => [...sourceFiles(join(PACKAGE, "src")), ...harnessFiles()];

test("the isolation scanners recognise what they must refuse", () => {
  const bad = [
    'import { createPublicClient } from "viem";',
    'import { http } from "viem/chains";',
    'import { ethers } from "ethers";',
    'import net from "node:net";',
    'import https from "node:https";',
    'import http from "http";',
    'import dgram from "node:dgram";',
    'const lib = await import("viem");',
    'const lib = require("ethers");',
    'export * from "node:http";',
    'import http2 from "node:http2";',
    'import { spawn } from "node:child_process";',
    'import { Worker } from "worker_threads";',
    'import tls from "node:tls";',
    'import Anthropic from "@anthropic-ai/sdk";',
    'import { fetch } from "undici";',
    'import WebSocket from "ws";',
    'import axios from "axios";',
    'import { Wallet } from "@ethersproject/wallet";',
  ];
  for (const text of bad)
    assert.ok(specifiers(text).some((s) => FORBIDDEN_MODULE.test(s)), text);
  for (const ok of ['import { x } from "./arith.ts";', 'import { y } from "node:assert/strict";'])
    assert.equal(specifiers(ok).some((s) => FORBIDDEN_MODULE.test(s)), false, ok);
});

test("the isolation scanners refuse every network and dynamic-code reference", () => {
  for (const text of [
    "fetch('x');",
    "globalThis.fetch('x');",
    "new WebSocket('x');",
    "new XMLHttpRequest();",
    "globalThis['fetch']('x');",
    "eval('1');",
    "new Function('return 1');",
    "const f = eval;",
    "new EventSource('x');",
    "new WebTransport('x');",
    "navigator.sendBeacon('x');",
    "new WebSocketStream('x');",
    "process.binding('tcp_wrap');",
    "process['binding']('tcp_wrap');",
    "globalThis.process.binding('tcp_wrap');",
  ])
    assert.ok(forbiddenReferences(parse("x.ts", text)).length > 0, text);
});

test("the isolation scanners accept names that only look like the forbidden ones", () => {
  for (const text of [
    "const refetch = 1; const fetched = 2;",
    "const binding = 1; engine.binding(2);",
    "engine.eval(1); const o = { eval: 1, Function: 2 };",
    "let f: Function; type G = Function;",
    "interface I { eval(): void; Function(): void; binding: number }",
    "class C { eval() {} binding = 1 }",
    "const o = { binding() {} };",
  ])
    assert.deepEqual(forbiddenReferences(parse("x.ts", text)), [], text);
});

test("the isolation scanners refuse a dynamic load whose target is not a string literal", () => {
  // A dynamic load whose target is not one string literal cannot be scanned, so it is refused.
  for (const text of ["import(name);", "require(name);", "import(`a${b}`);", "require('a' + b);", "import();"])
    assert.equal(dynamicLoads(parse("x.ts", text)).length, 1, text);
  for (const text of ["import('./x.ts');", "require('./x.ts');", "const f = () => 1; f(require.resolve)"])
    assert.deepEqual(dynamicLoads(parse("x.ts", text)), [], text);
});

test("the isolation scanners refuse clocks, random sources and process access", () => {
  for (const text of [
    "Math.random();",
    "Date.now();",
    "process.env.X;",
    "const t = process;",
    "Math['random']();",
    "const k = 'random'; Math[k]();",
    "const { random } = Math;",
    "const { random: r } = Math;",
    "const { floor, ...rest } = Math;",
    "const { ['random']: r } = Math;",
    "const { now } = Date;",
    "new Date();",
    "Date();",
    "globalThis.Date.now();",
    "globalThis.Math.random();",
    "globalThis.process.env;",
    "performance.now();",
    "globalThis.performance.now();",
    "crypto.getRandomValues(a);",
    "globalThis.crypto.subtle;",
    "const r = x.getRandomValues(a);",
    "x.randomUUID();",
    "x.randomBytes(8);",
    "x.hrtime();",
    "const random = () => 4;",
  ])
    assert.ok(nondeterminism(parse("x.ts", text)).length > 0, text);
});

test("the determinism scan accepts names that only look like clocks or process access", () => {
  for (const text of [
    "const m = Math.max(1, 2); const d = new Date(5); const processed = 1;",
    "engine.process(a);",
    "const o = { process: 1, performance: 2, crypto: 3 };",
    "interface I { process(): void; performance: number; crypto(): void }",
    "class C { process() {} performance = 1 }",
    "const { floor } = Math; const e = new Date(2026, 0, 1);",
    "type T = { now: () => number }; const c = { now: 1 }; c.now;",
  ])
    assert.deepEqual(nondeterminism(parse("x.ts", text)), [], text);
});

test("the directory predicates keep prefix siblings in the scan and out of the llm exemption", () => {
  // The directory predicates: a sibling that only shares a prefix is neither the llm folder nor outside the harness.
  assert.equal(isLlmPath("scripts/q13/llm"), true);
  assert.equal(isLlmPath("scripts/q13/llm/run.ts"), true);
  for (const path of ["scripts/q13/llmish", "scripts/q13/llmish/run.ts", "scripts/q13/llm.ts", "scripts/q13/strategies/llm/x.ts"])
    assert.equal(isLlmPath(path), false, path);
  assert.equal(isHarnessPath("scripts/q13"), true);
  assert.equal(isHarnessPath("scripts/q13/a.ts"), true);
  for (const path of ["scripts/q13-extra", "scripts/q13-extra/a.ts", "scripts/q130/a.ts", "scripts/other/a.ts"])
    assert.equal(isHarnessPath(path), false, path);
});

test("the manifest scan catches every alias that names the model", () => {
  // Manifest aliases that name the model, whatever the protocol.
  for (const spec of ["workspace:../mechanism-model", "link:../mechanism-model", "file:../../packages/mechanism-model", "npm:@blink/mechanism-model@1"])
    assert.equal(dependsOnModel({ dependencies: { thing: spec } }).length, 1, spec);
  assert.equal(dependsOnModel({ devDependencies: { "@blink/mechanism-model": "workspace:*" } }).length, 1);
  assert.deepEqual(dependsOnModel({ dependencies: { thing: "workspace:*" }, scripts: { a: "mechanism-model" } }), []);
});

test("the vault port scan refuses heritage, unnamed members and vault-moving names", () => {
  // The vault port: no heritage, only named properties and methods, none of the vault-moving names.
  const goodPort = "export interface VaultPort { sharePrice(): bigint; transferShares(a: string): void }";
  assert.deepEqual(vaultPortProblems(parse("x.ts", goodPort)), []);
  for (const bad of [
    "export interface VaultPort extends Other { sharePrice(): bigint }",
    "export interface VaultPort { sharePrice(): bigint; deposit(a: bigint): void }",
    "export interface VaultPort { mint: () => void }",
    "export interface VaultPort { withdraw(a: bigint): void }",
    "export interface VaultPort { redeem(a: bigint): void }",
    "export interface VaultPort { maxWithdraw(a: string): bigint }",
    "export interface VaultPort { [key: string]: unknown }",
    "export interface VaultPort { (a: string): void }",
    "export interface VaultPort { ['deposit'](): void }",
    "export interface VaultPort { sharePrice(): bigint } export interface VaultPort { mint(): void }",
    "export type Other = {}",
  ])
    assert.ok(vaultPortProblems(parse("x.ts", bad)).length > 0, bad);
});

test("the package exists, declares no dependency and ships its TypeScript source", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
  assert.equal(manifest.name, "@blink/mechanism-model");
  assert.equal(manifest.private, true);
  assert.equal(manifest.exports, "./src/index.ts");
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
    assert.deepEqual(Object.keys(manifest[field] ?? {}), [], field);
  assert.ok(existsSync(join(PACKAGE, "src/index.ts")));
});

test("the package imports only its own relative files, and each names a real .ts file", () => {
  const files = sourceFiles(join(PACKAGE, "src"));
  assert.ok(files.length >= 3, "the scan must see the package sources");
  for (const path of files) {
    assert.deepEqual(dynamicLoads(parse(path)), [], `${path}: dynamic load with a non-literal target`);
    for (const specifier of specifiers(readFileSync(path, "utf8"))) {
      assert.ok(specifier.startsWith("./"), `${path}: only relative imports, not ${specifier}`);
      assert.ok(specifier.endsWith(".ts"), `${path}: ${specifier} must name the .ts file`);
      assert.ok(existsSync(join(path, "..", specifier)), `${path}: ${specifier} does not exist`);
    }
  }
});

test("no source file outside tests, the package and the harness imports the model", () => {
  // Every file git knows (tracked, or new and not ignored), so a file added in this very change is scanned too.
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .filter((path) => existsSync(path));
  assert.ok(listed.length > 500, "git ls-files must list the repository");
  const files = listed.filter(
    (path) =>
      /\.[cm]?[jt]sx?$/.test(path) &&
      !path.startsWith("tests/") &&
      path !== PACKAGE &&
      !path.startsWith(`${PACKAGE}/`) &&
      !isHarnessPath(path),
  );
  assert.ok(files.length > 100, "the scan must see the platform sources");
  const hits = files.flatMap((path) =>
    specifiers(readFileSync(path, "utf8"))
      .filter((s) => /mechanism-model/.test(s))
      .map((s) => `${path}: ${s}`),
  );
  assert.deepEqual(hits, []);
});

test("no workspace manifest other than the model's own depends on it", () => {
  const manifests = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return SKIP.has(entry.name) || entry.name.startsWith(".") ? [] : manifests(join(directory, entry.name));
      return entry.name === "package.json" ? [join(directory, entry.name)] : [];
    });
  const found = [...["apps", "packages", "examples", "video"].filter(existsSync).flatMap(manifests), "package.json"].filter(
    (path) => path !== join(PACKAGE, "package.json"),
  );
  assert.ok(found.length > 5, "the scan must see the workspace manifests");
  for (const path of found) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(dependsOnModel(manifest), [], path);
  }
});

test("the package and the harness (outside scripts/q13/llm) import no chain or network module", () => {
  const files = guardedFiles();
  assert.ok(files.length >= 3);
  const hits = files.flatMap((path) =>
    specifiers(readFileSync(path, "utf8"))
      .filter((s) => FORBIDDEN_MODULE.test(s))
      .map((s) => `${path}: ${s}`),
  );
  assert.deepEqual(hits, []);
});

test("the package and the harness (outside scripts/q13/llm) use no network identifier", () => {
  const hits = guardedFiles().flatMap((path) =>
    forbiddenReferences(parse(path)).map((n) => `${path}: ${n}`),
  );
  assert.deepEqual(hits, []);
});

test("the package and the harness (outside scripts/q13/llm) load only literal module names", () => {
  const hits = guardedFiles().flatMap((path) => dynamicLoads(parse(path)).map((call) => `${path}: ${call}`));
  assert.deepEqual(hits, []);
});

test("the package uses no clock, random source or process access", () => {
  const files = sourceFiles(join(PACKAGE, "src"));
  assert.ok(files.length >= 3);
  const hits = files.flatMap((path) => nondeterminism(parse(path)).map((use) => `${path}: ${use}`));
  assert.deepEqual(hits, []);
});

test("the q13:* script checker looks at the entry file only", () => {
  for (const ok of [
    "tsx scripts/q13/run.ts --out tmp/q13/report.json",
    "node --import tsx scripts/q13/run.ts",
    "node --import tsx scripts/q13/run.ts --seed 7 --out ./tmp/q13/x.json",
    "node --import tsx ./scripts/q13/run",
    "FOO=1 tsx scripts/q13/run.ts",
    "tsx scripts/q13/a.ts && tsx scripts/q13/b.ts --in tests/data/x.json",
  ])
    assert.deepEqual(q13ScriptProblems(ok), [], ok);
  for (const bad of [
    "tsx scripts/other/x.ts",
    "node --import tsx tests/x.ts",
    "tsx scripts/q13-extra/x.ts",
    "tsx scripts/q13/a.ts && tsx scripts/other/b.ts",
    "pnpm foo",
    "tsx",
    "tsx --watch",
  ])
    assert.ok(q13ScriptProblems(bad).length > 0, bad);
});

test("every q13:* script runs an entry file under scripts/q13/, and the harness is then present and scanned", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
  const q13 = Object.entries(manifest.scripts ?? {}).filter(([name]) => name.startsWith("q13:"));
  for (const [name, command] of q13) assert.deepEqual(q13ScriptProblems(command), [], name);
  if (q13.length > 0) {
    assert.ok(existsSync("scripts/q13"), "a q13:* script exists but scripts/q13 does not");
    assert.ok(harnessFiles().length > 0, "a q13:* script exists but the isolation scans see no harness file");
  }
});

test("no directory under scripts/ other than scripts/q13 carries the Q13 name", () => {
  const directories = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || SKIP.has(entry.name)) return [];
      const path = toPosix(join(directory, entry.name));
      return [path, ...(isHarnessPath(path) ? [] : directories(path))];
    });
  const stray = directories("scripts").filter((path) => !isHarnessPath(path) && /q13/i.test(path.split("/").slice(-1)[0] ?? ""));
  assert.deepEqual(stray, []);
});

test("the vault port exposes only the share price and share transfers (I-25)", () => {
  assert.deepEqual([...VAULT_PORT_KEYS].sort(), ["sharePrice", "transferShares"]);
  for (const forbidden of ["deposit", "mint", "withdraw", "redeem"])
    assert.equal((VAULT_PORT_KEYS as readonly string[]).includes(forbidden), false, forbidden);
  // The type has exactly the same keys as the runtime list, so neither can drift from the other.
  const port: VaultPort = { sharePrice: () => 1n, transferShares: () => undefined };
  assert.deepEqual(Object.keys(port).sort(), [...VAULT_PORT_KEYS].sort());
  assert.deepEqual(vaultPortProblems(parse(join(PACKAGE, "src/vault-port.ts"))), []);
  for (const key of VAULT_PORT_KEYS) assert.doesNotMatch(key, FORBIDDEN_PORT_MEMBER);
});

// What tests/architecture.test.ts and plan ruling 3 ban in every packages/*/src: keeper, trader, faucet and signer
// in file names and module specifiers only; BASELINE, FORECASTER_A and FORECASTER_B as exact identifiers or string literals.
test("the package avoids the names tests/architecture.test.ts bans", () => {
  const retiredIdentifier = /^(?:FORECASTER_A|FORECASTER_B|BASELINE)$/;
  const retiredModule = /(?:^|[/@-])(?:discovery|approval|creation-poller)(?:[-/.]|$)/;
  const deletedModule =
    /(?:^|[/@-])(?:signer(?:[-/.]|$)|signing(?:[-/.]|$)|tx-dispatcher(?:[/.]|$)|keeper(?:[-/.]|$)|faucet(?:[-/.]|$)|trader(?:[-/.]|$)|quote-reconcile(?:[/.]|$)|trading-store(?:[/.]|$))/;
  const bannedWord = /keeper|trader|faucet|signer/i;
  const files = sourceFiles(join(PACKAGE, "src"));
  assert.ok(files.length >= 3);
  for (const path of files) {
    assert.doesNotMatch(path.split(sep).slice(-1)[0] ?? "", bannedWord, `file name ${path}`);
    for (const name of names(parse(path))) assert.equal(retiredIdentifier.test(name), false, `${path}: ${name}`);
    for (const specifier of specifiers(readFileSync(path, "utf8"))) {
      assert.equal(retiredModule.test(specifier), false, `${path}: ${specifier}`);
      assert.equal(deletedModule.test(specifier), false, `${path}: ${specifier}`);
      assert.doesNotMatch(specifier, bannedWord, `${path}: ${specifier}`);
    }
  }
  assert.notEqual(JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")).name, "@blink/signer");
});

test("the package is on the boundary map with an empty dependency list", () => {
  const script = readFileSync("scripts/check-boundaries.mjs", "utf8");
  assert.match(script, /"mechanism-model":\s*\[\s*\]|\bmechanism-model:\s*\[\s*\]/);
});
