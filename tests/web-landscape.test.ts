import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLandscape } from "../apps/web/lib/landscape.ts";

test("landscape is deterministic", () => {
  assert.deepEqual(buildLandscape(), buildLandscape());
});

test("landscape has three hatched layers, a trail and the sun at x 1030", () => {
  const l = buildLandscape();
  assert.equal(l.layers.length, 3);
  for (const layer of l.layers) assert.ok(layer.hatch.length > 0 && layer.fill.length > 0);
  assert.ok(l.trail.startsWith("M"));
  assert.equal(l.sun.x, 1030);
});

test("every number in every path string is finite", () => {
  const l = buildLandscape();
  const paths = [l.rays, l.trail, ...l.layers.flatMap((x) => [x.fill, x.hatch]), ...[...l.plainStrokes, ...l.tufts].map((b) => b.d), ...l.walker.strokes.map((s) => s.d)];
  for (const d of paths) {
    assert.doesNotMatch(d, /NaN|Infinity/);
    const nums = d.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
    assert.ok(nums.length > 0);
    for (const n of nums) assert.ok(Number.isFinite(Number(n)));
  }
});
