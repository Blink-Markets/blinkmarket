import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSketch, SKETCHES } from "../apps/web/lib/docs/sketches.ts";

const viewBoxes = { payout: "0 0 1200 600" } as const;

test("sketches are deterministic complete svg documents", () => {
  assert.deepEqual([...SKETCHES], ["payout"]);
  for (const name of SKETCHES) {
    const svg = renderSketch(name);
    assert.equal(svg, renderSketch(name), name);
    assert.ok(svg.startsWith("<svg "), name);
    assert.ok(svg.endsWith("</svg>"), name);
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), name);
    assert.ok(svg.includes(`viewBox="${viewBoxes[name]}"`), name);
    assert.match(svg, /<title>[^<]+<\/title>/);
    assert.ok(svg.includes('fill="#ffffff"'), name);
    assert.ok(!/NaN|undefined|Infinity/.test(svg), name);
    assert.ok(!/\d\.\d{2,}/.test(svg.replace(/stroke-width="[^"]*"|opacity="[^"]*"/g, "")), `${name}: unrounded number`);
  }
});

test("sketch text is escaped", () => {
  const svg = renderSketch("payout");
  assert.ok(svg.includes("holds 100 bUSD"));
  assert.ok(!/<text[^>]*>[^<]*[<>][^<]*<\/text>/.test(svg));
});
