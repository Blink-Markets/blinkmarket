import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = "apps/web";
const pendingTask3 = ["content/sample-markets.ts", "app/markets/[id]/page.tsx"];
const banned = [
  "platform forecaster", "two platform forecasters", "A human approves", "administrator creates",
  "allowlisted proposer", "designated arbiter", "private signer", "internal trader", "operator mandate",
  "reserved for the Blink team", "P3 and P4 rewrite", "describes the v0.1 design", "Permissionless market creation",
  "Operator working notes", "Research cost", "suggest a question", "start trading",
];

function siteFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (path === "content/docs" || pendingTask3.includes(path)) return [];
    return entry.isDirectory() ? siteFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("no site page describes a removed v0.1 role as current", () => {
  const files = ["app", "components", "content"].map((dir) => {
    const found = siteFiles(dir);
    assert.ok(found.length > 0, `the scan must see files under ${dir}`);
    return found;
  }).flat();
  for (const file of files) {
    for (const phrase of banned) assert.ok(!read(file).toLowerCase().includes(phrase.toLowerCase()), `${file}: "${phrase}"`);
  }
});

test("the home page and the advantages page state both positioning lines", () => {
  for (const file of ["app/page.tsx", "app/advantages/page.tsx"]) {
    const source = read(file);
    for (const name of ["FOR_AGENTS", "FOR_PEOPLE"]) {
      assert.match(source, new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'][^"']*content/positioning["']`));
      assert.match(source, new RegExp(`\\{${name}\\}`));
    }
  }
  // The home page passes the lines to Hero, which must render both.
  assert.match(read("app/page.tsx"), /<Hero\s+people=\{FOR_PEOPLE\}\s+agents=\{FOR_AGENTS\}\s*\/>/);
  const hero = read("components/home/Hero.tsx");
  for (const prop of ["people", "agents"]) assert.match(hero, new RegExp(`<p[^>]*>\\{${prop}\\}</p>`), `Hero renders {${prop}}`);
});

test("how it works states the trust claim with its condition", () => {
  const source = read("app/how-it-works/page.tsx");
  assert.ok(source.includes("Under the publicly listed assumptions"));
  assert.ok(source.includes("/docs/trust"));
});
