import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../apps/web/lib/docs/frontmatter.ts";
import { loadDocs, navGroups, neighbors, expandSource } from "../apps/web/lib/docs/registry.ts";
import { renderDoc } from "../apps/web/lib/docs/render.ts";
import { llmsTxt } from "../apps/web/lib/docs/llms.ts";
import { apiIndexMarkdown } from "../apps/web/lib/docs/api-markdown.ts";
import { generateOpenApi } from "../packages/schemas/src/index.js";

const fm = (o: Record<string, string>) =>
  "---\n" + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n";
const base = { title: "T", description: "D", group: "Get started", order: "1", agentTask: "do x" };

test("parseFrontmatter reads fields and body", () => {
  const { meta, body } = parseFrontmatter(fm(base) + "\n# T\n\nHello");
  assert.deepEqual(meta, { title: "T", description: "D", group: "Get started", order: 1, agentTask: "do x" });
  assert.equal(body, "\n# T\n\nHello");
});

test("parseFrontmatter rejects missing fields, unknown groups and bad order", () => {
  assert.throws(() => parseFrontmatter("# no frontmatter"), /frontmatter: missing block/);
  const { agentTask: _drop, ...noTask } = base;
  assert.throws(() => parseFrontmatter(fm(noTask) + "x"), /frontmatter: missing agentTask/);
  assert.throws(() => parseFrontmatter(fm({ ...base, group: "Nope" }) + "x"), /frontmatter: unknown group/);
  assert.throws(() => parseFrontmatter(fm({ ...base, order: "x" }) + "x"), /frontmatter: order/);
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "docs-"));
  writeFileSync(join(dir, "index.md"), fm({ ...base, title: "Overview", order: "1" }) + "Home");
  writeFileSync(join(dir, "quickstart.md"), fm({ ...base, title: "Quickstart", order: "2" }) + "Qs");
  writeFileSync(join(dir, "errors.md"), fm({ ...base, title: "Errors", group: "Build an agent", order: "9" }) + "E");
  writeFileSync(join(dir, "api.md"), fm({ ...base, title: "API index", group: "Reference", order: "1" }) + "Intro\n\n<!-- generated:api-index -->\n");
  writeFileSync(join(dir, "agents.md"), fm({ ...base, title: "Agent guide", group: "For agents", order: "1" }) + "Steps");
  return dir;
}

test("loadDocs maps files to slugs, hrefs and md hrefs in IA order", () => {
  const pages = loadDocs(fixtureDir());
  assert.deepEqual(pages.map((p) => p.slug), ["", "quickstart", "errors", "api", "agents"]);
  assert.equal(pages[0]?.href, "/docs");
  assert.equal(pages[0]?.mdHref, "/docs.md");
  assert.equal(pages[1]?.href, "/docs/quickstart");
  assert.equal(pages[1]?.mdHref, "/docs/quickstart.md");
});

test("navGroups groups by DOC_GROUPS order and neighbors walk human pages only", () => {
  const pages = loadDocs(fixtureDir());
  assert.deepEqual(navGroups(pages).map((g) => g.group), ["Get started", "Build an agent", "Reference", "For agents"]);
  const n = neighbors(pages, "quickstart");
  assert.equal(n.prev?.slug, "");
  assert.equal(n.next?.slug, "errors");
  assert.equal(neighbors(pages, "api").next, null); // agents guide is not in the human pager
});

test("expandSource replaces only the API marker", () => {
  const pages = loadDocs(fixtureDir());
  const api = pages.find((p) => p.slug === "api")!;
  const out = expandSource(api);
  assert.ok(out.startsWith("---\n"));
  assert.ok(!out.includes("<!-- generated:api-index -->"));
  assert.match(out, /\| GET \| `\/v1\/markets` \|/);
  const qs = pages.find((p) => p.slug === "quickstart")!;
  assert.equal(expandSource(qs), qs.source);
});

test("renderDoc builds unique heading ids, toc, code, prompt, alerts and tables", () => {
  const md = [
    "# Title", "", "## Install", "", "### Step", "", "## Install", "",
    "```sh", "pnpm i <x>", "```", "", "```prompt", "Do it", "```", "",
    "> [!NOTE]", "> Hello `x`", "", "> [!PLANNED]", "> Later", "",
    "| a | b |", "| --- | --- |", "| 1 | 2 |",
  ].join("\n");
  const { html, toc } = renderDoc(md);
  assert.deepEqual(toc, [
    { id: "install", text: "Install", depth: 2 },
    { id: "step", text: "Step", depth: 3 },
    { id: "install-2", text: "Install", depth: 2 },
  ]);
  assert.ok(!html.includes("<h1"));
  assert.match(html, /<figure class="docs-code"><figcaption><span>sh<\/span><button type="button" class="docs-copy">Copy<\/button><\/figcaption><pre tabindex="0"><code>[\s\S]*pnpm[\s\S]*&lt;[\s\S]*x[\s\S]*&gt;[\s\S]*<\/code><\/pre><\/figure>/);
  assert.match(html, /<figure class="docs-prompt">[\s\S]*Copy prompt[\s\S]*<pre tabindex="0">Do it<\/pre><\/figure>/);
  assert.match(html, /<aside class="docs-callout docs-callout-note"><p class="docs-callout-label">Note<\/p>[\s\S]*<code>x<\/code>/);
  assert.match(html, /docs-callout-planned[\s\S]*Planned/);
  assert.ok(!html.includes("[!NOTE]") && !html.includes("[!PLANNED]"));
  assert.match(html, /<div class="docs-table" role="region" aria-label="Table" tabindex="0"><table>/);
});

test("llmsTxt lists every page's markdown URL with its description", () => {
  const pages = loadDocs(fixtureDir());
  const txt = llmsTxt(pages);
  assert.ok(txt.startsWith("# Blink\n\n> "));
  for (const p of pages) assert.ok(txt.includes(`](${p.mdHref}): ${p.meta.description}`), p.slug);
  assert.match(txt, /## For agents/);
});

test("apiIndexMarkdown renders one row per operation with status", () => {
  const doc = generateOpenApi();
  const md = apiIndexMarkdown(doc);
  const ops = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  assert.equal(md.split("\n").filter((l) => /^\| (GET|POST|PUT|PATCH|DELETE) \|/.test(l)).length, ops);
  assert.match(md, /\| Method \| Path \| Planned access \| Status \|/);
  assert.match(md, /^## markets$/m);
  assert.ok(!/^###/m.test(md));
  assert.match(md, /\| GET \| `\/v1\/config` \| .* \| always available \|/);
  assert.ok(!md.includes("unspecified"));
});

test("renderDoc toc text is decoded plain text and ids slugify it", () => {
  const { html, toc } = renderDoc("## Errors & idempotency\n\n## What's `new`");
  assert.deepEqual(toc, [
    { id: "errors-idempotency", text: "Errors & idempotency", depth: 2 },
    { id: "what-s-new", text: "What's new", depth: 2 },
  ]);
  assert.ok(html.includes('id="errors-idempotency"'));
});

const codeOf = (html: string) => /<code>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? "";
const textOf = (h: string) =>
  h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

test("renderDoc highlights known languages with css-variable token spans", () => {
  const sh = codeOf(renderDoc("```sh\npnpm install <x> # note\n```").html);
  assert.match(sh, /<span[^>]*style="[^"]*var\(--shiki-/);
  assert.match(sh, /<span[^>]*var\(--shiki-token-comment\)[^>]*>[^<]*# note/);
  assert.ok(sh.includes("&lt;") && sh.includes("&gt;") && !sh.includes("<x>"));
  assert.equal(textOf(sh), "pnpm install <x> # note");
  const json = renderDoc('```json\n{"a": 1}\n```').html;
  assert.match(codeOf(json), /<span/);
  assert.equal(textOf(codeOf(json)), '{"a": 1}');
  assert.ok(!/<pre[^>]*style=|background/.test(json));
});

test("renderDoc leaves text, prompt and unknown fences unhighlighted", () => {
  for (const lang of ["text", "prompt", "klingon"]) {
    const { html } = renderDoc("```" + lang + "\nhello <b>\n```");
    assert.ok(!html.includes("<span style"), lang);
    assert.ok(!html.includes("var(--shiki-"), lang);
  }
});
