// Renders blink-logo.gif: the large-size Blink eye mark closing and opening twice, then holding open.
// Run from the repository root after `pnpm install`: node docs/assets/blink-logo-gif.mjs
// sharp comes in as a dependency of Next.js, so it is resolved through apps/web's `next` rather than added here.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const sharp = createRequire(fromWeb.resolve("next/package.json"))("sharp");

const SIZE = 512;
const STEP_MS = 20; // sampling interval; runs of identical frames merge into one longer frame
const LOOP_MS = 4000;
const CLOSED = 0.1; // vertical scale of the eye at the bottom of a blink

// A blink closes fast and opens slower: 80 ms down, 20 ms shut, 140 ms up.
const BLINKS_AT_MS = [1200, 1200 + 1000 / 3];
const DOWN = 80, SHUT = 20, UP = 140;

function eyeScale(t) {
  for (const at of BLINKS_AT_MS) {
    const d = t - at;
    if (d < 0 || d >= DOWN + SHUT + UP) continue;
    if (d < DOWN) { const k = d / DOWN; return 1 - (1 - CLOSED) * k * k; }
    if (d < DOWN + SHUT) return CLOSED;
    const k = (d - DOWN - SHUT) / UP;
    return CLOSED + (1 - CLOSED) * (1 - (1 - k) * (1 - k));
  }
  return 1;
}

// Same drawing as apps/web/app/apple-touch-icon.png/route.tsx; the eye scales about the mark's centre line.
const frame = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#2148B8"/>
  <g transform="translate(0 32) scale(1 ${s.toFixed(4)}) translate(0 -32)">
    <path d="M8 32 Q32 8 56 32 Q32 56 8 32 Z" fill="none" stroke="#FAFAF7" stroke-width="4.5" stroke-linejoin="round"/>
    <circle cx="32" cy="32" r="9.5" fill="#FAFAF7"/>
    <circle cx="35.5" cy="28.5" r="2.6" fill="#C65F38"/>
  </g>
</svg>`;

const scales = [];
const delays = [];
for (let t = 0; t < LOOP_MS; t += STEP_MS) {
  const s = Math.round(eyeScale(t) * 1000) / 1000;
  if (scales.length && scales.at(-1) === s) delays[delays.length - 1] += STEP_MS;
  else { scales.push(s); delays.push(STEP_MS); }
}

const frames = await Promise.all(scales.map((s) => sharp(Buffer.from(frame(s))).png().toBuffer()));
await sharp(frames, { join: { animated: true } })
  .gif({ delay: delays, loop: 0, effort: 10, dither: 0 })
  .toFile(`${here}blink-logo.gif`);

console.log(`${scales.length} frames, ${delays.reduce((a, b) => a + b, 0)} ms loop`);
