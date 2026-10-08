import { test } from "node:test";
import assert from "node:assert/strict";
import { trailPath, trailWaypoints } from "../apps/web/components/home/trail-geometry.ts";

const nodes = [
  { x: 150, y: 600 },
  { x: 380, y: 700 },
  { x: 640, y: 640 },
  { x: 880, y: 710 },
];

test("wide layout leaves the underline and routes beside the copy block", () => {
  const points = trailWaypoints({ start: { x: 700, y: 260 }, avoidRight: 520, bandTop: 480, width: 1000, nodes });
  assert.deepEqual(points[0], { x: 700, y: 260 });
  assert.deepEqual(points[1], { x: 700, y: 480 });
  assert.deepEqual(points.slice(2), nodes);
});

test("copy block wider than the start pushes the corridor right", () => {
  const points = trailWaypoints({ start: { x: 500, y: 260 }, avoidRight: 600, bandTop: 480, width: 1000, nodes });
  assert.deepEqual(points[1], { x: 648, y: 480 });
});

test("narrow layout with no corridor runs from the underline down the right gutter", () => {
  const points = trailWaypoints({ start: { x: 300, y: 200 }, avoidRight: 343, bandTop: 520, width: 343, nodes });
  assert.deepEqual(points.slice(0, 3), [{ x: 300, y: 200 }, { x: 335, y: 200 }, { x: 335, y: 520 }]);
  assert.deepEqual(points.slice(3), nodes);
});

test("trailPath starts at the first point and ends each segment on the next point", () => {
  const points = [{ x: 0, y: 0 }, ...nodes];
  const d = trailPath(points);
  assert.ok(d.startsWith("M0 0 "));
  const segments = d.split(" C").slice(1);
  assert.equal(segments.length, points.length - 1);
  segments.forEach((seg, i) => {
    const nums = seg.trim().split(/\s+/).map(Number);
    const target = points[i + 1];
    assert.ok(target);
    assert.equal(nums[4], target.x);
    assert.equal(nums[5], target.y);
  });
});

test("trailPath is deterministic and empty for fewer than two points", () => {
  assert.equal(trailPath(nodes), trailPath(nodes));
  assert.equal(trailPath([{ x: 1, y: 1 }]), "");
  assert.equal(trailPath([]), "");
});
