import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as content from "../apps/web/content/advantages.ts";
import { FOR_AGENTS, FOR_PEOPLE } from "../apps/web/content/positioning.ts";
const { advantages } = content;

test("the advantages are the eight implemented items, RFQ first and no custody second", () => {
  assert.deepEqual(Object.keys(content), ["advantages"]);
  assert.deepEqual(advantages.map((a) => a.id), ["rfq-long-tail", "no-custody", "agent-only", "readable-reasoning", "closed-loop", "contamination", "research-vs-price", "agent-safety"]);
  for (const a of advantages) assert.deepEqual(Object.keys(a).sort(), ["docs", "evidence", "id", "points", "summary", "title"], a.id);
});
test("every advantage is short enough for the home page", () => {
  for (const a of advantages) {
    assert.ok(a.summary.length > 0 && !/\.\s/.test(a.summary.trim().slice(0, -1)), `${a.id}: one-sentence summary`);
    assert.ok(a.points.length <= 2 && a.points.every((p) => p.length > 0 && p.length <= 200), a.id);
  }
});
test("every advantage names evidence that exists and a docs page that exists", () => {
  for (const a of advantages) {
    assert.ok(a.evidence.length > 0, a.id);
    for (const path of a.evidence) assert.ok(existsSync(path), `${a.id}: ${path}`);
    assert.match(a.docs, /^\/docs\/[a-z0-9-]+$/);
    assert.ok(existsSync(`apps/web/content${a.docs}.md`), a.id);
  }
});
test("every limit that left the home page is stated on the docs page its advantage links to", () => {
  const limits: Record<string, string[]> = {
    "rfq-long-tail": ["There is no push delivery", "only when at least one registered maker chooses to quote it"],
    "no-custody": ["A stolen key loses that agent's funds", "skips the client's checks", "no external audit"],
    "agent-only": ["do not prove that different people control them", "[Trust](/docs/trust)"],
    "readable-reasoning": ["fixture model"],
    "closed-loop": ["anchored only if an agent anchors it"],
    "contamination": ["can read sealed answers before the deadline", "is not detected"],
    "research-vs-price": ["moves no funds"],
    "agent-safety": ["are not a trusted identity"],
  };
  assert.deepEqual(Object.keys(limits), advantages.map((a) => a.id));
  for (const a of advantages) {
    const page = readFileSync(`apps/web/content${a.docs}.md`, "utf8");
    for (const phrase of limits[a.id]!) assert.ok(page.includes(phrase), `${a.id} (${a.docs}): ${phrase}`);
  }
});
test("the positioning lines are the approved copy", () => {
  assert.equal(FOR_AGENTS, "A market where agents trade and earn fees, each working to maximize its profit.");
  assert.equal(FOR_PEOPLE, "An open encyclopedia of the future: look up the probability of an event that has not happened yet, and read how agents reached it. People read; agents do the work.");
});
