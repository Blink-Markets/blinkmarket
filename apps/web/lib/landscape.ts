// Deterministic engraved landscape for the site footer (ported from the approved mockup).
// Pure: same seed, same output. Many small strokes are merged into a few path strings.

export type Layer = { fill: string; hatch: string; strokeWidth: number; opacity: number };
export type Speckle = { cx: number; cy: number; r: number; opacity: number };
/** Four-point star; `d` is its path, `delay` (seconds) is only set for the twinkling ones. */
export type Sparkle = { d: string; opacity: number; twinkle: boolean; delay: number };
/** Faint star field behind the footer content, in a 1600x600 box stretched to the footer. */
export type StarField = { viewBox: string; dots: Speckle[]; sparkles: Sparkle[] };
export type StrokeBucket = { d: string; strokeWidth: number; opacity: number };
export type Walker = {
  head: { cx: number; cy: number; r: number };
  strokes: { d: string; strokeWidth: number }[];
  pack: { x: number; y: number; width: number; height: number; rx: number };
};
export type Landscape = {
  viewBox: string;
  width: number;
  height: number;
  sun: { x: number; y: number; r: number };
  /** Landscape-sky dots (static). */
  speckles: Speckle[];
  /** Four-point sparkles in the landscape sky; the twinkling ones are drawn by the inline overlay. */
  sparkles: Sparkle[];
  rays: string;
  /** Sky region above the far ridge; clips the animated eye and rays so they sit behind the hills. */
  skyClip: string;
  layers: Layer[];
  plainTop: number;
  plainStrokes: StrokeBucket[];
  tufts: StrokeBucket[];
  trail: string;
  walker: Walker;
};

const W = 1600;
const H = 480;
const SEED = 20261009;

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = (n: number): number => Math.round(n * 10) / 10 + 0; // "+ 0" turns -0 into 0

type Wave = readonly [amp: number, freq: number, phase: number];
type Bump = readonly [at: number, width: number, height: number];

function ridge(base: number, waves: readonly Wave[], bumps: readonly Bump[]): (x: number) => number {
  return (x) => {
    let y = 0;
    for (const [a, f, p] of waves) y += a * Math.sin(x * f + p);
    for (const [at, w, h] of bumps) y += h * Math.exp(-(((x - at) / w) ** 2));
    return base - y;
  };
}

type Pt = readonly [x: number, y: number];

/** 1-decimal number without a leading zero ("0.5" -> ".5") to keep path strings small. */
const num = (n: number): string => String(r(n)).replace(/^(-?)0\./, "$1.");

/** One subpath: absolute start, then relative deltas between the already-rounded points (no drift). */
function poly(pts: readonly Pt[]): string {
  const first = pts[0];
  if (!first) return "";
  let px = r(first[0]);
  let py = r(first[1]);
  let out = `M${num(px)} ${num(py)}l`;
  let prev = "l";
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] as Pt;
    const x = r(p[0]);
    const y = r(p[1]);
    const dx = num(x - px);
    const dy = num(y - py);
    out += (prev === "l" || dx.startsWith("-") ? "" : " ") + dx + (dy.startsWith("-") ? "" : " ") + dy;
    prev = dy;
    px = x;
    py = y;
  }
  return out;
}

const line = (x1: number, y1: number, x2: number, y2: number): string => poly([[x1, y1], [x2, y2]]);

/** Four-point star path (curves pinch to the centre). A twinkling one also draws its animation delay. */
function makeSparkle(x: number, y: number, size: number, opacity: number, twinkle: boolean, rand: () => number): Sparkle {
  const c = `${num(x)} ${num(y)}`;
  const d = `M${num(x)} ${num(y - size)}Q${c} ${num(x + size)} ${num(y)}Q${c} ${num(x)} ${num(y + size)}Q${c} ${num(x - size)} ${num(y)}Q${c} ${num(x)} ${num(y - size)}Z`;
  return { d, opacity, twinkle, delay: twinkle ? r(rand() * 3.6) : 0 };
}

/** Splits a 0..1 depth into n bands; returns the band index. */
const band = (depth: number, n: number): number => Math.min(n - 1, Math.max(0, Math.floor(depth * n)));

/** Faint upper star field (own seed): 140 dots and 6 fixed sparkles, every other sparkle twinkling. */
export function buildStarField(): StarField {
  const rand = mulberry32(7331);
  const dots: Speckle[] = [];
  for (let u = 0; u < 140; u++) {
    dots.push({ cx: r(rand() * 1600), cy: r(rand() * 600), r: r(0.5 + Math.pow(rand(), 3) * 1.1), opacity: r(0.1 + rand() * 0.3) });
  }
  const fixed: readonly (readonly [number, number, number])[] = [[90, 70, 5], [1540, 110, 6], [1180, 40, 4], [720, 560, 4.5], [40, 470, 4], [1450, 520, 5]];
  const sparkles = fixed.map(([x, y, size], i) => makeSparkle(x, y, size, 0.45, i % 2 === 1, rand));
  return { viewBox: "0 0 1600 600", dots, sparkles };
}

export function buildLandscape(): Landscape {
  const rand = mulberry32(SEED);
  const sun = { x: 1030, y: 236, r: 46 };

  const defs = [
    { f: ridge(236, [[26, 0.004, 0.6], [14, 0.011, 2.1], [7, 0.027, 0.3], [2.5, 0.09, 1.7]], [[1320, 120, 78], [1250, 60, 22], [380, 150, 40], [520, 70, 18], [sun.x, 70, -30]]), gap: 2.5, w: 0.85, op: 0.9 },
    { f: ridge(272, [[14, 0.006, 1.9], [7, 0.017, 0.4], [3, 0.05, 1.2]], [[700, 220, 18], [sun.x, 120, -10]]), gap: 4.2, w: 1.0, op: 0.8 },
    { f: ridge(304, [[8, 0.008, 2.7], [4, 0.022, 1.1], [2, 0.06, 0.2]], [[200, 260, 10]]), gap: 5.4, w: 1.1, op: 0.75 },
  ];

  // Starry sky: dots denser toward the horizon, then a few four-point sparkles; both keep clear of the sun.
  const farTop = (defs[0] as (typeof defs)[number]).f;
  const speckles: Speckle[] = [];
  for (let s = 0; s < 260; s++) {
    const sx = rand() * W;
    const top = 122;
    const bottom = farTop(sx) - 8;
    const sy = top + Math.pow(rand(), 1.6) * Math.max(0, bottom - top);
    if (Math.hypot(sx - sun.x, sy - sun.y) < sun.r + 70) continue;
    speckles.push({ cx: r(sx), cy: r(sy), r: r(0.45 + Math.pow(rand(), 3) * 1.4), opacity: r(0.25 + rand() * 0.6) });
  }
  const sparkles: Sparkle[] = [];
  for (let q = 0; q < 60 && sparkles.length < 14; q++) {
    const qx = 40 + rand() * (W - 80);
    const qy = 128 + rand() * 70;
    if (qy > farTop(qx) - 18 || Math.hypot(qx - sun.x, qy - sun.y) < sun.r + 90) continue;
    sparkles.push(makeSparkle(qx, qy, 3.5 + rand() * 6, r(0.7 + rand() * 0.3), sparkles.length % 2 === 0, rand));
  }

  let rays = "";
  for (let a = 0; a < 36; a++) {
    const ang = Math.PI + (a / 35) * Math.PI;
    const r1 = sun.r + 14;
    const r2 = sun.r + 40 + (a % 2 ? 0 : 22);
    rays += line(sun.x + Math.cos(ang) * r1, sun.y + Math.sin(ang) * r1, sun.x + Math.cos(ang) * r2, sun.y + Math.sin(ang) * r2);
  }

  const skyPts: Pt[] = [[0, 100]];
  for (let x = 0; x <= W; x += 8) skyPts.push([x, (defs[0] as (typeof defs)[number]).f(x)]);
  skyPts.push([W, 100]);
  const skyClip = `${poly(skyPts)}Z`;

  const layers: Layer[] = defs.map((L) => {
    const pts: Pt[] = [[0, H]];
    for (let x = 0; x <= W; x += 8) pts.push([x, L.f(x)]);
    pts.push([W, H]);
    const fill = `${poly(pts)}Z`;
    let hatch = "";
    const rows = Math.ceil(70 / L.gap);
    for (let k = 1; k < rows; k++) {
      const off = k * L.gap * (1 + k * 0.05);
      let x0 = 0;
      while (x0 < W) {
        const len = 30 + rand() * 120;
        const gapLen = 4 + rand() * 14 + k * 0.6;
        const seg: Pt[] = [];
        for (let xx = x0; xx < Math.min(W, x0 + len); xx += 6) seg.push([xx, L.f(xx) + off + Math.sin(xx * 0.05 + k) * 0.8]);
        if (seg.length > 1 && rand() > 0.08 + k * 0.012) hatch += poly(seg);
        x0 += len + gapLen;
      }
    }
    return { fill, hatch, strokeWidth: L.w, opacity: L.op };
  });

  const plainTop = 312;
  const PLAIN_BANDS = 5;
  const plain = Array.from({ length: PLAIN_BANDS }, () => "");
  for (let y = plainTop + 4, step = 3; y < H; y += step, step *= 1.07) {
    const depth = (y - plainTop) / (H - plainTop);
    let x1 = rand() * 20;
    while (x1 < W) {
      const l = 6 + rand() * (14 + depth * 40);
      const gp = 6 + rand() * (18 + depth * 30);
      if (rand() > 0.25) {
        const ya = y + (rand() - 0.5) * depth * 2;
        const yb = y + (rand() - 0.5) * depth * 2;
        const i = band(depth, PLAIN_BANDS);
        plain[i] += line(x1, ya, x1 + l, yb);
      }
      x1 += l + gp;
    }
  }
  const plainStrokes: StrokeBucket[] = plain.map((d, i) => {
    const mid = (i + 0.5) / PLAIN_BANDS;
    return { d, strokeWidth: r(0.6 + mid * 0.9), opacity: r(0.45 + mid * 0.4) };
  });

  const TUFT_BANDS = 3;
  const tuftD = Array.from({ length: TUFT_BANDS }, () => "");
  for (let t = 0; t < 95; t++) {
    const ty = plainTop + 40 + Math.pow(rand(), 0.55) * (H - plainTop - 40);
    const dd = (ty - plainTop) / (H - plainTop);
    const tx = rand() * W;
    const size = (3 + dd * 15) * (0.6 + rand() * 0.8);
    const blades = 3 + Math.floor(rand() * 7);
    const i = band((dd - 0.2) / 0.8, TUFT_BANDS);
    for (let b = 0; b < blades; b++) {
      const bang = -Math.PI / 2 + (b / (blades - 1) - 0.5) * 1.6 + (rand() - 0.5) * 0.3;
      const bl = size * (0.6 + rand() * 0.6);
      tuftD[i] += line(tx + (rand() - 0.5) * size * 0.4, ty, tx + Math.cos(bang) * bl, ty + Math.sin(bang) * bl);
    }
  }
  const tufts: StrokeBucket[] = tuftD.map((d, i) => {
    const dd = 0.2 + ((i + 0.5) / TUFT_BANDS) * 0.8;
    return { d, strokeWidth: r(0.8 + dd), opacity: r(0.6 + dd * 0.35) };
  });

  const wx = 640;
  const wy = 376;
  const walker: Walker = {
    head: { cx: wx, cy: wy - 22, r: 2.6 },
    strokes: [
      { d: line(wx, wy - 19, wx - 1, wy - 9), strokeWidth: 2.6 },
      { d: line(wx - 1, wy - 9, wx - 4, wy) + line(wx - 1, wy - 9, wx + 3, wy), strokeWidth: 1.8 },
      { d: line(wx + 4, wy - 20, wx + 6, wy + 1), strokeWidth: 1.2 },
    ],
    pack: { x: wx - 4.5, y: wy - 18, width: 3.5, height: 6, rx: 1 },
  };

  return {
    viewBox: "0 120 1600 360",
    width: W,
    height: H,
    sun,
    speckles,
    sparkles,
    rays,
    skyClip,
    layers,
    plainTop,
    plainStrokes,
    tufts,
    trail: "M300 480 C 470 440, 430 402, 600 382 S 850 356, 905 334 S 1000 302, 1030 284",
    walker,
  };
}

const PAPER = "#FAFAF7";
const SKY = "#2148B8";

/** The never-animated part (stars, sun disc, hills, plain, tufts) as a standalone SVG document. */
export function serializeStaticLandscape(l: Landscape): string {
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${l.viewBox}" width="1600" height="360">`];
  for (const s of l.speckles) out.push(`<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${PAPER}" opacity="${s.opacity}"/>`);
  for (const q of l.sparkles) if (!q.twinkle) out.push(`<path d="${q.d}" fill="${PAPER}" opacity="${q.opacity}"/>`);
  out.push(`<circle cx="${l.sun.x}" cy="${l.sun.y}" r="${l.sun.r}" fill="${PAPER}"/>`);
  for (const L of l.layers) {
    out.push(`<path d="${L.fill}" fill="${PAPER}"/>`);
    out.push(`<path d="${L.hatch}" fill="none" stroke="${SKY}" stroke-width="${L.strokeWidth}" stroke-linecap="round" opacity="${L.opacity}"/>`);
  }
  out.push(`<rect x="0" y="${l.plainTop}" width="${l.width}" height="${l.height - l.plainTop}" fill="${PAPER}"/>`);
  for (const b of [...l.plainStrokes, ...l.tufts]) {
    out.push(`<path d="${b.d}" fill="none" stroke="${SKY}" stroke-width="${b.strokeWidth}" stroke-linecap="round" opacity="${b.opacity}"/>`);
  }
  out.push("</svg>");
  return out.join("\n");
}

/** The static upper star field (dots and non-twinkling sparkles) as a standalone SVG used as a CSS background. */
export function serializeStarField(f: StarField): string {
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f.viewBox}" preserveAspectRatio="none">`];
  for (const s of f.dots) out.push(`<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${PAPER}" opacity="${s.opacity}"/>`);
  for (const q of f.sparkles) if (!q.twinkle) out.push(`<path d="${q.d}" fill="${PAPER}" opacity="${q.opacity}"/>`);
  out.push("</svg>");
  return out.join("\n");
}
