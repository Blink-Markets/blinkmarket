import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadDocs } from "../apps/web/lib/docs/registry.ts";
import { DOC_SLUGS } from "../apps/web/lib/docs/ia.ts";

const dir = join(process.cwd(), "apps/web/content/docs");
const pages = loadDocs(dir);

test("every content file parses and has a canonical slug", () => {
  assert.equal(pages.length, readdirSync(dir).filter((f) => f.endsWith(".md")).length);
  for (const p of pages) assert.ok((DOC_SLUGS as readonly string[]).includes(p.slug), `unknown slug ${p.slug}`);
});

test("every internal /docs link points at a canonical page", () => {
  const known = new Set<string>(DOC_SLUGS.map((s) => (s ? `/docs/${s}` : "/docs")));
  for (const p of pages) {
    for (const m of p.body.matchAll(/\]\((\/docs[^)#\s]*)(#[^)\s]*)?\)/g)) {
      const target = (m[1] ?? "").replace(/\.md$/, "").replace(/^\/docs\.?$/, "/docs");
      assert.ok(known.has(target), `${p.file}: broken link ${m[1]}`);
    }
  }
});

test("no placeholders and no invented hosts", () => {
  for (const p of pages) {
    assert.ok(!/\b(TODO|TBD|lorem)\b/i.test(p.source), `${p.file}: placeholder`);
    for (const m of p.source.matchAll(/https?:\/\/([^/\s)`]+)/g))
      assert.ok(["127.0.0.1:3000", "127.0.0.1:3001", "127.0.0.1:3002", "127.0.0.1:3003", "127.0.0.1:3004", "127.0.0.1:5432", "github.com"].includes(m[1] ?? ""), `${p.file}: host ${m[1]}`);
  }
});

test("all canonical pages exist", () => {
  const have = new Set(pages.map((p) => p.slug));
  for (const s of DOC_SLUGS) assert.ok(have.has(s), `missing page for slug "${s}"`);
});

test("agent guide has the eight required sections", () => {
  const agents = pages.find((p) => p.slug === "agents");
  assert.ok(agents, "agents.md is missing");
  for (const h of ["1. Purpose and hard constraints", "2. Install and run locally", "3. Verify", "4. Core model", "5. Workflows", "6. Rules and invariants", "7. Endpoint status", "8. Troubleshooting"])
    assert.ok(agents.body.includes(`## ${h}`), `agents.md missing "## ${h}"`);
});
