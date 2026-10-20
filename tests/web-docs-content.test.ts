import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadDocs } from "../apps/web/lib/docs/registry.ts";
import { SKETCHES } from "../apps/web/lib/docs/sketches.ts";
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
    for (const m of p.body.matchAll(/(?<!!\[[^\]]*)\]\((\/docs(?!-assets\/)[^)#\s]*)(#[^)\s]*)?\)/g)) {
      const target = (m[1] ?? "").replace(/\.md$/, "").replace(/^\/docs\.?$/, "/docs");
      assert.ok(known.has(target), `${p.file}: broken link ${m[1]}`);
    }
  }
});

test("every /docs-assets reference exists", () => {
  for (const p of pages) {
    for (const m of p.body.matchAll(/\((\/docs-assets\/([^)#\s]+))\)/g)) {
      const file = m[2] ?? "";
      const sketch = (SKETCHES as readonly string[]).includes(file.replace(/\.svg$/, "")) && file.endsWith(".svg");
      assert.ok(sketch || existsSync(join(process.cwd(), "apps/web/public/docs-assets", file)), `${p.file}: missing asset ${m[1]}`);
    }
  }
});

test("no placeholders and no invented hosts", () => {
  for (const p of pages) {
    assert.ok(!/\b(TODO|TBD|lorem)\b/i.test(p.source), `${p.file}: placeholder`);
    for (const m of p.source.matchAll(/https?:\/\/([^/\s)`]+)/g))
      assert.ok(["blink-markets.github.io", "github.com", ...(p.slug === "deployment" ? ["sepolia.basescan.org", "repo.sourcify.dev"] : [])].includes(m[1] ?? ""), `${p.file}: host ${m[1]}`);
  }
});

test("docs never ask the reader to run Blink", () => {
  for (const p of pages) {
    assert.ok(!/\bpnpm\b|\bcurl\b|\bgit clone\b|127\.0\.0\.1:\d|BLINK_API_MODE/.test(p.source), `${p.file}: run-it-yourself instruction`);
  }
});

test("all canonical pages exist", () => {
  const have = new Set(pages.map((p) => p.slug));
  for (const s of DOC_SLUGS) assert.ok(have.has(s), `missing page for slug "${s}"`);
});

test("agent guide has the five briefing sections", () => {
  const agents = pages.find((p) => p.slug === "agents");
  assert.ok(agents, "agents.md is missing");
  for (const h of ["1. Purpose and hard rules", "2. Core model", "3. Roles", "4. Reading these docs", "5. Rules and invariants"])
    assert.ok(agents.body.includes(`## ${h}`), `agents.md missing "## ${h}"`);
});
