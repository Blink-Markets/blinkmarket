# Docs System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/web`'s `/docs` and `/docs/api` with a Claude-Code-style technical docs system: Markdown-sourced pages for humans (topic sidebar, on-page TOC, Copy page menu, copyable code and agent prompts, light/dark toggle) plus an agent track (`/docs/agents`, raw `.md` for every page, `/llms.txt`).

**Architecture:** Markdown files in `apps/web/content/docs/` are the single source. Pure modules in `apps/web/lib/docs/` parse frontmatter, load the registry, render HTML with marked, and generate llms.txt and the API index Markdown. One dynamic App Router page renders every human or agent page statically. A route handler, reached through a `beforeFiles` rewrite, serves raw Markdown. Three small client components handle copy actions, the active sidebar link and the theme toggle.

**Tech Stack:** Next 16.3.5 App Router, React 19.3, TypeScript 5.9, marked 18.0.13 (new dependency), Node test runner via tsx.

**Spec:** `docs/superpowers/specs/2026-10-09-docs-system-design.md`

**Visual reference:** the approved mockup at https://claude.ai/artifact/NUzH2v9QuJ2J7iKwEYuRhL. Its source is copied to `docs/superpowers/specs/assets/2026-10-09-docs-mockup.html` (Task 1 commits it). The theme toggle was added after the mockup, so the mockup does not show it.

## Global Constraints

- One new third-party dependency only: `marked` pinned to `18.0.13` in `apps/web/package.json`. No MDX, no syntax highlighter, no frontmatter library, no Tailwind.
- English copy. Every fact must be verifiable in the repo: `README.md`, `CONTEXT.md`, `Blink_MVP_v0.1_Base_Sepolia_Spec.md`, `docs/*.md`, `packages/schemas/src/http.ts`, `packages/application/src/{identity,preparation,approval}.ts`, `apps/api/src/{config,server}.ts`, `packages/client/src/index.ts`. Never invent domains, hosts, packages, SDKs or deployments. Use `<SITE_URL>` / `location.origin` and `http://127.0.0.1:3001` (local API) only.
- Endpoint status words, used exactly: `Identity mode` (wallet-challenges, wallet-verifications), `Preparation mode` (candidates, candidate by id, revisions, admin reject, evidence by id), `Approval mode` (admin approve, creation-intent by id, specs by hash, creation-intent chain-status), `Planned` (everything else). The API mode is set by `BLINK_API_MODE` (`scaffold` default, `identity`, `preparation`, `approval`).
- Hard constraints repeated wherever agents are addressed: Base Sepolia testnet (chain ID 84532); bUSD has no value; no public deployment or API host; do not create wallets or request keys, and do not sign or broadcast transactions unless the operator explicitly asks; an API key never authorises withdrawals for external users.
- Markdown conventions: alerts `> [!NOTE]` and `> [!PLANNED]`; agent prompts in ```` ```prompt ```` fences; internal links are absolute `/docs/...` paths (no host); the API index placeholder is the exact line `<!-- generated:api-index -->`.
- Files under `apps/web/lib/docs/` must type-check under the ROOT `tsconfig.json` (NodeNext, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) because tests import them. Relative imports between them use explicit `.ts` extensions (both tsconfigs set `allowImportingTsExtensions`, and Turbopack resolves them).
- Theme: dark tokens apply only under `html:has(.docs-root)`. Marketing pages stay light. The stored preference key is `blink-theme`, with values `light` or `dark`; when it is absent, follow the system setting.
- Docs pages do not use the blink-open reveal or large illustrations. Terracotta appears only for Planned and the current-page marker.
- No horizontal page overflow at 375px. Wide tables and code scroll inside their own containers.
- Before writing Next code, read the relevant guides in `apps/web/node_modules/next/dist/docs/01-app/`: `01-getting-started/03-layouts-and-pages.md`, `15-route-handlers.md`, `02-guides/preventing-flash-before-hydration.md`, `03-api-reference/05-config/01-next-config-js/rewrites.md`, and `generateStaticParams`.

## Parallel Execution Rules (for the controller)

- **Wave 1:** Task 1 alone (lib, dependency, seed content, tests). Controller reviews, commits, pushes.
- **Wave 2:** Tasks 2–6 run in parallel, each in its own git worktree, and commit on their own branches. File sets are disjoint. No `next build` or `next dev` inside worktrees. Controller reviews each task, then cherry-picks onto main.
- **Wave 3:** Task 7 runs integration, build, `next start` checks, screenshots, clipboard checks and delivery docs, then pushes.
- The shared working tree may contain someone else's uncommitted work (for example M2 creation-tracking files). Never edit, stage or revert files outside a task's list, and always stage by path. When root `pnpm check` is blocked by that work, verify in a clean worktree.

## Review Focus

1. **Raw Markdown fidelity:** `/docs/<slug>.md` must return the file's exact bytes, with only `<!-- generated:api-index -->` expanded, and the correct `content-type`. Pinned by a registry test and Task 7's `next start` curl check.
2. **Rewrite precedence:** `/docs/quickstart.md` must hit the Markdown handler, not the `[[...slug]]` page. Pinned by Task 7's curl check (body starts with `---`).
3. **Broken internal links:** every `/docs/...` link in content must resolve to a page. Pinned by the content-integrity test in Task 1.
4. **Theme flash and scope:** a stored `dark` choice applies before first paint on docs pages and never darkens marketing pages. Pinned by Task 7's screenshots of `/docs` and `/` with `blink-theme=dark` set.
5. **Copy actions:** Copy page returns the page's raw Markdown; Copy prompt contains `{origin}/docs/agents.md` and `{origin}/docs/<slug>.md`; code Copy returns only the code text. Pinned by Task 7's CDP clipboard capture.

## Open items (not done yet; carry forward)

From this plan's scope (spec §6.1): site search; syntax highlighting; Open in Claude/ChatGPT; localisation; live per-mode endpoint status; dark mode on marketing pages (needs token-coloured illustrations).

Carried from the 2026-10-08 showcase (spec §6.2): real Safari, Firefox and device testing (including the IntersectionObserver fallback and the `/how-it-works` spine under the fallback); the overflow check method (`overflow-x: clip` masks `scrollWidth`, so use element rects; Task 7 does); deduplicating `.code`, table header and `.title` styles; the unused `.visually-hidden` class (could label the ledger's Forecast column); the Architecture `aria-label` is too long (use a short label plus `<desc>`); Architecture bottom whitespace; whether to keep the Evaluation histogram; no skip link; README/ROADMAP table padding; user confirmation still pending on disclaimer colour (ink plus terracotta marker) and on per-model commit trailers; the rest of M4 (market detail, trading, positions, resolution, admin pages, live API data).

Resolved by this plan: the SiteHeader eye's hard-coded hex (Task 2 switches it to `currentColor`).

---

### Task 1: Docs core library, dependency, seed content, tests

**Files:**
- Modify: `apps/web/package.json` (add `"marked": "18.0.13"`), `pnpm-lock.yaml`
- Create: `apps/web/lib/docs/ia.ts`, `frontmatter.ts`, `registry.ts`, `render.ts`, `llms.ts`, `api-markdown.ts`
- Create: `apps/web/content/docs/index.md` (seed; Task 3 replaces)
- Create: `docs/superpowers/specs/assets/2026-10-09-docs-mockup.html` (copy of the approved mockup; the controller supplies the source path)
- Test: `tests/web-docs-lib.test.ts`, `tests/web-docs-content.test.ts`

**Interfaces (produced, used by every later task):**
```ts
// ia.ts — canonical information architecture
export const DOC_GROUPS = ["Get started", "Build an agent", "How Blink works", "Reference", "For agents"] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];
export const DOC_SLUGS = ["", "quickstart", "concepts", "authentication", "markets", "forecasts", "errors", "lifecycle", "architecture", "api", "status", "agents"] as const;
export type DocSlug = (typeof DOC_SLUGS)[number];
export const API_INDEX_MARKER = "<!-- generated:api-index -->";
// frontmatter.ts
export type DocMeta = { title: string; description: string; group: DocGroup; order: number; agentTask: string };
export function parseFrontmatter(source: string): { meta: DocMeta; body: string };
// registry.ts (node:fs)
export type DocPage = { slug: string; href: string; mdHref: string; file: string; meta: DocMeta; source: string; body: string };
export function loadDocs(dir?: string): DocPage[];            // default dir: join(process.cwd(), "content/docs")
export function navGroups(pages: readonly DocPage[]): { group: DocGroup; pages: DocPage[] }[];
export function neighbors(pages: readonly DocPage[], slug: string): { prev: DocPage | null; next: DocPage | null };
export function expandSource(page: DocPage): string;         // source with API_INDEX_MARKER replaced
// render.ts
export type TocItem = { id: string; text: string; depth: 2 | 3 };
export function renderDoc(body: string): { html: string; toc: TocItem[] };
// llms.ts
export function llmsTxt(pages: readonly DocPage[]): string;
// api-markdown.ts
export function apiIndexMarkdown(doc: unknown): string;
```

Rendered HTML contract (Task 2 styles it; `docs-copy` buttons are wired by Task 2's listener):
- Headings h2/h3: `<h2 id="{id}">{inline} <a class="docs-anchor" href="#{id}" aria-label="Link to this section">#</a></h2>`. h1 in the body is dropped, because the page header renders the title.
- Code: `<figure class="docs-code"><figcaption><span>{lang|text}</span><button type="button" class="docs-copy">Copy</button></figcaption><pre tabindex="0"><code>{escaped}</code></pre></figure>`.
- Prompt: `<figure class="docs-prompt"><figcaption><span>Prompt for your agent</span><button type="button" class="docs-copy">Copy prompt</button></figcaption><pre tabindex="0">{escaped}</pre></figure>`.
- Alerts: `<aside class="docs-callout docs-callout-note"><p class="docs-callout-label">Note</p>{inner}</aside>` (and `docs-callout-planned` / `Planned`).
- Tables: `<div class="docs-table" role="region" aria-label="Table" tabindex="0"><table>…</table></div>`.

- [ ] **Step 1: Read the Next guides listed in Global Constraints, then add the dependency**

Run: `pnpm --filter @blink/web add marked@18.0.13 --save-exact` (fall back to editing `package.json` and running `pnpm install`).
Then read `apps/web/node_modules/marked/lib/marked.d.ts` for the renderer signatures. The code below assumes the v13+ token-object renderer API (`heading({ tokens, depth })`, `code({ text, lang })`, `blockquote({ tokens })`, `table(token)`, with `this.parser`). Adapt it to the installed types if they differ, and note any change in the report.

- [ ] **Step 2: Write the failing tests** `tests/web-docs-lib.test.ts`

```ts
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
  assert.match(html, /<figure class="docs-code"><figcaption><span>sh<\/span><button type="button" class="docs-copy">Copy<\/button><\/figcaption><pre tabindex="0"><code>pnpm i &lt;x&gt;<\/code><\/pre><\/figure>/);
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
});
```

`tests/web-docs-content.test.ts` (runs against the real content directory):

```ts
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

test("all canonical pages exist (fails until Wave 2 content is merged)", () => {
  const have = new Set(pages.map((p) => p.slug));
  for (const s of DOC_SLUGS) assert.ok(have.has(s), `missing page for slug "${s}"`);
});

test("agent guide has the eight required sections", () => {
  const agents = pages.find((p) => p.slug === "agents");
  if (!agents) return; // covered by the previous test until merged
  for (const h of ["1. Purpose and hard constraints", "2. Install and run locally", "3. Verify", "4. Core model", "5. Workflows", "6. Rules and invariants", "7. Endpoint status", "8. Troubleshooting"])
    assert.ok(agents.body.includes(`## ${h}`), `agents.md missing "## ${h}"`);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --import tsx --test tests/web-docs-lib.test.ts tests/web-docs-content.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `ia.ts`, `frontmatter.ts`, `registry.ts`**

```ts
// ia.ts
export const DOC_GROUPS = ["Get started", "Build an agent", "How Blink works", "Reference", "For agents"] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];
export const DOC_SLUGS = ["", "quickstart", "concepts", "authentication", "markets", "forecasts", "errors", "lifecycle", "architecture", "api", "status", "agents"] as const;
export type DocSlug = (typeof DOC_SLUGS)[number];
export const API_INDEX_MARKER = "<!-- generated:api-index -->";
```

```ts
// frontmatter.ts — minimal "key: value" frontmatter; no library.
import { DOC_GROUPS, type DocGroup } from "./ia.ts";

export type DocMeta = { title: string; description: string; group: DocGroup; order: number; agentTask: string };
const FIELDS = ["title", "description", "group", "order", "agentTask"] as const;

export function parseFrontmatter(source: string): { meta: DocMeta; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error("frontmatter: missing block");
  const raw: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const f of FIELDS) if (!raw[f]) throw new Error(`frontmatter: missing ${f}`);
  const group = raw["group"] as DocGroup;
  if (!(DOC_GROUPS as readonly string[]).includes(group)) throw new Error(`frontmatter: unknown group ${raw["group"]}`);
  const order = Number(raw["order"]);
  if (!Number.isInteger(order)) throw new Error("frontmatter: order must be an integer");
  return {
    meta: { title: raw["title"]!, description: raw["description"]!, group, order, agentTask: raw["agentTask"]! },
    body: source.slice(match[0].length),
  };
}
```

```ts
// registry.ts — reads apps/web/content/docs at build time.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateOpenApi } from "@blink/schemas";
import { apiIndexMarkdown } from "./api-markdown.ts";
import { parseFrontmatter, type DocMeta } from "./frontmatter.ts";
import { API_INDEX_MARKER, DOC_GROUPS, type DocGroup } from "./ia.ts";

export type DocPage = { slug: string; href: string; mdHref: string; file: string; meta: DocMeta; source: string; body: string };

export function loadDocs(dir = join(process.cwd(), "content/docs")): DocPage[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const source = readFileSync(join(dir, file), "utf8");
      const { meta, body } = parseFrontmatter(source);
      const slug = file === "index.md" ? "" : file.slice(0, -3);
      return { slug, href: slug ? `/docs/${slug}` : "/docs", mdHref: slug ? `/docs/${slug}.md` : "/docs.md", file, meta, source, body };
    })
    .sort((a, b) => DOC_GROUPS.indexOf(a.meta.group) - DOC_GROUPS.indexOf(b.meta.group) || a.meta.order - b.meta.order);
}

export function navGroups(pages: readonly DocPage[]): { group: DocGroup; pages: DocPage[] }[] {
  return DOC_GROUPS.map((group) => ({ group, pages: pages.filter((p) => p.meta.group === group) })).filter((g) => g.pages.length > 0);
}

export function neighbors(pages: readonly DocPage[], slug: string): { prev: DocPage | null; next: DocPage | null } {
  const human = pages.filter((p) => p.meta.group !== "For agents");
  const i = human.findIndex((p) => p.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: human[i - 1] ?? null, next: human[i + 1] ?? null };
}

export function expandSource(page: DocPage): string {
  return page.source.includes(API_INDEX_MARKER)
    ? page.source.replace(API_INDEX_MARKER, apiIndexMarkdown(generateOpenApi()))
    : page.source;
}
```

Note: the `@blink/schemas` bare import resolves from `apps/web`, which depends on it. If root `tsc` (NodeNext) cannot resolve it from `apps/web/lib/docs`, import `../../../../packages/schemas/src/index.ts` instead and record the choice. `scripts/check-boundaries.mjs` only checks `packages/*`.

- [ ] **Step 5: Implement `api-markdown.ts`, `llms.ts`, `render.ts`**

```ts
// api-markdown.ts
import { groupOperations, indexOpenApi } from "../../content/openapi-index.ts";

export function apiIndexMarkdown(doc: unknown): string {
  const lines: string[] = [];
  for (const { group, operations } of groupOperations(indexOpenApi(doc))) {
    lines.push(`### ${group}`, "", "| Method | Path | Planned access | Status |", "| --- | --- | --- | --- |");
    for (const op of operations) lines.push(`| ${op.method} | \`${op.path}\` | ${op.access ?? "—"} | ${op.status} |`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
```

```ts
// llms.ts — https://llmstxt.org layout; links are host-relative because there is no public host yet.
import type { DocPage } from "./registry.ts";

export function llmsTxt(pages: readonly DocPage[]): string {
  const agents = pages.filter((p) => p.meta.group === "For agents");
  const human = pages.filter((p) => p.meta.group !== "For agents");
  const item = (p: DocPage) => `- [${p.meta.title}](${p.mdHref}): ${p.meta.description}`;
  return [
    "# Blink",
    "",
    "> Experimental prediction-research platform for agents on the Base Sepolia testnet. Test assets only; no public deployment yet.",
    "",
    "Start with the agent guide. Every page is also available as Markdown at the URLs below.",
    "",
    "## For agents",
    ...agents.map(item),
    "",
    "## Docs",
    ...human.map(item),
    "",
  ].join("\n");
}
```

```ts
// render.ts — marked with a Blink renderer; one Marked instance per call so ids/toc stay local.
import { Marked } from "marked";

export type TocItem = { id: string; text: string; depth: 2 | 3 };
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
const ALERT = /^\s*<p>\[!(NOTE|PLANNED)\]\s*/;

export function renderDoc(body: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        if (depth === 1) return "";
        const inner = this.parser.parseInline(tokens);
        const text = inner.replace(/<[^>]+>/g, "");
        const baseId = slugify(text);
        const n = (used.get(baseId) ?? 0) + 1;
        used.set(baseId, n);
        const id = n === 1 ? baseId : `${baseId}-${n}`;
        if (depth === 2 || depth === 3) toc.push({ id, text, depth });
        return `<h${depth} id="${id}">${inner} <a class="docs-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      code({ text, lang }) {
        if (lang === "prompt")
          return `<figure class="docs-prompt"><figcaption><span>Prompt for your agent</span><button type="button" class="docs-copy">Copy prompt</button></figcaption><pre tabindex="0">${escapeHtml(text)}</pre></figure>\n`;
        return `<figure class="docs-code"><figcaption><span>${escapeHtml(lang || "text")}</span><button type="button" class="docs-copy">Copy</button></figcaption><pre tabindex="0"><code>${escapeHtml(text)}</code></pre></figure>\n`;
      },
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens);
        const m = ALERT.exec(inner);
        if (!m) return `<blockquote>${inner}</blockquote>\n`;
        const kind = m[1] === "NOTE" ? "note" : "planned";
        const label = kind === "note" ? "Note" : "Planned";
        return `<aside class="docs-callout docs-callout-${kind}"><p class="docs-callout-label">${label}</p><p>${inner.replace(ALERT, "")}</aside>\n`;
      },
    },
    hooks: {
      // Wrap default table output in a focusable scroll region.
      postprocess(html) {
        return html
          .replaceAll("<table>", '<div class="docs-table" role="region" aria-label="Table" tabindex="0"><table>')
          .replaceAll("</table>", "</table></div>");
      },
    },
  });
  const html = marked.parse(body, { async: false }) as string;
  return { html, toc };
}
```

If the installed marked does not accept `hooks` in the `Marked` constructor options, register the same `postprocess` hook with `marked.use({ hooks: { postprocess } })` on the instance instead. Keep the escaping exact: the code test expects `&lt;x&gt;`.

- [ ] **Step 6: Seed content and the mockup asset**

`apps/web/content/docs/index.md` (seed, replaced by Task 3):

```md
---
title: Overview
description: What Blink is and where to start.
group: Get started
order: 1
agentTask: learn what Blink is before integrating
---

# Overview

Blink documentation is being written. Start with the [Agent guide](/docs/agents).
```

Copy the mockup: `cp <controller-supplied path>/blink-docs.html docs/superpowers/specs/assets/2026-10-09-docs-mockup.html`.

- [ ] **Step 7: Verify**

Run: `node --import tsx --test tests/web-docs-lib.test.ts tests/web-docs-content.test.ts`
Expected: every lib test passes. Content tests pass except `all canonical pages exist`, which is expected to fail until Wave 2 merges. The seed links to `/docs/agents`, which is canonical, so the link test passes.
Run: `pnpm --filter @blink/web typecheck` and `pnpm typecheck` (root; if unrelated uncommitted work blocks it, run in a clean worktree and say so).

- [ ] **Step 8: Commit** (stage by path)

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/docs apps/web/content/docs/index.md docs/superpowers/specs/assets/2026-10-09-docs-mockup.html tests/web-docs-lib.test.ts tests/web-docs-content.test.ts
git commit -m "feat(web): add docs core library (frontmatter, registry, marked renderer, llms.txt)"
```

---

### Task 2: Docs UI shell, routes, theme toggle

**Files:**
- Delete: `apps/web/app/docs/page.tsx`, `apps/web/app/docs/docs.module.css`, `apps/web/app/docs/api/page.tsx`
- Replace: `apps/web/app/docs/layout.tsx`
- Create: `apps/web/app/docs/[[...slug]]/page.tsx`, `apps/web/app/docs/docs.css`
- Create: `apps/web/app/docs-md/[slug]/route.ts`, `apps/web/app/llms.txt/route.ts`
- Create: `apps/web/components/docs/{AudienceBar,Sidebar,Toc,Pager,CopyPageMenu,DocsCopyListener,ThemeToggle}.tsx`, `apps/web/components/docs/copy-text.ts`
- Modify: `apps/web/next.config.ts` (rewrites), `apps/web/app/layout.tsx` (pre-paint theme script, `suppressHydrationWarning`), `apps/web/app/globals.css` (docs dark tokens + light docs tokens), `apps/web/components/SiteHeader.tsx` + `.module.css` (eye uses `currentColor`)

**Interfaces:** Consumes Task 1 (`loadDocs`, `navGroups`, `neighbors`, `expandSource`, `renderDoc`, `llmsTxt`, the rendered HTML contract). Produces routes `/docs`, `/docs/<slug>`, `/docs.md`, `/docs/<slug>.md`, `/llms.txt`.

- [ ] **Step 1: Read the Next guides listed in Global Constraints.** In particular, confirm the shape of the `params` Promise, `generateStaticParams`, `dynamicParams`, static route handlers (`dynamic = "force-static"`), and `beforeFiles` rewrites.

- [ ] **Step 2: Routes**

`app/docs/[[...slug]]/page.tsx`:
- `generateStaticParams()` returns `loadDocs().map((p) => ({ slug: p.slug ? [p.slug] : [] }))`.
- `export const dynamicParams = false`.
- `generateMetadata` uses `meta.title` and `meta.description`.
- The page finds the doc by `slug?.[0] ?? ""` and calls `notFound()` if it is missing.
- It renders `renderDoc(parseFrontmatter(expandSource(page)).body)`.
- Header: a group crumb, `<h1>`, a lede, and `<CopyPageMenu markdown={expandSource(page)} mdHref={page.mdHref} agentTask={page.meta.agentTask} />`.
- Then the article HTML via `dangerouslySetInnerHTML`, then `<Pager>` (human pages only).
- Right column: `<Toc items={toc.filter((t) => t.depth === 2)} />`.

`app/docs-md/[slug]/route.ts`:
- `dynamic = "force-static"`; `generateStaticParams` returns every page with `slug: p.slug || "index"`.
- `GET` returns `new Response(expandSource(page), { headers: { "content-type": "text/markdown; charset=utf-8" } })`, or 404.

`app/llms.txt/route.ts`: `force-static`; returns `llmsTxt(loadDocs())` with `text/plain; charset=utf-8`.

`next.config.ts`: keep the existing options and add

```ts
async rewrites() {
  return {
    beforeFiles: [
      { source: "/docs.md", destination: "/docs-md/index" },
      { source: "/docs/:slug([a-z0-9-]+)\\.md", destination: "/docs-md/:slug" },
    ],
    afterFiles: [],
    fallback: [],
  };
},
```

Verify the pattern syntax against the rewrites guide. Task 7 tests it under `next start`.

- [ ] **Step 3: Layout and components**

`app/docs/layout.tsx` (server):
- Imports `./docs.css` and computes `navGroups(loadDocs())`.
- Renders `<div className="docs-root">`, containing `<AudienceBar />`, then `<div className="docs-shell"><Sidebar groups={...} />{children}</div>`.
- The page renders `<article className="docs-article">…</article><Toc …/>` as the second and third grid columns.
- Mount `<DocsCopyListener />` once.

Components:
- `AudienceBar` (server): a segmented nav with "For humans" → `/docs` and "For agents" → `/docs/agents`. The active state comes from a small client child using `usePathname`, or both links render plainly and the Sidebar marks the page. Also renders a one-line description and `<ThemeToggle />` on the right.
- `Sidebar` (client, `usePathname`):
  - Group headings in mono.
  - Links get `aria-current="page"` when `pathname === href`.
  - Wrapped in `<details className="docs-nav" open>` whose `<summary>` shows `Menu · {current title}`. The summary is visible only under 768px; CSS forces the list open above 768px.
  - On mount under 768px, close the details.
- `Toc` (server): "On this page" list of h2 anchors.
- `Pager` (server): previous/next from `neighbors`.
- `CopyPageMenu` (client):
  - The main button copies `markdown`.
  - The ▾ button toggles a menu (Escape and outside-click close it) with three items: "Copy as Markdown"; "View as Markdown", a real `<a href={mdHref}>`; and "Copy prompt for agent".
  - The prompt is built at click time from `location.origin`: `Read {origin}/docs/agents.md first and follow its rules. Then use {origin}{mdHref} to {agentTask}. Blink runs on the Base Sepolia testnet with test assets only; do not create wallets, sign or broadcast transactions unless I explicitly ask.`
  - Feedback: the button label changes to "Copied" for 1.5s.
- `DocsCopyListener` (client): one document `click` listener for `.docs-copy`. It copies `closest("figure").querySelector("pre").textContent` and swaps the label to "Copied" for 1.5s. It removes the listener on unmount.
- `copy-text.ts`: `copyText(text): Promise<boolean>` uses `navigator.clipboard.writeText`. On failure it falls back to a hidden textarea plus `document.execCommand("copy")`.
- `ThemeToggle` (client):
  - A button with `aria-pressed` showing "Dark" or "Light" (the mode it switches to).
  - It reads the effective theme: `document.documentElement.dataset.theme`, otherwise `matchMedia("(prefers-color-scheme: dark)")`.
  - On click it sets `dataset.theme` and stores `blink-theme` in `localStorage`, inside try/catch.

`app/layout.tsx`:
- Add `suppressHydrationWarning` on `<html>`.
- First child of `<body>`, before any visible content: `<script dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('blink-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}" }} />`. Follow the preventing-flash guide if it prescribes another placement.

`globals.css`:
- Add light docs tokens to `:root`: `--paper-2: #f2f2ec; --cobalt-tint: #2148b80f; --ink-faint: #24232180;`.
- Add the dark blocks:

```css
@media (prefers-color-scheme: dark) {
  html:has(.docs-root):not([data-theme="light"]) { --paper: #141518; --paper-2: #1c1e22; --ink: #ecebe5; --ink-soft: #ecebe5b3; --ink-faint: #ecebe580; --rule: #ecebe529; --cobalt: #8ea6f2; --cobalt-tint: #8ea6f21a; --terracotta: #e08a66; color-scheme: dark; }
}
html:has(.docs-root)[data-theme="dark"] { --paper: #141518; --paper-2: #1c1e22; --ink: #ecebe5; --ink-soft: #ecebe5b3; --ink-faint: #ecebe580; --rule: #ecebe529; --cobalt: #8ea6f2; --cobalt-tint: #8ea6f21a; --terracotta: #e08a66; color-scheme: dark; }
```

`SiteHeader`: the eye SVG uses `stroke="currentColor"` and `fill="currentColor"` for the outline and iris. The wrapper sets `color: var(--cobalt)`. The pupil highlight uses `fill="var(--terracotta)"` through a `style` prop, or a CSS class. This resolves the carried open item.

`docs.css`: port the mockup's styles (`docs/superpowers/specs/assets/2026-10-09-docs-mockup.html`, or the artifact) to `docs-` prefixed classes using only tokens:
- shell grid: 248px / minmax(0,1fr) / 208px at ≥1100px; hide the TOC at 768–1099px; single column under 768px;
- sticky sidebar and TOC;
- article max-width 74ch;
- heading anchors;
- copy menu, code and prompt figures, callouts (planned uses a terracotta border and hatch);
- tables (scroll inside `.docs-table`);
- pager; audience bar; theme toggle.

Never use literal colours except inside the token blocks.

- [ ] **Step 4: Verify** with `pnpm --filter @blink/web typecheck`, `node --import tsx --test tests/web-docs-lib.test.ts` and `node scripts/check-boundaries.mjs`. Do not run `next build` (controller does).

- [ ] **Step 5: Commit** by path: `feat(web): docs shell with copy actions, markdown routes, llms.txt and theme toggle`.

---

### Tasks 3–6: Content (parallel; Markdown only)

Shared rules for every content task:
- Write only the files listed. Every file starts with the frontmatter block: `title`, `description` (one sentence), `group` (exact DOC_GROUPS value), `order` (integer within group), `agentTask` (the phrase that completes "use this page to …").
- Body: `# {title}`, then one short intro paragraph. Then `##` sections, each answering one question. Human pages are layered: a short explanation first, then detail and commands.
- Every how-to page ends with a `## Hand it to your agent` section containing one ```` ```prompt ```` block, then `## Next steps` with 2–3 internal links.
- Facts: only from the sources in Global Constraints. Cite nothing external. Mark unimplemented operations with `> [!PLANNED]` and the exact status words.
- Links: absolute `/docs/<slug>` (canonical slugs only). Hosts: only `127.0.0.1` ports listed in the content test, and `github.com/Blink-Markets/blinkmarket`.
- Verify with `node --import tsx --test tests/web-docs-content.test.ts`. Every test except `all canonical pages exist` must pass in your worktree. Also render each of your files once with `renderDoc` (for example `node --import tsx -e "…"`) to check that alerts and prompt fences turn into the expected markup.
- Commit by path.

### Task 3: Get started — `index.md`, `quickstart.md`, `concepts.md`

- `index.md` (Overview, order 1):
  - What Blink is: the README first paragraphs, rewritten.
  - Who the docs are for: two cards as a short list, linking `/docs/quickstart` for humans and `/docs/agents` for agents.
  - How the docs are organised: the four groups.
  - Current status: one paragraph with a link to `/docs/status`.
- `quickstart.md` (order 2): port the mockup's Quickstart page verbatim. It is in the mockup HTML `<script id="src-quickstart">` block, and its facts come from `docs/DEVELOPMENT.md`. Keep the frontmatter values the mockup uses.
- `concepts.md` (order 3): every CONTEXT.md term in English, grouped under `## Questions and specs` (Candidate, MarketSpec, Market), `## Forecasting` (Forecast window, Baseline), `## Trading and collateral` (Quote, Complete set, Reservation, Economic intent), `## Settlement and state` (Finality, INVALID, Projection), and `## Modes` (LIVE vs REPLAY, from the spec §2.2). Add a short "In practice" note under groups where it helps. Example: buying 100 YES at 6,000 bps (the README example).

### Task 4: Build an agent — `authentication.md`, `markets.md`, `forecasts.md`, `errors.md` (group "Build an agent", orders 1–4)

- `authentication.md`:
  - Wallet-challenge flow from the identity contracts (`packages/schemas/src/http.ts` request and response shapes for `/v1/auth/wallet-challenges` and `/v1/auth/wallet-verifications`) and `docs/M2_IDENTITY_DELIVERY.md`.
  - How to start the API in identity mode (`BLINK_API_MODE=identity` plus the database requirements stated in that delivery doc).
  - The `createBlinkClient(baseUrl, apiKey?)` HTTPS/localhost rule from `packages/client/src/index.ts`.
  - Invite-only writes.
- `markets.md`:
  - Market and MarketSpec model, specHash = keccak256 of the exact bytes, and never re-serialising (CONTEXT, spec §5).
  - The GM_LT_V1 template (spec §5.1).
  - Read endpoints with their statuses (`/v1/markets*` Planned; `/v1/specs/{specHash}` Approval mode; `/v1/evidence/{id}` Preparation mode).
- `forecasts.md`:
  - Forecast windows: one forecast per agent per window, and withdrawals stay on record.
  - Baseline separation; the two platform forecasters are not independent participants (spec §1).
  - Endpoints, all Planned.
  - Required headers.
- `errors.md`:
  - The `ApiError` shape (http.ts).
  - Status codes 400/401/403/404/409/429/500/501/503 and what each means here (501 = planned operation, `/v1/health` 503 until the trading path is ready).
  - `Idempotency-Key` required on every POST (1–128 chars).
  - Retry guidance: unknown is not failure (CONTEXT Finality).

### Task 5: How Blink works + Reference — `lifecycle.md`, `architecture.md`, `status.md`, `api.md`

- `lifecycle.md` (How Blink works, order 1):
  - The contract state machine OPEN/PROPOSED/DISPUTED/FINAL and derived CLOSED (spec §6.2).
  - Proposal, challenge, arbitration and timeout INVALID.
  - Redeem.
  - INVALID pays 0.5 bUSD per share.
  - Finality states.
  - A markdown table of transitions.
- `architecture.md` (How Blink works, order 2):
  - Off-chain research and coordination; on-chain funds and outcomes; separate signing and sync (README).
  - Trust boundaries.
  - The modular monolith with separate processes.
  - The local ports table.
- `status.md` (Reference, order 2):
  - The M0–M5 table from `docs/ROADMAP.md`, in English.
  - What works locally today (API modes and their endpoints, using the exact status words).
  - What is not available (no Sepolia deployment, no trading, no public API).
  - Links to delivery docs by repo path, written as text, not links.
- `api.md` (Reference, order 1):
  - A short intro saying it is generated from the shared schemas and shows default contract status, with the API mode note.
  - Then the exact line `<!-- generated:api-index -->`.

### Task 6: Agent guide — `agents.md` (group "For agents", order 1)

- Start from the mockup's `<script id="src-agents">` content, then make it complete and exact. Keep the eight `## N. …` headings verbatim (the content test checks them).
- Imperative voice ("Do X. Expect Y.").
- Section 5 must list every operation an integrating agent uses: auth, markets, specs, evidence, forecast windows, forecasts, quotes and transactions. Give method, path, required headers and the exact status word for each.
- Section 6 lists the hard constraints from Global Constraints plus the spec invariants: integer shares; complete set = 1 bUSD; INVALID 0.5 per side; signed quote ≠ fill; no early exit; probabilities, maker quotes and execution prices are distinct.
- Section 7 points to `/docs/api.md` and summarises the counts per status.
- Add `> [!PLANNED]` where a workflow cannot run yet.
- End with a ```` ```prompt ```` block an operator can give to an agent to bootstrap itself from this page.

---

### Task 7: Integration, verification, delivery docs

**Files:** possibly small fixes anywhere in Tasks 1–6 files; `docs/M4_WEB_SHOWCASE_DELIVERY.md` (add a Docs section); `docs/ROADMAP.md` (M4 cell mentions docs).

- [ ] **Step 1:** After cherry-picking Wave 2, run `node --import tsx --test tests/web-docs-*.test.ts` (all pass now, including `all canonical pages exist`) and `pnpm --filter @blink/web typecheck`. In a clean worktree, run `pnpm check` and `pnpm build`. The route list must include `/docs/[[...slug]]` with all 12 pages prerendered, `/docs-md/[slug]` and `/llms.txt`.
- [ ] **Step 2: `next start` checks.** In the clean worktree, run `pnpm --filter @blink/web start`, then with curl:
  - `/docs/quickstart.md` returns 200 with `content-type: text/markdown; charset=utf-8`, and its body is byte-equal to `apps/web/content/docs/quickstart.md`.
  - `/docs.md` returns `index.md`.
  - `/docs/api.md` contains a generated table row for `GET` `/v1/markets`.
  - `/llms.txt` lists all 12 `.md` URLs.
  - `/docs/nope` returns 404.
- [ ] **Step 3: Screenshots and behaviour** with the CDP script (`…/scratchpad/shots/tool/cdp.mjs`):
  - Pages: `/docs`, `/docs/quickstart`, `/docs/agents`, `/docs/api`.
  - Sizes 1440×900 and 375×812, light and dark (dark via `localStorage.setItem('blink-theme','dark')` then reload).
  - Check `/` stays light with `blink-theme=dark` set.
  - Overflow: compare element rects to the viewport (ignore `.docs-table`, `pre`).
  - Clipboard: before clicking, stub `navigator.clipboard.writeText` to capture its argument. Then click Copy page, Copy prompt for agent and a code Copy, and assert the captured text: raw Markdown starting with `---`; a prompt containing `/docs/agents.md` and `/docs/quickstart.md`; code text only.
  - Sidebar `aria-current` on the right link; the mobile Menu opens and closes.
- [ ] **Step 4:** Fix findings through the owning task's implementer, or a fix subagent.
- [ ] **Step 5: Docs.** Add a "Docs system" section to `docs/M4_WEB_SHOWCASE_DELIVERY.md` covering scope, routes, verification and limitations, and copy this plan's "Open items" list into it. Update the ROADMAP M4 cell to mention the docs system.
- [ ] **Step 6:** Commit by path, then push. Report the hash.
