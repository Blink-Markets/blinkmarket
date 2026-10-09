import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLandscape, buildStarField, serializeStarField, serializeStaticLandscape } from "../apps/web/lib/landscape.ts";

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

test("static serialiser is deterministic, a standalone svg and finite", () => {
  const a = serializeStaticLandscape(buildLandscape());
  assert.equal(a, serializeStaticLandscape(buildLandscape()));
  assert.ok(a.startsWith("<svg"));
  assert.ok(a.includes('viewBox="0 120 1600 360"'));
  assert.doesNotMatch(a, /NaN|Infinity|undefined/);
});

test("landscape star field: deterministic, counted, clear of the sun, finite", () => {
  const l = buildLandscape();
  assert.deepEqual(l.speckles, buildLandscape().speckles);
  assert.ok(l.speckles.length > 150 && l.speckles.length <= 260);
  assert.ok(l.sparkles.length > 0 && l.sparkles.length <= 14);
  assert.ok(l.sparkles.some((q) => q.twinkle) && l.sparkles.some((q) => !q.twinkle));
  for (const s of l.speckles) {
    assert.ok([s.cx, s.cy, s.r, s.opacity].every(Number.isFinite));
    assert.ok(Math.hypot(s.cx - l.sun.x, s.cy - l.sun.y) >= l.sun.r + 70 - 0.1);
  }
  for (const q of l.sparkles) {
    assert.doesNotMatch(q.d, /NaN|Infinity/);
    assert.ok(Number.isFinite(q.opacity) && Number.isFinite(q.delay));
    const [x, y] = (q.d.match(/^M(-?[\d.]+) (-?[\d.]+)/) ?? []).slice(1).map(Number) as [number, number];
    assert.ok(Math.hypot(x - l.sun.x, y - l.sun.y) >= l.sun.r + 90 - 12);
  }
  const svg = serializeStaticLandscape(l);
  for (const q of l.sparkles) assert.equal(svg.includes(`<path d="${q.d}"`), !q.twinkle);
});

test("upper star field: 140 dots and 6 sparkles, deterministic, standalone svg", () => {
  const f = buildStarField();
  assert.deepEqual(f, buildStarField());
  assert.equal(f.dots.length, 140);
  assert.equal(f.sparkles.length, 6);
  assert.equal(f.sparkles.filter((q) => q.twinkle).length, 3);
  for (const d of f.dots) assert.ok([d.cx, d.cy, d.r, d.opacity].every(Number.isFinite) && d.opacity >= 0.1 && d.opacity <= 0.4);
  const svg = serializeStarField(f);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes('viewBox="0 0 1600 600"'));
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});
