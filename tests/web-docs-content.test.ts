import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
      assert.ok(["blinkmarket.xyz", "github.com", ...(p.slug === "deployment" ? ["sepolia.basescan.org", "repo.sourcify.dev"] : [])].includes(m[1] ?? ""), `${p.file}: host ${m[1]}`);
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

test("only the deployment record keeps a v0.1 history notice", () => {
  // The other pages were rewritten for the autonomous market (P3); `deployment` records the v0.1 alpha-2 contracts as history.
  for (const p of pages) {
    const opening = p.body.split(/\n## /)[0] ?? "";
    const notice = /> \[!NOTE\]\n> [^\n]*v0\.1/.test(opening);
    assert.equal(notice, p.slug === "deployment", `${p.file}: ${notice ? "carries" : "lacks"} a v0.1 notice`);
  }
});

test("the forecaster page does not say that the reference forecaster publishes no reasoning document", () => {
  // The reference forecaster signs the hash of a forecast note and uploads it, so the old sentence is false.
  const forecaster = pages.find((p) => p.slug === "forecaster");
  assert.ok(forecaster, "forecaster.md is missing");
  assert.doesNotMatch(forecaster.body, /publishes no reasoning document/i);
  const duties = forecaster.body.split(/^## /m).find((s) => s.startsWith("Duties\n")) ?? "";
  assert.match(duties, /\*\*Reasoning is optional\.\*\*/);
  assert.match(duties, /forecast note/i);
});

const forecasterPage = () => {
  const forecaster = pages.find((p) => p.slug === "forecaster");
  assert.ok(forecaster, "forecaster.md is missing");
  return forecaster;
};

test("the forecaster page documents the note schema, the salt, the three triggers and the one-answer-per-window rule", () => {
  const body = forecasterPage().body;
  // The note schema: its name, its kinds, the fields a reader checks and the four item statuses.
  assert.match(body, /blink\.forecast-note\/0\.1/);
  for (const field of ["kind", "salt", "checkedAt", "prior", "evidence", "fingerprint", "snapshot", "summary"])
    assert.match(body, new RegExp(`\`${field}\``), `the note field ${field} is not named`);
  for (const word of ["analysis", "carry_forward", "NEW", "CHANGED", "UNCHANGED", "UNREACHABLE"])
    assert.match(body, new RegExp(`\`${word}\``), `${word} is not named`);
  // The salt keeps a sealed answer from being guessed from the hash of a public note.
  assert.match(body, /salt[^.]*(guess|reveal)|(guess|reveal)[^.]*salt/i);
  // The three triggers, the carry-forward and the heartbeat setting.
  assert.match(body, /no earlier forecast/i);
  assert.match(body, /source (?:has |that )?changed|changed source/i);
  assert.match(body, /heartbeat/i);
  assert.match(body, /BLINK_FORECAST_HEARTBEAT_HOURS/);
  assert.match(body, /carr(?:y|ies) (?:it |the earlier probability )?forward|carry-forward/i);
  // Snapshots wait for the deadline, and a window takes one answer.
  assert.match(body, /after the (?:window's )?deadline[^.]*(?:snapshot|archived)|(?:snapshot|archived)[^.]*after the (?:window's )?deadline/i);
  assert.match(body, /one answer per window/i);
  assert.match(body, /withdraw[^.]*(?:does not|doesn't|cannot)[^.]*(?:free|reopen)/i);
});

test("the forecaster page names getMarketFreshness and client.md has its subsection", () => {
  const forecaster = forecasterPage();
  assert.match(forecaster.body, /`getMarketFreshness\(/);
  assert.match(forecaster.body, /\]\(\/docs\/client\)/);
  const client = pages.find((p) => p.slug === "client");
  assert.ok(client, "client.md is missing");
  assert.match(client.body, /^### Reading how fresh a market is$/m);
  assert.match(client.body, /`getMarketFreshness\(client, marketId/);
});

test("the forecaster page warns that fetched page text is untrusted input", () => {
  const body = forecasterPage().body;
  assert.match(body, /untrusted input/i);
  assert.match(body, /prompt injection/i);
  assert.match(body, /treat[^.]*\bas data\b/i);
  // The warning is part of the role's Risks, where a reader weighs them.
  const risks = body.split(/^## /m).find((s) => s.startsWith("Risks\n")) ?? "";
  assert.match(risks, /untrusted input/i);
});

test("agents.md and the examples README still say that the reference agents use only the public API as shipped", () => {
  const agents = pages.find((p) => p.slug === "agents");
  assert.ok(agents, "agents.md is missing");
  const readme = readFileSync(join(process.cwd(), "examples/agents/README.md"), "utf8");
  // Line 3 of the README and the agents page keep the promise for the process as shipped.
  assert.match(readme, /They use the public API, `@blink\/client`, `viem` and the contracts, and nothing else/);
  assert.match(agents.body, /use only the public docs, the public API, `@blink\/client` and your own keys/);
  // The reference process reads sources only from its world file; httpsFetcher is for operators who embed the code.
  for (const [name, text] of [["agents.md", agents.body], ["README", readme]] as const) {
    assert.match(text, /`httpsFetcher`/, `${name} does not name httpsFetcher`);
    assert.match(text, /fixture/i, `${name} does not name the fixture world`);
    assert.match(text, /embed/i, `${name} does not say who httpsFetcher is for`);
  }
  assert.match(readme, /BLINK_FORECAST_HEARTBEAT_HOURS/);
});
