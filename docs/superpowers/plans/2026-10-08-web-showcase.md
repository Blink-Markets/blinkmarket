# Web Showcase Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder `apps/web` root route with a read-only, illustrated showcase site (`/`, `/markets`, `/how-it-works`, `/docs`, `/docs/api`) in the mono-color two-ink style, with a masked word-by-word hero and scroll-driven reveals.

**Architecture:** Next 16 App Router, Server Components everywhere except two small client components: `RevealObserver` (IntersectionObserver fallback) and `HeroTrail` (measures the hero layout and draws the trail path through it). Text and reveal motion is CSS (keyframes + scroll-driven `animation-timeline: view()`), gated by `prefers-reduced-motion: no-preference`. Illustrations are hand-built inline SVG sharing halftone `<pattern>`s defined once in the root layout. Content is static TypeScript modules; the API index is generated at build time from `@blink/schemas` `generateOpenApi()`.

**Tech Stack:** Next 16.3.5, React 19.3, TypeScript 5.9, CSS Modules, `next/font/google` (Geist, Geist Mono), Node test runner via `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-08-web-showcase-design.md`

## Global Constraints

- No new third-party npm dependencies. No Tailwind. CSS Modules + `apps/web/app/globals.css` tokens only. (Adding the workspace package `@blink/schemas` to `apps/web` is allowed.)
- Inks: `--paper #FAFAF7`, `--cobalt #2148B8`, `--terracotta #C65F38`, `--ink #242321`, `--rule #24232133`. Illustrations use only cobalt, terracotta and paper. Terracotta is reserved for the "trail": hero accent word, the trail path, probability markers, and one hand-drawn gesture per illustration.
- No gradients, drop shadows, glows, 3D, card grids, or CTA buttons. Links are text links.
- Fonts: Geist (display/body) and Geist Mono (labels, numbers, status) via `next/font/google`, CSS variables `--font-geist` and `--font-geist-mono`.
- Light mode only.
- English copy. Terse, factual, no hype.
- Every page shows the testnet strip: `Base Sepolia testnet · Test assets have no value · No trading on this site`.
- Never claim a Sepolia deployment, live markets, live API, or prior forecast record. Sample markets are `mode: "REPLAY"` with fictional companies. The API host is written as `<API_BASE_URL>`; no invented domains.
- Any hidden-before-animation style must live inside `@media (prefers-reduced-motion: no-preference)`. Without JS or without scroll-timeline support, all content must be visible.
- No horizontal page scroll at 375px width; 16px minimum side gutter.
- Before writing Next code, read the relevant guide in `apps/web/node_modules/next/dist/docs/01-app/` (Next 16 has breaking changes; see `apps/web/AGENTS.md`). Relevant: `01-getting-started/03-layouts-and-pages.md`, `05-server-and-client-components.md`, `11-css.md`, `13-fonts.md`, `14-metadata-and-og-images.md`.
- Files under `apps/web/content/` must have **no imports** and must type-check under the root `tsconfig.json` (`NodeNext`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), because tests in `tests/` import them.

## Parallel Execution Rules (for the controller)

- **Wave 1:** Task 1 alone. The controller then runs `pnpm --filter @blink/web build` and commits.
- **Wave 2:** Tasks 2–6 run in parallel in the shared working tree. Each task touches only its listed files.
- **Wave 3:** Task 7 (home assembly, verification, delivery docs, final commit and push).
- Subagents in Wave 2 **must not** run `next build`, `next dev`, `pnpm build`, `git add`, or `git commit`, because concurrent runs collide on `.next/` and the git index. They verify with `pnpm --filter @blink/web typecheck` and `pnpm test`. Type errors in files outside their own file list come from another parallel task; they ignore those and make sure their own files have none.
- After Wave 2 the controller reviews each task's diff against this plan, runs `pnpm --filter @blink/web build`, takes screenshots, and commits.

## Review Focus

1. **Reduced motion:** with `prefers-reduced-motion: reduce`, the hero shows every word, the "trail" underline, the full measured trail path (static, no draw) and all four nodes; reveal sections are visible. Pinned by Task 7 Step 3 (static grep check) and the screenshot check.
2. **No JS / no scroll-timeline support:** content stays visible. `[data-reveal]` is hidden only under `html.reveal-fallback` (class added by JS), and only inside the no-preference media query. Pinned by Task 1's CSS and the Task 7 Step 3 grep.
3. **Mobile width 375px:** no horizontal overflow from the hero band, the ledger, or code blocks. Pinned by Task 7 Step 5 (`scrollWidth` check in the browser).
4. **API operations missing `x-status` / `x-planned-access`:** the index shows `unspecified` and `—` rather than crashing. Pinned by the Task 6 test `indexes operations missing vendor extensions`.
5. **Probability bounds and long questions:** 0 bps and 10000 bps render as `0.0%` and `100.0%` without the marker overflowing; long questions wrap. Pinned by the Task 4 test `formatBpsPercent handles bounds` and the marker clamp in `MarketLedger`.

---

### Task 1: Foundation: tokens, layout, chrome, motion plumbing, illustration interfaces

**Files:**
- Delete: `apps/web/app/route.ts`
- Modify: `apps/web/package.json` (add `"@blink/schemas": "workspace:*"` to `dependencies`), `pnpm-lock.yaml` (via `pnpm install`)
- Create: `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx` (temporary placeholder; Task 7 replaces it)
- Create: `apps/web/components/SiteHeader.tsx`, `apps/web/components/SiteHeader.module.css`, `apps/web/components/TestnetStrip.tsx`, `apps/web/components/SiteFooter.tsx`, `apps/web/components/SiteFooter.module.css`
- Create: `apps/web/components/motion/Reveal.tsx`
- Create: `apps/web/components/illustrations/inks.ts`, `types.ts`, `HalftoneDefs.tsx`, `Trail.tsx`
- Create stubs (Task 3 replaces their bodies): `apps/web/components/illustrations/Evidence.tsx`, `Forecast.tsx`, `Quote.tsx`, `Resolution.tsx`, `Evaluation.tsx`, `Architecture.tsx`

**Interfaces:**
- Produces:
  - `INK: { paper: "#FAFAF7"; cobalt: "#2148B8"; terracotta: "#C65F38"; ink: "#242321" }` from `components/illustrations/inks.ts`
  - `type IllustrationProps = { className?: string; title?: string }` from `components/illustrations/types.ts`
  - `Evidence`, `Forecast`, `Quote`, `Resolution`, `Evaluation`: `(props: IllustrationProps) => JSX.Element`, each rendering `<svg viewBox="0 0 240 240" role="img" aria-label={title}>`
  - `Architecture: (props: IllustrationProps) => JSX.Element`, rendering `<svg viewBox="0 0 960 540" role="img">`
  - `TrailSvg({ viewBox, d, className, strokeWidth? }: { viewBox: string; d: string; className?: string; strokeWidth?: number })`: decorative terracotta path drawn on scroll
  - Pattern ids available on every page: `ht-cobalt-15`, `ht-cobalt-30`, `ht-cobalt-60`, `ht-cobalt-90`, `ht-terracotta-60`, `hatch-cobalt`
  - Global classes: `.container`, `.section`, `.mono`, `.eyebrow`, `.tag`, `.rule`, `.visually-hidden`, `.prose`
  - Reveal hooks: put `data-reveal` on any element to fade or slide it in on scroll; put `data-draw-scope` on an `<svg>` and `data-draw` on a `pathLength={1}` path inside it to draw the path on scroll
  - CSS custom properties: `--ease-out`, `--gutter`, `--max`, `--font-sans`, `--font-mono`

- [ ] **Step 1: Read the Next 16 guides** listed in Global Constraints (layouts, server/client components, CSS, fonts, metadata).

- [ ] **Step 2: Remove the placeholder route and add the schemas workspace dependency**

```bash
git rm apps/web/app/route.ts
```

Edit `apps/web/package.json` dependencies to:

```json
  "dependencies": {
    "next": "16.3.5",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "@blink/domain": "workspace:*",
    "@blink/schemas": "workspace:*"
  },
```

Run: `pnpm install --offline` (fall back to `pnpm install` if the offline store misses).
Expected: lockfile gains the `@blink/schemas` link for `apps/web`; no new third-party packages.

- [ ] **Step 3: Write `apps/web/app/globals.css`**

```css
:root {
  --paper: #fafaf7;
  --cobalt: #2148b8;
  --terracotta: #c65f38;
  --ink: #242321;
  --ink-soft: #242321b3;
  --rule: #24232133;
  --gutter: clamp(16px, 5vw, 72px);
  --max: 1200px;
  --ease-out: cubic-bezier(0.2, 0.7, 0.1, 1);
  --font-sans: var(--font-geist), system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, monospace;
}

*, *::before, *::after { box-sizing: border-box; }
html { background: var(--paper); color: var(--ink); -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  font-family: var(--font-sans);
  font-size: 17px;
  line-height: 1.55;
  overflow-x: clip;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--cobalt); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--cobalt); outline-offset: 3px; }
h1, h2, h3 { margin: 0; font-weight: 700; letter-spacing: -0.035em; line-height: 1.02; }
h2 { font-size: clamp(34px, 5vw, 64px); }
h3 { font-size: clamp(22px, 2.4vw, 28px); letter-spacing: -0.02em; }
p { margin: 0; }
pre, code { font-family: var(--font-mono); font-size: 14px; }
pre { overflow-x: auto; max-width: 100%; }

.container { width: 100%; max-width: calc(var(--max) + 2 * var(--gutter)); margin-inline: auto; padding-inline: var(--gutter); }
.section { padding-block: clamp(72px, 12vw, 160px); }
.mono { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; line-height: 1.5; }
.eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cobalt); margin-bottom: 20px; display: block; }
.tag { display: inline-block; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid currentColor; padding: 2px 6px; line-height: 1.3; white-space: nowrap; }
.rule { border: 0; border-top: 1px solid var(--rule); margin: 0; }
.prose { max-width: 62ch; }
.prose p + p { margin-top: 1em; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* Scroll reveal. Hidden states exist only when motion is allowed. */
@media (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: view()) {
    [data-reveal] {
      animation: reveal-in linear both;
      animation-timeline: view();
      animation-range: entry 5% cover 30%;
    }
    [data-draw-scope] { view-timeline-name: --draw; }
    [data-draw] {
      stroke-dasharray: 1;
      animation: draw-in linear both;
      animation-timeline: --draw;
      animation-range: entry 10% cover 60%;
    }
  }
  html.reveal-fallback [data-reveal] { transition: opacity 0.8s var(--ease-out), transform 0.8s var(--ease-out); }
  html.reveal-fallback [data-reveal]:not([data-visible]) { opacity: 0; transform: translateY(28px); }
  html.reveal-fallback [data-draw] { stroke-dasharray: 1; stroke-dashoffset: 0; transition: stroke-dashoffset 1.6s var(--ease-out); }
  html.reveal-fallback [data-draw-scope]:not([data-visible]) [data-draw] { stroke-dashoffset: 1; }
}
@keyframes reveal-in { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: none; } }
@keyframes draw-in { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
```

- [ ] **Step 4: Write `apps/web/components/motion/Reveal.tsx`**

```tsx
"use client";
import { useEffect } from "react";

// Fallback for browsers without scroll-driven animations. Content stays visible
// unless this runs, so no-JS and reduced-motion users always see everything.
export function RevealObserver() {
  useEffect(() => {
    if (CSS.supports("animation-timeline: view()")) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!("IntersectionObserver" in window)) return;
    const root = document.documentElement;
    root.classList.add("reveal-fallback");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-visible", "");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    const observe = () =>
      document
        .querySelectorAll("[data-reveal]:not([data-visible]), [data-draw-scope]:not([data-visible])")
        .forEach((el) => io.observe(el));
    observe();
    const mo = new MutationObserver(observe);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
      root.classList.remove("reveal-fallback");
    };
  }, []);
  return null;
}
```

- [ ] **Step 5: Write the illustration plumbing**

`apps/web/components/illustrations/inks.ts`:

```ts
// SVG attributes use literal hex values; CSS variables in presentation attributes are not reliable everywhere.
export const INK = {
  paper: "#FAFAF7",
  cobalt: "#2148B8",
  terracotta: "#C65F38",
  ink: "#242321",
} as const;
```

`apps/web/components/illustrations/types.ts`:

```ts
export type IllustrationProps = { className?: string; title?: string };
```

`apps/web/components/illustrations/HalftoneDefs.tsx`:

```tsx
import { INK } from "./inks";

// Shared screens referenced as fill="url(#ht-cobalt-60)" from any inline SVG on the page.
const screens = [
  { id: "ht-cobalt-15", r: 0.9, color: INK.cobalt },
  { id: "ht-cobalt-30", r: 1.4, color: INK.cobalt },
  { id: "ht-cobalt-60", r: 2.1, color: INK.cobalt },
  { id: "ht-cobalt-90", r: 2.7, color: INK.cobalt },
  { id: "ht-terracotta-60", r: 2.1, color: INK.terracotta },
];

export function HalftoneDefs() {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        {screens.map((s) => (
          <pattern key={s.id} id={s.id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <circle cx="3" cy="3" r={s.r} fill={s.color} />
          </pattern>
        ))}
        <pattern id="hatch-cobalt" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">
          <line x1="0" y1="0" x2="0" y2="5" stroke={INK.cobalt} strokeWidth="1.2" />
        </pattern>
      </defs>
    </svg>
  );
}
```

`apps/web/components/illustrations/Trail.tsx`:

```tsx
import { INK } from "./inks";

type TrailSvgProps = { viewBox: string; d: string; className?: string; strokeWidth?: number };

// The site's single hand-drawn gesture: a terracotta path drawn as it scrolls into view.
export function TrailSvg({ viewBox, d, className, strokeWidth = 3 }: TrailSvgProps) {
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" fill="none" data-draw-scope="">
      <path d={d} pathLength={1} data-draw="" stroke={INK.terracotta} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
```

Stub for each of `Evidence`, `Forecast`, `Quote`, `Resolution`, `Evaluation` (repeat with its own name and default title: `"Evidence snapshot"`, `"Forecast dial"`, `"Signed quote"`, `"Resolution stamp"`, `"Forecast evaluation"`). Example `Evidence.tsx`:

```tsx
import { INK } from "./inks";
import type { IllustrationProps } from "./types";

export function Evidence({ className, title = "Evidence snapshot" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <rect x="48" y="48" width="144" height="144" fill="url(#ht-cobalt-30)" stroke={INK.cobalt} />
    </svg>
  );
}
```

Stub `Architecture.tsx` uses `viewBox="0 0 960 540"`, default title `"Blink target architecture"`, and the same placeholder rect scaled to the box.

- [ ] **Step 6: Write the chrome components**

`apps/web/components/TestnetStrip.tsx`:

```tsx
export function TestnetStrip() {
  return (
    <div role="note" className="mono" style={{ background: "var(--cobalt)", color: "var(--paper)", padding: "8px var(--gutter)", textAlign: "center" }}>
      Base Sepolia testnet · Test assets have no value · No trading on this site
    </div>
  );
}
```

`apps/web/components/SiteHeader.tsx`:

```tsx
import Link from "next/link";
import styles from "./SiteHeader.module.css";

const links = [
  { href: "/markets", label: "Markets" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader() {
  return (
    <header className={`container ${styles.header}`}>
      <Link href="/" className={styles.wordmark}>Blink</Link>
      <nav aria-label="Primary" className={styles.nav}>
        {links.map((l) => (
          <Link key={l.href} href={l.href}>{l.label}</Link>
        ))}
        <a href="https://github.com/Blink-Markets/blinkmarket">GitHub</a>
      </nav>
    </header>
  );
}
```

`apps/web/components/SiteHeader.module.css`:

```css
.header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px 32px; padding-block: 22px; border-bottom: 1px solid var(--rule); }
.wordmark { font-weight: 800; font-size: 24px; letter-spacing: -0.05em; color: var(--ink); text-decoration: none; }
.nav { display: flex; flex-wrap: wrap; gap: 8px 24px; font-family: var(--font-mono); font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; }
.nav a { color: var(--ink); text-decoration: none; }
.nav a:hover { color: var(--cobalt); }
```

`apps/web/components/SiteFooter.tsx`:

```tsx
import styles from "./SiteFooter.module.css";

export function SiteFooter() {
  return (
    <footer className={`container ${styles.footer}`}>
      <p className={styles.line}>Blink Market is an experiment. M0–M2 are built and verified locally; nothing is deployed to Base Sepolia yet.</p>
      <p className="mono">
        <a href="https://github.com/Blink-Markets/blinkmarket">Source on GitHub</a> · Spec v0.1 · Test assets only
      </p>
    </footer>
  );
}
```

`apps/web/components/SiteFooter.module.css`:

```css
.footer { display: grid; gap: 12px; padding-block: 48px 64px; margin-top: clamp(48px, 8vw, 120px); border-top: 1px solid var(--rule); color: var(--ink-soft); }
.line { max-width: 60ch; }
```

- [ ] **Step 7: Write `apps/web/app/layout.tsx` and a temporary `app/page.tsx`**

```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { HalftoneDefs } from "../components/illustrations/HalftoneDefs";
import { RevealObserver } from "../components/motion/Reveal";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { TestnetStrip } from "../components/TestnetStrip";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: { default: "Blink: every forecast leaves a trail", template: "%s · Blink" },
  description: "An experimental prediction-research platform for agents on the Base Sepolia testnet. Read-only showcase; no trading.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>
        <HalftoneDefs />
        <TestnetStrip />
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
        <RevealObserver />
      </body>
    </html>
  );
}
```

Temporary `apps/web/app/page.tsx`:

```tsx
export default function Home() {
  return <section className="container section"><h1>Blink</h1></section>;
}
```

- [ ] **Step 8: Verify**

Run: `pnpm --filter @blink/web typecheck` → no errors.
Run: `pnpm --filter @blink/web build` → succeeds; route list shows `/` as static. If fonts fail to download, report the error. Do not swap fonts.
Run: `pnpm check` → passes.

- [ ] **Step 9: Commit** (controller)

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add showcase foundation, tokens, chrome and motion plumbing"
```

---

### Task 2: Hero: masked word-by-word headline, accent morph, measured trail

**Files:**
- Create: `apps/web/components/home/Hero.tsx`, `apps/web/components/home/Hero.module.css`
- Create: `apps/web/components/home/HeroTrail.tsx` (client), `apps/web/components/home/trail-geometry.ts` (pure, no imports)
- Test: `tests/web-trail-geometry.test.ts`

**Interfaces:**
- Consumes: `Evidence`, `Forecast`, `Quote`, `Resolution` (`IllustrationProps`) from `components/illustrations/*`; `--ease-out`.
- Produces: `export function Hero(): JSX.Element` (Server Component, no props). Task 7 places it first on `/`.
- Internal: `type Point = { x: number; y: number }`, `trailWaypoints(input: WaypointInput): Point[]`, and `trailPath(points: readonly Point[], wobble?: number): string`, all in `trail-geometry.ts`.

The text motion is pure CSS keyframes inside `@media (prefers-reduced-motion: no-preference)`; the static styles are the final frame. The trail path is the only JS-driven part. `HeroTrail` measures the real positions of the "trail" underline, the copy block and the four nodes, then builds a path that leaves the underline and passes through every node centre. It re-measures on resize and after fonts load. Without JS, the trail path does not render; the headline, underline and nodes are still complete.

Timeline (seconds from navigation start):

| t | Event |
| --- | --- |
| 0.15 + i·0.22 | word i rises from below its clip mask (0.8s, blur 6px → 0) |
| 1.6 | copy block fades up |
| 2.1–3.0 | "trail" gets a terracotta block that wipes across it (0–35%), holds, then collapses to an underline (100%) |
| 3.0–4.6 | measured trail path draws from the underline through the nodes (delay = `max(0, 3000ms − performance.now())`, so a late hydration starts drawing immediately) |
| 3.1 + n·0.32 | node n fades or scales in |

- [ ] **Step 1: Write the failing geometry test** `tests/web-trail-geometry.test.ts`

```ts
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

test("narrow layout with no corridor starts at the band edge below the word", () => {
  const points = trailWaypoints({ start: { x: 300, y: 200 }, avoidRight: 343, bandTop: 520, width: 343, nodes });
  assert.deepEqual(points[0], { x: 300, y: 520 });
  assert.deepEqual(points.slice(1), nodes);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/web-trail-geometry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `trail-geometry.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/web-trail-geometry.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Write `HeroTrail.tsx`**

It measures the accent word's **mask wrapper** (`data-trail-start`), not the rising word, so the result does not depend on the current animation frame. Node centres come from each node's inner `<svg>`; their scale-in animation scales around the centre, so the centre stays fixed.

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./Hero.module.css";
import { trailPath, trailWaypoints, type Point } from "./trail-geometry";

type Geometry = { w: number; h: number; d: string };

export function HeroTrail() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const box = svg?.parentElement;
    if (!svg || !box) return;
    // Start drawing once the underline has formed (3s after navigation), or immediately if hydration was late.
    svg.style.setProperty("--draw-delay", `${Math.max(0, 3000 - performance.now())}ms`);

    const measure = () => {
      const origin = box.getBoundingClientRect();
      const rel = (x: number, y: number): Point => ({ x: x - origin.left, y: y - origin.top });
      const word = box.querySelector<HTMLElement>("[data-trail-start]");
      const avoid = box.querySelector<HTMLElement>("[data-trail-avoid]");
      const band = box.querySelector<HTMLElement>("[data-trail-band]");
      const nodes = [...box.querySelectorAll<HTMLElement>("[data-trail-node]")];
      if (!word || !band || nodes.length === 0) return;
      const w = word.getBoundingClientRect();
      const em = parseFloat(getComputedStyle(word).fontSize);
      const points = trailWaypoints({
        // Mask has 0.08em bottom padding; the underline sits about 0.08em above the word box bottom.
        start: rel(w.right + 0.04 * em, w.bottom - 0.16 * em),
        avoidRight: avoid ? avoid.getBoundingClientRect().right - origin.left : null,
        bandTop: band.getBoundingClientRect().top - origin.top,
        width: origin.width,
        nodes: nodes.map((n) => {
          const r = (n.querySelector("svg") ?? n).getBoundingClientRect();
          return rel(r.left + r.width / 2, r.top + r.height / 2);
        }),
      });
      setGeo({ w: origin.width, h: origin.height, d: trailPath(points) });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, []);

  return (
    <svg
      ref={svgRef}
      className={styles.trailSvg}
      aria-hidden="true"
      fill="none"
      viewBox={geo ? `0 0 ${geo.w} ${geo.h}` : undefined}
      data-ready={geo ? "" : undefined}
    >
      {geo && <path className={styles.trailPath} pathLength={1} d={geo.d} />}
    </svg>
  );
}
```

- [ ] **Step 6: Write `Hero.tsx`**

```tsx
import type { CSSProperties, ReactNode } from "react";
import { Evidence } from "../illustrations/Evidence";
import { Forecast } from "../illustrations/Forecast";
import { Quote } from "../illustrations/Quote";
import { Resolution } from "../illustrations/Resolution";
import { HeroTrail } from "./HeroTrail";
import styles from "./Hero.module.css";

function Word({ i, accent, children }: { i: number; accent?: boolean; children: ReactNode }) {
  return (
    <span className={styles.mask} data-trail-start={accent ? "" : undefined}>
      <span className={accent ? `${styles.word} ${styles.accent}` : styles.word} style={{ "--i": i } as CSSProperties}>
        {children}
      </span>
    </span>
  );
}

// Node centres in % of the band (desktop x/y, mobile mx/my). The trail is measured from these, so tune freely.
const nodes = [
  { label: "Evidence", Art: Evidence, x: "15%", y: "39%", mx: "27%", my: "20%" },
  { label: "Forecast", Art: Forecast, x: "38%", y: "69%", mx: "73%", my: "36%" },
  { label: "Quote", Art: Quote, x: "64%", y: "53%", mx: "27%", my: "63%" },
  { label: "Resolution", Art: Resolution, x: "88%", y: "72%", mx: "73%", my: "82%" },
];

export function Hero() {
  return (
    <section className={styles.hero}>
      <div className={`container ${styles.inner}`}>
        <HeroTrail />
        <h1 className={styles.headline} aria-label="every forecast leaves a trail">
          <span className={styles.line} aria-hidden="true">
            <Word i={0}>every</Word> <Word i={1}>forecast</Word>
          </span>
          <span className={styles.line} aria-hidden="true">
            <Word i={2}>leaves</Word> <Word i={3}>a</Word> <Word i={4} accent>trail</Word>
          </span>
        </h1>
        <div className={styles.copy} data-trail-avoid="">
          <p className={styles.lede}>
            Blink is an experimental prediction-research platform built for agents: questions with explicit
            resolution rules, traceable evidence, signed quotes, and test trades on Base Sepolia.
          </p>
          <p className={`mono ${styles.status}`}>M0–M2 built locally · No public deployment · No trading here</p>
        </div>
        <div className={styles.band} data-trail-band="">
          {nodes.map(({ label, Art, x, y, mx, my }, n) => (
            <figure key={label} className={styles.node} data-trail-node="" style={{ "--x": x, "--y": y, "--mx": mx, "--my": my, "--n": n } as CSSProperties}>
              <Art title={label} />
              <figcaption className="mono">{label}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Write `Hero.module.css`**

```css
.hero { padding-block: clamp(48px, 8vw, 112px) clamp(56px, 8vw, 120px); }
.inner { position: relative; }
.headline { position: relative; z-index: 1; font-size: clamp(52px, 11.5vw, 176px); font-weight: 800; letter-spacing: -0.055em; line-height: 0.92; }
.line { display: block; }
.mask { display: inline-block; overflow: clip; overflow-clip-margin: 0.1em; padding-bottom: 0.08em; vertical-align: bottom; }
.word { display: inline-block; }
.accent { position: relative; color: var(--terracotta); }
/* Final frame: a terracotta underline (bottom 12% of the block). */
.accent::after {
  content: "";
  position: absolute;
  inset: 0.1em -0.04em 0.02em -0.04em;
  background: var(--terracotta);
  clip-path: inset(88% 0 0 0);
}
.copy { position: relative; z-index: 1; width: fit-content; max-width: 100%; }
.lede { max-width: 36ch; margin-top: clamp(28px, 4vw, 48px); font-size: clamp(18px, 1.6vw, 21px); }
.status { margin-top: 16px; color: var(--cobalt); }

.trailSvg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; z-index: 0; }
.trailSvg:not([data-ready]) { visibility: hidden; }
.trailPath { stroke: var(--terracotta); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; fill: none; }

.band { position: relative; aspect-ratio: 1000 / 360; margin-top: clamp(40px, 6vw, 72px); }
.node { position: absolute; z-index: 1; left: var(--x); top: var(--y); width: 16%; margin: 0; transform: translate(-50%, -50%); text-align: center; }
.node svg { display: block; width: 100%; height: auto; }
.node figcaption { margin-top: 4px; color: var(--ink-soft); }

@media (max-width: 640px) {
  .band { aspect-ratio: 400 / 460; }
  .node { left: var(--mx); top: var(--my); width: 36%; }
}

@media (prefers-reduced-motion: no-preference) {
  .word { animation: rise 0.8s var(--ease-out) both; animation-delay: calc(0.15s + var(--i) * 0.22s); }
  .accent::after { animation: block-then-line 0.9s var(--ease-out) 2.1s both; }
  .copy { animation: fade-up 0.8s var(--ease-out) 1.6s both; }
  .trailSvg[data-ready] .trailPath { stroke-dasharray: 1; animation: draw 1.6s var(--ease-out) var(--draw-delay, 0s) both; }
  .node { animation: node-in 0.7s var(--ease-out) both; animation-delay: calc(3.1s + var(--n) * 0.32s); }
}
@keyframes rise { from { transform: translateY(105%); filter: blur(6px); } to { transform: none; filter: none; } }
@keyframes block-then-line {
  0% { clip-path: inset(0 100% 0 0); }
  35% { clip-path: inset(0 0 0 0); }
  60% { clip-path: inset(0 0 0 0); }
  100% { clip-path: inset(88% 0 0 0); }
}
@keyframes fade-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes node-in { from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); } to { opacity: 1; transform: translate(-50%, -50%); } }
```

Re-measuring on resize changes only the path's `d`; it does not restart the draw animation.

- [ ] **Step 8: Verify**

Run: `pnpm test` → all pass, including `web-trail-geometry`.
Run: `pnpm --filter @blink/web typecheck` and `pnpm typecheck` → no errors in `components/home/*` or the new test.

- [ ] **Step 9: Report** the files changed. In Task 7 the controller checks with screenshots that the path leaves the underline, avoids the copy, and crosses every node centre at 1440px and 375px.

---

### Task 3: Illustrations: five chapter specimens and the architecture plate

**Files:**
- Modify (replace stub bodies; keep names, props and viewBox): `apps/web/components/illustrations/Evidence.tsx`, `Forecast.tsx`, `Quote.tsx`, `Resolution.tsx`, `Evaluation.tsx`, `Architecture.tsx`

**Interfaces:**
- Consumes: `INK`, `IllustrationProps`, and pattern ids from Task 1.
- Produces: the same exports and signatures as the Task 1 stubs. Do not change them.

Rules for every specimen (from the mono-color skill, `~/.claude/skills/mono-color/SKILL.md` "Visual DNA"; read it first):
- Use only `INK.cobalt`, `INK.terracotta`, `INK.paper` and the halftone or hatch patterns. Do not use `INK.ink` except for `<text>` in Architecture.
- One dominant object fills 45–80% of the 240×240 box. Crop it decisively at an edge or corner when that adds tension.
- Paper cuts through the object: at least one `INK.paper` knockout shape on top of a cobalt mass.
- Exactly one terracotta gesture per specimen: a slightly irregular hand-drawn stroke (round caps, width 3, a path with gentle wobble rather than a perfect primitive).
- Mix density: one solid cobalt area, one halftone area (`url(#ht-cobalt-60)` or `-30`), and optionally one `hatch-cobalt` area.
- No text, gradients, filters, or shadows. Off-centre composition. Give the root `<svg>` `role="img"` and `aria-label={title}`.

- [ ] **Step 1: Evidence (Define chapter).** A document page with a folded corner, as a cobalt halftone mass cropped at the bottom edge. Paper knockout bars are the text rows; one solid cobalt block is the cited figure; a terracotta hand-drawn loop circles it.

```tsx
import { INK } from "./inks";
import type { IllustrationProps } from "./types";

export function Evidence({ className, title = "Evidence snapshot" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <path d="M58 28 H170 L196 54 V240 H58 Z" fill="url(#ht-cobalt-60)" />
      <path d="M170 28 V54 H196" fill="none" stroke={INK.cobalt} strokeWidth="2" />
      <rect x="74" y="76" width="96" height="7" fill={INK.paper} />
      <rect x="74" y="94" width="78" height="7" fill={INK.paper} />
      <rect x="74" y="112" width="104" height="7" fill={INK.paper} />
      <rect x="74" y="142" width="64" height="36" fill={INK.cobalt} />
      <path d="M62 160 C 60 128, 146 126, 152 154 S 96 196, 66 170" fill="none" stroke={INK.terracotta} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
```

- [ ] **Step 2: Forecast.** A semicircular dial that fills the lower two-thirds and is cropped at the bottom edge. The dial face is a halftone half-disc with a paper knockout inner arc band. Solid cobalt tick marks sit at 0/25/50/75/100%. A solid cobalt hub sits on the baseline. The terracotta gesture is a slightly wobbly needle pointing at about 62% (around 22° right of vertical).

- [ ] **Step 3: Quote.** A ticket stub rotated −8°: a solid cobalt rectangle about 170×110 that bleeds off the right edge. Paper semicircle notches cut each long side at the perforation line, and a dashed paper line marks the perforation. On the left part, paper knockout rows stand for the quote fields. The stub part is in `ht-cobalt-30`. The terracotta gesture is a hand-drawn tick or underline under the price row.

- [ ] **Step 4: Resolution.** A circular stamp, about 150px across and offset up and left. It has a thick `hatch-cobalt` ring and a solid cobalt inner disc with a paper knockout check-mark shape. Add a second, fainter `ht-cobalt-15` ring offset by 4px down and right (registration drift). The terracotta gesture is a hand-drawn swoosh under the stamp, as if it had just been pressed.

- [ ] **Step 5: Evaluation.** A calibration plot. Thin cobalt axes along the left and bottom edges and a dashed cobalt diagonal. There are 9–12 dots: most solid cobalt, a few halftone discs of larger radius, clustered near the diagonal with deliberate unevenness. A large `ht-cobalt-30` square block is cropped at the top-right corner to act as the dominant mass. The terracotta gesture is a hand-drawn circle around the one outlier dot.

- [ ] **Step 6: Architecture (960×540).** This is a labelled plate, so `<text>` is allowed with `style={{ fontFamily: "var(--font-mono)", fontSize: 14, letterSpacing: "0.06em" }}`, uppercase strings, and fill `INK.ink` or `INK.paper` on solid cobalt. Content matches the README architecture section:
  - Left: **Web + Wallet**, a paper box with a cobalt outline.
  - Centre: a large `ht-cobalt-15` container labelled **Backend**. Inside it are solid-cobalt boxes **API** and **Worker** with paper text, and below them **PostgreSQL** (cylinder) and **Evidence** (folder).
  - Between Backend and the chain: **Private signer**, an outlined box with a small padlock glyph built from rect and arc.
  - Right: **Base Sepolia**, two stacked solid-cobalt blocks labelled **BlinkMarket** and **BlinkTestUSD**.
  - Below the chain: **Indexer**, an outlined box.
  - Thin cobalt arrows, each with a small mono label: Web → API "RFQ"; Backend → Signer "sign request"; Signer → Backend "signed quote"; Base Sepolia → Indexer "events"; Indexer → PostgreSQL "sync".
  - The single terracotta gesture is a hand-drawn arc over the top from Web + Wallet to Base Sepolia, labelled "fill / redeem". This is the funds trail.
  - Keep 25%+ of the plate as open paper and avoid labels crossing arrows.

- [ ] **Step 7: Verify types**

Run: `pnpm --filter @blink/web typecheck`
Expected: no errors in `components/illustrations/*`.

- [ ] **Step 8: Report** the files changed. The controller reviews the illustrations visually after the wave and may send them back for one revision.

---

### Task 4: `/markets`: sample data, ledger, page, tests

**Files:**
- Create: `apps/web/content/sample-markets.ts`, `apps/web/components/MarketLedger.tsx`, `apps/web/components/MarketLedger.module.css`, `apps/web/app/markets/page.tsx`, `apps/web/app/markets/page.module.css`
- Test: `tests/web-sample-markets.test.ts`

**Interfaces:**
- Produces (Task 7 uses these):
  - `type MarketState = "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL"` (matches `effectiveState` in `packages/schemas/src/http.ts`)
  - `type Outcome = "YES" | "NO" | "INVALID"`
  - `type SampleMarket = { id: string; mode: "REPLAY"; entity: string; fiscalPeriod: string; thresholdBps: number; forecastBps: number; updatedAt: string; state: MarketState; outcome: Outcome | null }`
  - `sampleMarkets: readonly SampleMarket[]`
  - `marketQuestion(m: SampleMarket): string`, `formatBpsPercent(bps: number, digits?: number): string`, `stateLabel(m: SampleMarket): string`
  - `MarketLedger({ markets }: { markets: readonly SampleMarket[] })`

- [ ] **Step 1: Write the failing test** `tests/web-sample-markets.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sampleMarkets,
  marketQuestion,
  formatBpsPercent,
  stateLabel,
} from "../apps/web/content/sample-markets.ts";

test("sample markets are REPLAY-only with unique ids and valid bps", () => {
  assert.ok(sampleMarkets.length >= 6);
  assert.equal(new Set(sampleMarkets.map((m) => m.id)).size, sampleMarkets.length);
  for (const m of sampleMarkets) {
    assert.equal(m.mode, "REPLAY");
    assert.ok(m.forecastBps >= 0 && m.forecastBps <= 10_000, m.id);
    assert.ok(m.thresholdBps > 0 && m.thresholdBps < 10_000, m.id);
    assert.match(m.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(m.fiscalPeriod, /^FY\d{4}Q[1-4]$/);
  }
});

test("only FINAL markets carry an outcome", () => {
  for (const m of sampleMarkets) {
    assert.equal(m.state === "FINAL", m.outcome !== null, m.id);
  }
});

test("formatBpsPercent handles bounds", () => {
  assert.equal(formatBpsPercent(0), "0.0%");
  assert.equal(formatBpsPercent(10_000), "100.0%");
  assert.equal(formatBpsPercent(6240), "62.4%");
  assert.equal(formatBpsPercent(7000, 2), "70.00%");
});

test("question follows the GM_LT_V1 wording", () => {
  const first = sampleMarkets[0];
  assert.ok(first);
  assert.equal(
    marketQuestion(first),
    "Will Ostrander Kiln Works report FY2025 Q3 GAAP gross margin below 70.00%?",
  );
});

test("stateLabel names final outcomes", () => {
  const invalid = sampleMarkets.find((m) => m.outcome === "INVALID");
  assert.ok(invalid);
  assert.equal(stateLabel(invalid), "Final · INVALID");
  const open = sampleMarkets.find((m) => m.state === "OPEN");
  assert.ok(open);
  assert.equal(stateLabel(open), "Open");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/web-sample-markets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `apps/web/content/sample-markets.ts`**

```ts
// Sample REPLAY markets for the read-only showcase. Companies are fictional and
// follow the GM_LT_V1 template; these are not live markets or forecast records.
export type MarketState = "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL";
export type Outcome = "YES" | "NO" | "INVALID";

export type SampleMarket = {
  id: string;
  mode: "REPLAY";
  entity: string;
  fiscalPeriod: string;
  thresholdBps: number;
  forecastBps: number;
  updatedAt: string;
  state: MarketState;
  outcome: Outcome | null;
};

export const sampleMarkets: readonly SampleMarket[] = [
  { id: "sample-01", mode: "REPLAY", entity: "Ostrander Kiln Works", fiscalPeriod: "FY2025Q3", thresholdBps: 7000, forecastBps: 6240, updatedAt: "2026-10-06", state: "OPEN", outcome: null },
  { id: "sample-02", mode: "REPLAY", entity: "Pellbrook Freight Lines", fiscalPeriod: "FY2025Q3", thresholdBps: 3500, forecastBps: 4120, updatedAt: "2026-10-05", state: "OPEN", outcome: null },
  { id: "sample-03", mode: "REPLAY", entity: "Marrow & Vale Textiles", fiscalPeriod: "FY2025Q2", thresholdBps: 5200, forecastBps: 7810, updatedAt: "2026-09-30", state: "PROPOSED", outcome: null },
  { id: "sample-04", mode: "REPLAY", entity: "Tidewell Instruments", fiscalPeriod: "FY2025Q2", thresholdBps: 6100, forecastBps: 3350, updatedAt: "2026-09-28", state: "DISPUTED", outcome: null },
  { id: "sample-05", mode: "REPLAY", entity: "Quillon Grain Cooperative", fiscalPeriod: "FY2025Q1", thresholdBps: 2800, forecastBps: 1890, updatedAt: "2026-09-21", state: "FINAL", outcome: "NO" },
  { id: "sample-06", mode: "REPLAY", entity: "Harlow Fen Robotics", fiscalPeriod: "FY2025Q1", thresholdBps: 4500, forecastBps: 5000, updatedAt: "2026-09-19", state: "FINAL", outcome: "INVALID" },
];

export function formatBpsPercent(bps: number, digits = 1): string {
  return `${(bps / 100).toFixed(digits)}%`;
}

function formatPeriod(fiscalPeriod: string): string {
  return fiscalPeriod.replace(/^(FY\d{4})(Q[1-4])$/, "$1 $2");
}

export function marketQuestion(m: SampleMarket): string {
  return `Will ${m.entity} report ${formatPeriod(m.fiscalPeriod)} GAAP gross margin below ${formatBpsPercent(m.thresholdBps, 2)}?`;
}

const stateNames: Record<MarketState, string> = {
  OPEN: "Open",
  CLOSED: "Closed",
  PROPOSED: "Proposed",
  DISPUTED: "Disputed",
  FINAL: "Final",
};

export function stateLabel(m: SampleMarket): string {
  return m.state === "FINAL" && m.outcome ? `Final · ${m.outcome}` : stateNames[m.state];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/web-sample-markets.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Write `MarketLedger.tsx` and its CSS.** This is a ruled list, not cards. The forecast bar is a halftone-hatched track with a cobalt fill and a terracotta marker clamped inside the track.

```tsx
import type { CSSProperties } from "react";
import { formatBpsPercent, marketQuestion, stateLabel, type SampleMarket } from "../content/sample-markets";
import styles from "./MarketLedger.module.css";

export function MarketLedger({ markets }: { markets: readonly SampleMarket[] }) {
  return (
    <div className={styles.ledger}>
      <div className={`${styles.row} ${styles.head} mono`} aria-hidden="true">
        <span>Question</span><span>Mode</span><span>Forecast · YES</span><span>State</span><span>Updated</span>
      </div>
      <ol className={styles.list}>
        {markets.map((m) => (
          <li key={m.id} className={styles.row} data-reveal="">
            <p className={styles.question}>{marketQuestion(m)}</p>
            <span className={styles.mode}><span className="tag">{m.mode}</span></span>
            <span className={styles.forecast}>
              <span className={styles.track} aria-hidden="true">
                <span className={styles.fill} style={{ width: formatBpsPercent(m.forecastBps) }} />
                <span className={styles.marker} style={{ "--p": m.forecastBps / 10_000 } as CSSProperties} />
              </span>
              <span className={styles.pct}>{formatBpsPercent(m.forecastBps)}</span>
            </span>
            <span className={`mono ${styles.state}`}>{stateLabel(m)}</span>
            <time className={`mono ${styles.updated}`} dateTime={m.updatedAt}>{m.updatedAt}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}
```

`MarketLedger.module.css`:

```css
.ledger { border-top: 2px solid var(--ink); }
.list { list-style: none; margin: 0; padding: 0; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) 96px 200px 128px 104px; gap: 16px 24px; align-items: center; padding-block: 22px; border-bottom: 1px solid var(--rule); }
.head { padding-block: 12px; color: var(--ink-soft); }
.question { font-size: clamp(17px, 1.5vw, 20px); font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; overflow-wrap: anywhere; }
.mode { color: var(--cobalt); }
.forecast { display: flex; align-items: center; gap: 12px; }
.track { position: relative; flex: 1; height: 10px; background: repeating-linear-gradient(-35deg, transparent 0 4px, #2148b833 4px 5px); }
.fill { position: absolute; inset: 0 auto 0 0; background: var(--cobalt); }
.marker { position: absolute; top: -5px; bottom: -5px; width: 3px; left: clamp(0px, calc(var(--p) * 100% - 1.5px), calc(100% - 3px)); background: var(--terracotta); }
.pct { font-family: var(--font-mono); font-size: 14px; font-variant-numeric: tabular-nums; min-width: 6ch; text-align: right; }
.state, .updated { color: var(--ink-soft); }

@media (max-width: 860px) {
  .head { display: none; }
  .row { grid-template-columns: 1fr auto; grid-template-areas: "q q" "f f" "m s" "u u"; gap: 12px; }
  .question { grid-area: q; }
  .forecast { grid-area: f; }
  .mode { grid-area: m; }
  .state { grid-area: s; text-align: right; }
  .updated { grid-area: u; }
}
```

(`repeating-linear-gradient` here is a hatch texture, not a colour gradient, which is allowed.)

- [ ] **Step 6: Write `app/markets/page.tsx` and its CSS**

```tsx
import type { Metadata } from "next";
import { MarketLedger } from "../../components/MarketLedger";
import { sampleMarkets } from "../../content/sample-markets";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Markets" };

export default function MarketsPage() {
  return (
    <section className="container section">
      <span className="eyebrow">Markets</span>
      <h1 className={styles.title}>Sample markets</h1>
      <p className={`mono ${styles.notice}`}>Sample data · REPLAY only · Companies are fictional</p>
      <div className={`prose ${styles.intro}`}>
        <p>
          No live markets exist yet: Blink has no Base Sepolia deployment. These REPLAY samples show how a
          market reads once it does. Every question uses the GM_LT_V1 template, which asks whether a
          company&apos;s quarterly GAAP gross margin lands below a fixed threshold.
        </p>
        <p>
          Forecast is the platform forecasters&apos; average probability of YES at the latest window. It is
          not a price or a quote.
        </p>
      </div>
      <MarketLedger markets={sampleMarkets} />
    </section>
  );
}
```

`app/markets/page.module.css`:

```css
.title { font-size: clamp(48px, 8vw, 112px); font-weight: 800; letter-spacing: -0.05em; }
.notice { display: inline-block; margin-top: 24px; color: var(--terracotta); }
.intro { margin-block: 32px clamp(48px, 7vw, 88px); color: var(--ink-soft); }
```

- [ ] **Step 7: Verify**

Run: `pnpm test` → all pass, including `web-sample-markets`.
Run: `pnpm --filter @blink/web typecheck` and `pnpm typecheck` → no errors in this task's files.

- [ ] **Step 8: Report** the files changed (controller commits).

---

### Task 5: `/how-it-works`: chapters, architecture, worked example

**Files:**
- Create: `apps/web/app/how-it-works/page.tsx`, `apps/web/app/how-it-works/page.module.css`

**Interfaces:**
- Consumes: `Evidence`, `Forecast`, `Quote`, `Resolution`, `Evaluation`, `Architecture` (`IllustrationProps`); `TrailSvg`; `data-reveal`.
- Produces: the route only.

- [ ] **Step 1: Write `page.tsx`.** Chapters alternate illustration side on desktop and stack on mobile. A vertical `TrailSvg` runs in the gutter between chapters on desktop only.

```tsx
import type { Metadata } from "next";
import { Architecture } from "../../components/illustrations/Architecture";
import { Evaluation } from "../../components/illustrations/Evaluation";
import { Evidence } from "../../components/illustrations/Evidence";
import { Forecast } from "../../components/illustrations/Forecast";
import { Quote } from "../../components/illustrations/Quote";
import { Resolution } from "../../components/illustrations/Resolution";
import { TrailSvg } from "../../components/illustrations/Trail";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "How it works" };

const chapters = [
  {
    n: "01", title: "Define", Art: Evidence,
    body: [
      "A question starts as a candidate with a fixed template, an allowlisted source and an exact resolution rule.",
      "Source evidence is stored as original bytes. A human approves the candidate, the specification is frozen, and its hash is written on-chain when an administrator creates the market.",
    ],
  },
  {
    n: "02", title: "Forecast", Art: Forecast,
    body: [
      "Forecasts are collected inside defined windows. Each agent gets one forecast per window, and withdrawals stay on the record.",
      "Two platform forecasters inform maker pricing. An independent baseline and external agents are scored separately and never folded into the platform average.",
    ],
  },
  {
    n: "03", title: "Quote", Art: Quote,
    body: [
      "A taker requests a quote. The service reserves capacity and a private signer, which checks policy on its own, signs an EIP-712 quote bound to that taker.",
      "The taker submits it from their own wallet and the contract validates it again. A signed quote is not a fill.",
    ],
  },
  {
    n: "04", title: "Resolve", Art: Resolution,
    body: [
      "After close, an allowlisted proposer submits YES, NO or INVALID with evidence. A challenge window follows, and disputes go to an independent arbiter.",
      "If nothing finalises before the hard deadline, the market resolves INVALID. Holders then redeem on their own.",
    ],
  },
  {
    n: "05", title: "Evaluate", Art: Evaluation,
    body: [
      "An indexer rebuilds chain-derived projections from events. Forecasts are scored with Brier scores alongside research cost and latency.",
      "Missing forecasts and invalid outcomes are classified, not hidden.",
    ],
  },
];

const notInScope = [
  "Mainnet, real USDC, cash rewards or tokens",
  "Permissionless market creation",
  "Multiple makers or partial fills",
  "Selling or transferring positions before expiry",
  "Leverage, cross-chain or external oracles",
  "Claims that more agents means better accuracy",
];

export default function HowItWorksPage() {
  return (
    <>
      <section className="container section">
        <span className="eyebrow">How it works</span>
        <h1 className={styles.title}>From a question to a scored forecast</h1>
        <p className={`prose ${styles.lede}`}>
          Research and coordination happen off-chain. Funds and outcomes live on-chain. Signing and
          synchronisation run as separate, narrow processes. Five steps connect them.
        </p>
      </section>

      <section className={`container ${styles.chapters}`}>
        <TrailSvg viewBox="0 0 40 1000" d="M20 0 C 34 120, 6 220, 20 340 S 34 560, 18 680 S 6 900, 20 1000" className={styles.spine} />
        {chapters.map(({ n, title, Art, body }, i) => (
          <article key={n} className={i % 2 ? `${styles.chapter} ${styles.flip}` : styles.chapter} data-reveal="">
            <Art className={styles.art} />
            <div className={styles.copy}>
              <span className="eyebrow">{n}</span>
              <h2>{title}</h2>
              <div className="prose">{body.map((p) => <p key={p}>{p}</p>)}</div>
            </div>
          </article>
        ))}
      </section>

      <section className="container section">
        <span className="eyebrow">Architecture</span>
        <h2>Who holds what</h2>
        <Architecture className={styles.architecture} />
        <p className={`mono ${styles.caption}`}>Target architecture, not a live deployment</p>
      </section>

      <section className="container section" data-reveal="">
        <span className="eyebrow">Worked example</span>
        <h2>100 YES at 6,000 bps</h2>
        <div className={styles.example}>
          <div className={styles.collateral} aria-hidden="true">
            <span className={styles.taker}>Taker 60</span>
            <span className={styles.maker}>Maker 40</span>
          </div>
          <p className="prose">
            The taker pays 60 bUSD and the maker adds 40 bUSD, so the contract holds 100 bUSD of collateral:
            one complete set per share. The taker holds 100 YES and the maker holds the opposing 100 NO.
          </p>
          <table className={styles.payouts}>
            <thead><tr><th>Outcome</th><th>Taker (100 YES)</th><th>Maker (100 NO)</th></tr></thead>
            <tbody>
              <tr><td>YES</td><td>100 bUSD</td><td>0</td></tr>
              <tr><td>NO</td><td>0</td><td>100 bUSD</td></tr>
              <tr><td>INVALID</td><td>50 bUSD</td><td>50 bUSD</td></tr>
            </tbody>
          </table>
          <p className="mono">INVALID pays 0.5 bUSD per share on each side. It is not a refund of the purchase price.</p>
        </div>
      </section>

      <section className="container section" data-reveal="">
        <span className="eyebrow">Out of scope for v0.1</span>
        <ul className={styles.notList}>{notInScope.map((x) => <li key={x}>{x}</li>)}</ul>
      </section>
    </>
  );
}
```

- [ ] **Step 2: Write `page.module.css`**

```css
.title { font-size: clamp(44px, 7.5vw, 104px); font-weight: 800; letter-spacing: -0.05em; max-width: 14ch; }
.lede { margin-top: 32px; font-size: clamp(18px, 1.6vw, 21px); }
.chapters { position: relative; display: grid; gap: clamp(72px, 10vw, 140px); padding-bottom: clamp(72px, 10vw, 140px); }
.spine { position: absolute; left: 50%; top: 0; height: 100%; width: 40px; transform: translateX(-50%); }
.chapter { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: clamp(32px, 6vw, 96px); align-items: center; }
.flip .art { order: 2; }
.art { width: min(100%, 420px); height: auto; justify-self: center; }
.copy { display: grid; gap: 16px; background: var(--paper); padding-block: 12px; }
.architecture { display: block; width: 100%; height: auto; margin-top: 40px; }
.caption { margin-top: 12px; color: var(--ink-soft); }
.example { display: grid; gap: 28px; margin-top: 40px; max-width: 760px; }
.collateral { display: grid; grid-template-columns: 60fr 40fr; height: 56px; font-family: var(--font-mono); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
.taker { background: var(--cobalt); color: var(--paper); padding: 8px 12px; }
.maker { background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='6'%3E%3Ccircle cx='3' cy='3' r='1.4' fill='%232148B8'/%3E%3C/svg%3E"); color: var(--cobalt); padding: 8px 12px; border: 1px solid var(--cobalt); }
.payouts { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
.payouts th, .payouts td { text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--rule); }
.payouts th { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); font-weight: 400; }
.notList { list-style: none; padding: 0; margin: 24px 0 0; display: grid; gap: 0; max-width: 760px; }
.notList li { padding-block: 14px; border-bottom: 1px solid var(--rule); font-size: clamp(18px, 1.8vw, 22px); text-decoration: line-through; text-decoration-color: var(--terracotta); text-decoration-thickness: 2px; }

@media (max-width: 760px) {
  .spine { display: none; }
  .chapter { grid-template-columns: 1fr; }
  .flip .art { order: 0; }
  .art { width: min(72%, 300px); justify-self: start; }
}
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @blink/web typecheck` → no errors in `app/how-it-works/*`.

- [ ] **Step 4: Report** the files changed.

---

### Task 6: `/docs` and `/docs/api` with the OpenAPI index

**Files:**
- Create: `apps/web/content/openapi-index.ts`, `apps/web/app/docs/layout.tsx`, `apps/web/app/docs/docs.module.css`, `apps/web/app/docs/page.tsx`, `apps/web/app/docs/api/page.tsx`
- Test: `tests/web-openapi-index.test.ts`

**Interfaces:**
- Consumes: `generateOpenApi(enabledPaths?: readonly string[])` from `@blink/schemas` (`packages/schemas/src/http.ts:449`), which returns `{ info, paths: Record<path, Record<method, { operationId, "x-status", "x-planned-access", ... }>> }`.
- Produces: `type ApiOperation = { method: string; path: string; group: string; status: string; access: string | null }`, `indexOpenApi(doc: unknown): ApiOperation[]`, `groupOf(path: string): string`, `groupOperations(ops: readonly ApiOperation[]): { group: string; operations: ApiOperation[] }[]`.

- [ ] **Step 1: Write the failing test** `tests/web-openapi-index.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOpenApi } from "../packages/schemas/src/index.js";
import { indexOpenApi, groupOf, groupOperations } from "../apps/web/content/openapi-index.ts";

test("indexes every path and method from the shared contracts", () => {
  const doc = generateOpenApi();
  const expected = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  const ops = indexOpenApi(doc);
  assert.equal(ops.length, expected);
  for (const op of ops) {
    assert.match(op.method, /^(GET|POST|PUT|PATCH|DELETE)$/);
    assert.ok(op.path.startsWith("/"));
  }
  const markets = ops.find((o) => o.method === "GET" && o.path === "/v1/markets");
  assert.ok(markets);
  assert.equal(markets.status, "not-implemented");
  assert.equal(markets.group, "markets");
});

test("indexes operations missing vendor extensions", () => {
  const ops = indexOpenApi({ paths: { "/v1/config": { get: { responses: {} } } } });
  assert.deepEqual(ops, [{ method: "GET", path: "/v1/config", group: "config", status: "unspecified", access: null }]);
});

test("tolerates documents without paths", () => {
  assert.deepEqual(indexOpenApi({}), []);
  assert.deepEqual(indexOpenApi(null), []);
});

test("groups by the first segment after the version", () => {
  assert.equal(groupOf("/v1/admin/candidates/{id}/approve"), "admin");
  assert.equal(groupOf("/v1/markets/{id}/spec"), "markets");
  assert.equal(groupOf("/health"), "health");
  const grouped = groupOperations(indexOpenApi(generateOpenApi()));
  assert.ok(grouped.some((g) => g.group === "markets" && g.operations.length > 1));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/web-openapi-index.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `apps/web/content/openapi-index.ts`**

```ts
// Flattens an OpenAPI document into a list for the /docs/api index.
export type ApiOperation = {
  method: string;
  path: string;
  group: string;
  status: string;
  access: string | null;
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function groupOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const first = segments[0] === "v1" ? segments[1] : segments[0];
  return first ?? "root";
}

export function indexOpenApi(doc: unknown): ApiOperation[] {
  const paths = (doc as { paths?: unknown } | null)?.paths;
  if (!paths || typeof paths !== "object") return [];
  const ops: ApiOperation[] = [];
  for (const [path, item] of Object.entries(paths as Record<string, Record<string, unknown>>)) {
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op) continue;
      const status = op["x-status"];
      const access = op["x-planned-access"];
      ops.push({
        method: method.toUpperCase(),
        path,
        group: groupOf(path),
        status: typeof status === "string" ? status : "unspecified",
        access: typeof access === "string" ? access : null,
      });
    }
  }
  return ops.sort(
    (a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

export function groupOperations(ops: readonly ApiOperation[]): { group: string; operations: ApiOperation[] }[] {
  const groups = new Map<string, ApiOperation[]>();
  for (const op of ops) {
    const list = groups.get(op.group) ?? [];
    list.push(op);
    groups.set(op.group, list);
  }
  return [...groups].map(([group, operations]) => ({ group, operations }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/web-openapi-index.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Write `app/docs/layout.tsx` and `docs.module.css`**

```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./docs.module.css";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`container ${styles.docs}`}>
      <nav aria-label="Docs" className={`mono ${styles.subnav}`}>
        <Link href="/docs">Overview</Link>
        <Link href="/docs/api">API index</Link>
      </nav>
      {children}
    </div>
  );
}
```

```css
.docs { padding-block: clamp(48px, 8vw, 112px); }
.subnav { display: flex; gap: 24px; margin-bottom: clamp(40px, 6vw, 72px); }
.title { font-size: clamp(44px, 7vw, 96px); font-weight: 800; letter-spacing: -0.05em; }
.notice { margin-top: 20px; color: var(--terracotta); }
.block { margin-top: clamp(56px, 8vw, 96px); display: grid; gap: 20px; }
.terms { display: grid; grid-template-columns: minmax(140px, 220px) minmax(0, 1fr); margin: 0; border-top: 2px solid var(--ink); }
.terms dt, .terms dd { margin: 0; padding-block: 16px; border-bottom: 1px solid var(--rule); }
.terms dt { font-family: var(--font-mono); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--cobalt); padding-right: 16px; }
.steps { margin: 0; padding-left: 1.4em; display: grid; gap: 14px; max-width: 64ch; }
.code { background: transparent; border-left: 3px solid var(--cobalt); padding: 16px 20px; margin: 0; }
.ops { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.ops th, .ops td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.ops th { font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); font-weight: 400; }
.method { font-family: var(--font-mono); font-size: 13px; color: var(--cobalt); }
.path { font-family: var(--font-mono); font-size: 14px; overflow-wrap: anywhere; }
.tableWrap { overflow-x: auto; }
@media (max-width: 640px) {
  .terms { grid-template-columns: 1fr; }
  .terms dt { border-bottom: 0; padding-bottom: 0; }
}
```

- [ ] **Step 6: Write `app/docs/page.tsx`**

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import styles from "./docs.module.css";

export const metadata: Metadata = { title: "Docs" };

const terms: [string, string][] = [
  ["Candidate", "A question awaiting checks and human approval. APPROVED does not mean a market exists on-chain."],
  ["MarketSpec", "The exact UTF-8 bytes a human approved. specHash is the keccak256 of those bytes and is never recomputed from re-serialised data."],
  ["Market", "A deployment ID plus an on-chain market ID. Its mode is permanently LIVE or REPLAY."],
  ["Forecast window", "Market + horizon type + scheduled time. One forecast per agent per window; withdrawals stay on record."],
  ["Baseline", "An independent single-model forecast. It is never averaged into the two platform forecasters."],
  ["Quote", "A maker's EIP-712 offer to one named taker. Signing it is not a fill and reserves nothing on-chain."],
  ["Complete set", "One YES plus one NO share, fully collateralised by 1 bUSD. Shares are whole numbers."],
  ["Finality", "PRECONFIRMED, INCLUDED and FINALIZED are different states. Unknown is not failure."],
  ["INVALID", "YES and NO each pay 0.5 bUSD per share. It is not a refund of the purchase price."],
];

export default function DocsPage() {
  return (
    <>
      <span className="eyebrow">Docs</span>
      <h1 className={styles.title}>Building an agent for Blink</h1>
      <p className={`mono ${styles.notice}`}>The API is not publicly deployed yet · Contracts below describe planned behaviour</p>

      <section className={styles.block}>
        <h2>Concepts</h2>
        <dl className={styles.terms}>
          {terms.map(([term, def]) => (
            <div key={term} style={{ display: "contents" }}>
              <dt>{term}</dt>
              <dd>{def}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.block}>
        <h2>Connecting an agent</h2>
        <ol className={styles.steps}>
          <li>Request an invitation. Public reads are open; writes and test trades are invite-only.</li>
          <li>Prove wallet control: <code>POST /v1/auth/wallet-challenges</code>, sign the challenge, then <code>POST /v1/auth/wallet-verifications</code>.</li>
          <li>Read markets and their frozen specs: <code>GET /v1/markets</code>, <code>GET /v1/markets/{"{id}"}/spec</code>.</li>
          <li>Find open windows with <code>GET /v1/markets/{"{id}"}/forecast-windows</code> and submit with <code>POST /v1/markets/{"{id}"}/forecasts</code>. POST requests carry an <code>Idempotency-Key</code> header.</li>
        </ol>
        <pre className={styles.code}><code>{`curl <API_BASE_URL>/v1/markets`}</code></pre>
        <p className="prose">
          API keys never authorise withdrawals on behalf of external users. See the <Link href="/docs/api">API index</Link> for
          every planned operation and its intended access level.
        </p>
      </section>

      <section className={styles.block}>
        <h2>Current limits</h2>
        <ul className={styles.steps}>
          <li>No Base Sepolia deployment and no public API host yet.</li>
          <li>RFQ, the private signer and continuous indexing are not wired up; trading is disabled.</li>
          <li>Markets shown on this site are REPLAY samples with fictional companies.</li>
        </ul>
      </section>
    </>
  );
}
```

- [ ] **Step 7: Write `app/docs/api/page.tsx`**

```tsx
import { generateOpenApi } from "@blink/schemas";
import type { Metadata } from "next";
import { groupOperations, indexOpenApi } from "../../../content/openapi-index";
import styles from "../docs.module.css";

export const metadata: Metadata = { title: "API index" };

export default function ApiIndexPage() {
  const doc = generateOpenApi();
  const groups = groupOperations(indexOpenApi(doc));
  return (
    <>
      <span className="eyebrow">API index · v{doc.info.version}</span>
      <h1 className={styles.title}>Operations</h1>
      <p className={`mono ${styles.notice}`}>
        Generated from the shared schemas at build time · Shows default contract status, not a running service
      </p>
      {groups.map(({ group, operations }) => (
        <section key={group} className={styles.block}>
          <h2>{group}</h2>
          <div className={styles.tableWrap}>
            <table className={styles.ops}>
              <thead><tr><th>Method</th><th>Path</th><th>Planned access</th><th>Status</th></tr></thead>
              <tbody>
                {operations.map((op) => (
                  <tr key={`${op.method} ${op.path}`}>
                    <td className={styles.method}>{op.method}</td>
                    <td className={styles.path}>{op.path}</td>
                    <td>{op.access ?? "—"}</td>
                    <td className="mono">{op.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
```

If `doc.info.version` is not typed on the return value, read it as `(doc as { info?: { version?: string } }).info?.version ?? "0.1"`.

- [ ] **Step 8: Verify**

Run: `pnpm test` → all pass, including `web-openapi-index`.
Run: `pnpm --filter @blink/web typecheck` and `pnpm typecheck` → no errors in this task's files.

- [ ] **Step 9: Report** the files changed.

---

### Task 7: Home assembly, full verification, delivery docs, commit and push

**Files:**
- Modify: `apps/web/app/page.tsx` (replace placeholder)
- Create: `apps/web/app/page.module.css`, `docs/M4_WEB_SHOWCASE_DELIVERY.md`
- Modify: `docs/ROADMAP.md` (M4 row), `README.md` (Web row "currently a host scaffold" → read-only showcase)
- Possibly modify: `apps/web/components/home/Hero.tsx` coordinates and illustration files, for visual fixes found in Step 5

**Interfaces:**
- Consumes: `Hero`; `MarketLedger`, `sampleMarkets`; `TrailSvg`; `data-reveal`.

- [ ] **Step 1: Write `app/page.tsx`**

```tsx
import Link from "next/link";
import { Hero } from "../components/home/Hero";
import { TrailSvg } from "../components/illustrations/Trail";
import { MarketLedger } from "../components/MarketLedger";
import { sampleMarkets } from "../content/sample-markets";
import styles from "./page.module.css";

const pillars = [
  { title: "Off-chain research", body: "The API takes requests, workers run research and jobs, PostgreSQL keeps records, and object storage keeps original evidence bytes." },
  { title: "On-chain outcomes", body: "BlinkMarket validates quotes, keeps every position fully collateralised, and enforces settlement and redemption. Users keep their own wallets." },
  { title: "Separate signing", body: "A private signer checks its own policy before signing. An indexer turns chain events into projections that can be rebuilt." },
];

const loop = ["Define", "Forecast", "Quote", "Resolve", "Evaluate"];

const milestones: [string, string, string][] = [
  ["M0", "Engineering & contracts", "Built · verified locally"],
  ["M1", "Ledger & settlement", "Built · verified locally"],
  ["M2", "Core vertical flow", "In progress"],
  ["M3", "Agents", "Planned"],
  ["M4", "Product interface", "Read-only showcase in progress"],
  ["M5", "Sepolia alpha", "Planned"],
];

export default function Home() {
  return (
    <>
      <Hero />

      <section className="container section">
        <span className="eyebrow">What Blink is</span>
        <h2 className={styles.narrow}>Research off-chain. Money and outcomes on-chain.</h2>
        <div className={styles.pillars}>
          {pillars.map((p) => (
            <div key={p.title} className={styles.pillar} data-reveal="">
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container section">
        <div className={styles.headRow}>
          <div>
            <span className="eyebrow">Trending</span>
            <h2>Markets in motion</h2>
          </div>
          <p className="mono">Sample data · REPLAY only</p>
        </div>
        <MarketLedger markets={sampleMarkets.slice(0, 4)} />
        <p className={styles.more}><Link href="/markets">All sample markets →</Link></p>
      </section>

      <section className={`container section ${styles.loopSection}`}>
        <span className="eyebrow">The loop</span>
        <h2>Five steps, one trail</h2>
        <div className={styles.loop}>
          <TrailSvg viewBox="0 0 1000 80" d="M10 40 C 120 0, 200 80, 300 40 S 480 0, 560 40 S 760 80, 820 40 S 940 10, 990 40" className={styles.loopTrail} />
          <ol className={styles.steps}>
            {loop.map((s, i) => (
              <li key={s} data-reveal=""><span className="mono">0{i + 1}</span>{s}</li>
            ))}
          </ol>
        </div>
        <p className={styles.more}><Link href="/how-it-works">How it works →</Link></p>
      </section>

      <section className="container section">
        <span className="eyebrow">For agents</span>
        <h2 className={styles.narrow}>Read the questions. Submit forecasts. Keep the receipts.</h2>
        <pre className={styles.code} data-reveal=""><code>{`curl <API_BASE_URL>/v1/markets
curl <API_BASE_URL>/v1/markets/{id}/forecast-windows`}</code></pre>
        <p className={styles.more}><Link href="/docs">Read the docs →</Link></p>
      </section>

      <section className="container section">
        <span className="eyebrow">Where it stands</span>
        <ol className={styles.milestones}>
          {milestones.map(([id, name, status]) => (
            <li key={id} data-reveal="">
              <span className="mono">{id}</span>
              <span>{name}</span>
              <span className="mono">{status}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
```

`app/page.module.css`:

```css
.narrow { max-width: 18ch; }
.pillars { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 clamp(24px, 4vw, 56px); margin-top: clamp(40px, 6vw, 72px); border-top: 2px solid var(--ink); }
.pillar { display: grid; gap: 12px; padding-top: 24px; }
.pillar p { color: var(--ink-soft); }
.headRow { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 32px; }
.headRow .mono { color: var(--terracotta); }
.more { margin-top: 28px; font-family: var(--font-mono); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
.loop { position: relative; margin-top: clamp(40px, 6vw, 72px); }
.loopTrail { display: block; width: 100%; height: auto; }
.steps { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; }
.steps li { display: grid; gap: 6px; font-size: clamp(20px, 2.4vw, 32px); font-weight: 700; letter-spacing: -0.03em; }
.steps .mono { color: var(--cobalt); font-weight: 400; }
.code { margin-top: 32px; padding: 20px 24px; border-left: 3px solid var(--cobalt); }
.milestones { list-style: none; margin: 24px 0 0; padding: 0; border-top: 2px solid var(--ink); }
.milestones li { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 16px; align-items: baseline; padding-block: 16px; border-bottom: 1px solid var(--rule); font-size: clamp(18px, 1.8vw, 22px); }
.milestones li .mono:last-child { color: var(--cobalt); text-align: right; }
@media (max-width: 760px) {
  .pillars { grid-template-columns: 1fr; }
  .steps { grid-template-columns: 1fr 1fr; }
  .milestones li { grid-template-columns: 48px 1fr; }
  .milestones li .mono:last-child { grid-column: 2; text-align: left; }
}
```

- [ ] **Step 2: Typecheck, test, build**

Run: `pnpm check` → passes.
Run: `pnpm build` → succeeds; routes `/`, `/markets`, `/how-it-works`, `/docs`, `/docs/api` are listed as static.

- [ ] **Step 3: Static motion-safety check**

Run: `grep -rn "opacity: 0\|stroke-dashoffset: 1\|translateY(105%)" apps/web/app apps/web/components --include=*.css`
Expected: every hit is inside `@keyframes` or inside an `@media (prefers-reduced-motion: no-preference)` block (confirm by reading each file). Fix any that are not.

- [ ] **Step 4: Run the dev server**

Run (background): `pnpm --filter @blink/web dev`
Expected: listening on `http://127.0.0.1:3000`.

- [ ] **Step 5: Visual verification** (use the `claude-in-chrome` skill)

For each route at 1440×900 and 375×812:
- Screenshot the top of the page and after scrolling.
- Run `document.documentElement.scrollWidth <= window.innerWidth` in the console. It must be `true`.
- On `/`, screenshot at about 0.5s, 2.5s and 5s after load to confirm the word rise, the block → underline morph, and the measured trail leaving the underline, routing around the copy block and passing every node centre. Resize between 1440px and 375px and confirm it re-measures. If the start point is off, adjust the `0.04em` / `0.16em` offsets in `HeroTrail.tsx`. If the composition feels cramped, adjust node `x`/`y`/`mx`/`my` in `Hero.tsx`.
- Review each illustration against the Task 3 rules. Send any that break them back to the illustration implementer or fix them directly.

Stop the dev server when done.

- [ ] **Step 6: Delivery docs**

Create `docs/M4_WEB_SHOWCASE_DELIVERY.md` with:
- the scope (five read-only routes, no trading, REPLAY samples with fictional companies);
- the visual system summary;
- the files;
- the commands run with their results (test counts, build route list);
- the screenshots checked;
- limitations: static sample data, API index shows default contract status, no market detail or trading pages, M4 not complete.

Update `docs/ROADMAP.md` M4 row to: `進行中：唯讀展示站` with the delivery link. In `README.md` Technology table, change the Web row note "currently a host scaffold, not a product UI" to "read-only showcase site; no trading UI yet".

- [ ] **Step 7: Commit and push** (per AGENTS.md stage checkpoints)

```bash
git add apps/web docs/M4_WEB_SHOWCASE_DELIVERY.md docs/ROADMAP.md README.md tests/web-sample-markets.test.ts tests/web-openapi-index.test.ts tests/web-trail-geometry.test.ts
git status --short   # confirm no .next, tsbuildinfo, or unrelated files
git commit -m "feat(web): add illustrated read-only showcase site"
git push origin main
```

Report the commit hash and push result.
