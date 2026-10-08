// Pure geometry for the hero trail. Coordinates are CSS pixels relative to the hero container.
export type Point = { x: number; y: number };

export type WaypointInput = {
  start: Point; // right end of the "trail" underline
  avoidRight: number | null; // right edge of the copy block the path must not cross
  bandTop: number; // top edge of the node band
  width: number; // container width
  nodes: readonly Point[]; // node centres, in drawing order
};

const CORRIDOR_GAP = 48;
const EDGE = 24;

export function trailWaypoints({ start, avoidRight, bandTop, width, nodes }: WaypointInput): Point[] {
  const corridor = avoidRight === null ? start.x : Math.max(start.x, avoidRight + CORRIDOR_GAP);
  if (corridor > width - EDGE) {
    // No clear corridor beside the copy (narrow screens): begin at the band edge below the word.
    return [{ x: Math.min(start.x, width - EDGE), y: bandTop }, ...nodes];
  }
  return [start, { x: corridor, y: bandTop }, ...nodes];
}

const round = (n: number) => Math.round(n * 10) / 10;

// Catmull-Rom through every point, with an alternating perpendicular nudge on the
// control points so the line reads as hand-drawn. Same input → same path.
export function trailPath(points: readonly Point[], wobble = 6): string {
  if (points.length < 2) return "";
  const at = (i: number): Point => points[Math.max(0, Math.min(points.length - 1, i))]!;
  let d = `M${round(at(0).x)} ${round(at(0).y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const sign = i % 2 === 0 ? 1 : -1;
    const nx = (-(p2.y - p1.y) / len) * wobble * sign;
    const ny = ((p2.x - p1.x) / len) * wobble * sign;
    const c1x = p1.x + (p2.x - p0.x) / 6 + nx;
    const c1y = p1.y + (p2.y - p0.y) / 6 + ny;
    const c2x = p2.x - (p3.x - p1.x) / 6 + nx;
    const c2y = p2.y - (p3.y - p1.y) / 6 + ny;
    d += ` C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p2.x)} ${round(p2.y)}`;
  }
  return d;
}
