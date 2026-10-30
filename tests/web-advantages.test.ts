import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { advantages, comparison, blinkPosition } from "../apps/web/content/advantages.ts";
import { FOR_AGENTS, FOR_PEOPLE } from "../apps/web/content/positioning.ts";

test("the advantages list has the fixed ids, order and statuses", () => {
  assert.deepEqual(advantages.map((a) => [a.id, a.status]), [
    ["rfq-long-tail", "implemented"], ["no-custody", "implemented"], ["agent-only", "implemented"], ["readable-reasoning", "implemented"],
    ["closed-loop", "implemented"], ["contamination", "implemented"], ["research-vs-price", "implemented"],
    ["agent-safety", "implemented"], ["public-deployment", "under-construction"], ["banned-questions", "under-construction"],
    ["platform-token", "under-construction"], ["introduction-video", "under-construction"],
  ]);
});
test("no advantage claims what the research cannot support, or names a token price source", () => {
  assert.ok(!/no other (market|platform)|only (market|platform)|nobody else/i.test(JSON.stringify(advantages)));
  assert.ok(!/price source|TWAP|oracle price/i.test(advantages.find((a) => a.id === "platform-token")!.limits.join(" ")));
});
test("every implemented advantage names evidence that exists", () => {
  for (const a of advantages.filter((x) => x.status === "implemented")) {
    assert.ok(a.evidence.length > 0, a.id);
    for (const path of a.evidence) assert.ok(existsSync(path), `${a.id}: ${path}`);
  }
  for (const a of advantages.filter((x) => x.status === "under-construction")) assert.deepEqual(a.evidence, [], a.id);
});
test("every advantage states its limits and links a docs page that exists", () => {
  for (const a of advantages) {
    assert.ok(a.limits.length > 0 && a.limits.every((x) => x.trim().length > 0), a.id);
    assert.ok(a.docs === "/" || (/^\/docs\/[a-z0-9-]+$/.test(a.docs) && existsSync(`apps/web/content${a.docs}.md`)), a.id);
  }
});
test("agent-only carries the §5.12 wording and links /docs/trust", () => {
  const text = JSON.stringify(advantages.find((a) => a.id === "agent-only"));
  assert.ok(text.includes("Under the publicly listed assumptions, honesty is the provably best strategy"));
  assert.ok(text.includes("/docs/trust"));
});
test("the positioning lines are the approved copy", () => {
  assert.equal(FOR_AGENTS, "A market where agents trade and earn fees, each working to maximize its profit.");
  assert.equal(FOR_PEOPLE, "An open encyclopedia of the future: look up the probability of an event that has not happened yet, and read how agents reached it. People read; agents do the work.");
});
test("every comparison fact has an https source and the check date", () => {
  for (const f of comparison) {
    assert.match(f.source, /^https:\/\/[^\s]+$/);
    assert.equal(f.checkedOn, f.topic === "custody" ? "2026-10-30" : "2026-10-29");
    assert.ok(f.fact.length > 0 && !/\b(best|leading|only)\b/i.test(f.fact), f.platform);
  }
  assert.deepEqual(Object.keys(blinkPosition).sort(), ["agents", "custody", "liquidity", "market-creation", "resolution"]);
});
