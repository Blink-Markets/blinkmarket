# Web showcase site design (M4 precursor: read-only introduction site)

_Status: completed — implemented on 2026-10-09 (f3ac5a5, 57e7a7e; delivery record docs/M4_WEB_SHOWCASE_DELIVERY.md); the visual system was later extended by the docs system and the market detail pages. Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

> Date: 2026-10-08
> Scope: the read-only showcase pages of `apps/web`. This site **offers no trading, wallet or write operations**.
> Status: design approved; implementation plan still to be written.

## 1. Goals and limits

Blink's main users are agents, not human traders. The website lets visitors, reviewers and agent developers understand the product, its design and how to connect, and browse example "trending markets".

- Pages: `/`, `/markets`, `/how-it-works`, `/docs`, `/docs/api`. No market detail, trading, positions or admin pages.
- Language: English.
- Market data: static examples, all `mode: "REPLAY"`, fictional companies, the GM_LT_V1 question type, labelled `SAMPLE · REPLAY`. No API connection and no real company data.
- A permanent testnet notice on every page; the site must not suggest that Sepolia is deployed or that trading is open (spec §2.2, §13).
- No new npm dependencies. No Tailwind. Styles use CSS Modules + `globals.css` tokens.
- Light mode only.

Success criteria:

1. All five routes build with `pnpm build` and render mainly as Server Components.
2. The home page hero's word-by-word mask animation and the trail reveal work; with `prefers-reduced-motion: reduce` the final screen is shown directly.
3. Scroll reveal uses CSS in browsers that support `animation-timeline: view()` and falls back to IntersectionObserver elsewhere; content stays visible when JS fails.
4. No horizontal scroll at 375px width; desktop and phone screenshots pass visual inspection.
5. `pnpm check` and `pnpm build` pass.

## 2. Visual system (rules taken from the mono-color skill)

Only the rules are borrowed. No image from the skill's `examples/` is copied (its license forbids commercial use).

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `#FAFAF7` | Site background (Neutral White substrate) |
| `--cobalt` | `#2148B8` | Primary ink: illustration subjects, halftone dots, thin lines, links, data bars |
| `--terracotta` | `#C65F38` | Accent ink: used only for the "trail": the hero emphasis word, the hand-drawn path, probability markers |
| `--ink` | `#242321` | Body text and labels (a deliberate departure from the two-colour limit for readability; illustrations and graphics still keep strictly to two colours) |
| `--rule` | `#24232133` | Thin divider lines (a density variation of ink, not a new colour) |

Rules:

- Illustrations may use only cobalt, terracotta and the paper colour. Light and dark are shown through halftone density and opacity. No gradients, shadows, neon or 3D.
- Each illustration has one subject object (45-80% of the frame), and at least one place where the paper colour cuts into the subject (knockout / halftone fade).
- The only hand-drawn mark family is the terracotta hand-drawn path (a slightly wobbly path). No other doodle style is used anywhere else.
- No card grids. Information is laid out as a "grid information table" (thin line dividers, tabular numerals).
- Generous white space: every block keeps a lot of empty space, and the main elements align to an invisible left edge or a 2-3 column grid. Each block has only one element that deliberately breaks the alignment.
- Fonts: Geist (display: bold, tight letter-spacing; body) + Geist Mono (labels, numbers, status), loaded through `next/font`. Display to microcopy is about 10:1.
- Copy tone: concise, observational, factually clear. No sales language, hype or CTA-button style copy (links appear as text links).

## 2.1 Blink visual motif (approved on 2026-10-09 from the mockup page)

Approved visual baseline: `docs/superpowers/specs/assets/2026-10-08-web-showcase-mockup.html` (version 2).

- Meaning of the name: blink = a moment, a snapshot. It maps to the evidence snapshot, the timestamped forecast window and the frozen spec hash.
- Eye wordmark: an almond-shaped cobalt eye + a solid iris + a small terracotta highlight, placed before the word "Blink"; it blinks about every 6 seconds (scaleY 1 → 0.08 → 1).
- Unified entrance language, "eye opening": every reveal (`data-reveal`, hero nodes) opens up and down from the horizontal midline with `clip-path: inset(50% 0 50% 0)`, instead of a fade-in slide-up.
- Opening eye: the hero first shows a terracotta eye-slit line, then opens from that line with an elliptical clip-path, and only then do the words rise one by one.
- Aperture block: a full-width cobalt block after the hero. On entering the viewport, a terracotta slit line is seen first, and the block opens from the slit with an `ellipse()` clip-path as the page scrolls; the halftone iris on the right scales and rotates slightly with scrolling. Copy:`A blink is a snapshot` / `Every forecast records what an agent knew, and when.` / `Evidence is kept as original bytes. Forecasts land inside fixed, timestamped windows. Specs are frozen by hash, and withdrawn forecasts stay on the record.`
- The paper-colour dots inside the aperture block (`ht-paper-30`, `ht-paper-60`) are paper-colour knockouts, not a new ink.
- All motion is enabled only under `prefers-reduced-motion: no-preference`; otherwise the final opened state is shown.

## 3. Animation

No packages are added: CSS scroll-driven animations, IntersectionObserver, the Web Animations API.

### 3.1 Hero (`components/home/Hero.tsx` Server Component + `HeroTrail.tsx` client measurement)

1. Text: `every forecast` / `leaves a trail`, with `trail` in terracotta.
2. Each word is wrapped in an `overflow: clip` mask and rises from below; the interval is about 220ms, the easing is `cubic-bezier(.2,.7,.1,1)`, with no bounce.
3. After everything has appeared, pause for about 600ms; the `trail` text fades out and collapses into a terracotta block of the same size.
4. The block narrows in height into a line, which continues as a hand-drawn trail path (drawn with `stroke-dashoffset`), linking the four halftone node illustrations in order: evidence paper (evidence), forecast dial (forecast), quote stub (quote) and resolution stamp (resolution).
5. reduced-motion: render the final state directly (the text, with the `trail` text kept, and the full path and nodes).
6. The text animation is CSS keyframes inside `@media (prefers-reduced-motion: no-preference)`, and the static style is the final screen. The trail path is generated by `HeroTrail` (client) at runtime after measuring the underline, the copy block and the node centres (the pure function `trail-geometry.ts`). It is guaranteed to start from the underline, avoid the copy and pass through every node; it is recomputed on resize and after fonts load. Without JS the path is not shown and everything else is complete.

### 3.2 Scroll reveal (`components/motion/Reveal`)

- The default style is visible. Where `animation-timeline: view()` is supported, CSS handles the opacity/translate entrance.
- Where it is not supported, a small client component adds the `is-visible` class with IntersectionObserver.
- The trail path is drawn with scrolling in the `/` flow preview and in `/how-it-works` (a view timeline drives `stroke-dashoffset`; in the fallback it is drawn in full once on entry).
- All of it is disabled under reduced-motion.

## 4. Page content

### 4.1 Shared

- `SiteHeader`: the `Blink` wordmark, Markets, How it works, Docs, GitHub (`https://github.com/Blink-Markets/blinkmarket`).
- `TestnetStrip` (small permanent mono text): `BASE SEPOLIA TESTNET · TEST ASSETS HAVE NO VALUE · NO TRADING ON THIS SITE`.
- `SiteFooter`: a one-sentence project status + a repo link.

### 4.2 `/`

1. Hero (§3.1) + a one-sentence product description + a mono status line (for example `M0–M2 built locally · no public deployment`).
2. What Blink is: three paragraphs: off-chain research & coordination, on-chain funds & outcomes, separate signing & sync (rewritten from the README architecture section).
3. Trending markets: take 4 examples (§5), shown as a grid information table, linking to `/markets`.
4. The loop: a preview of the five steps Define → Forecast → Quote → Resolve → Evaluate, with the trail drawn on scroll, linking to `/how-it-works`.
5. For agents: a `GET /v1/markets` curl example (the host uses the `<API_BASE_URL>` placeholder, with no invented domain) + a link to `/docs`.
6. Where it stands: list the M0–M5 status from `docs/ROADMAP.md`.

### 4.3 `/markets`

- The page header states `Sample data · REPLAY only · not live markets`.
- About 6 examples. Columns (spec §13.1): question, mode (LIVE/REPLAY label), forecast probability (cobalt data bar + terracotta marker), updated, outcome status.
- No filtering or sorting (YAGNI).

### 4.4 `/how-it-works`

1. A five-chapter scroll narrative (Define / Forecast / Quote / Resolve / Evaluate), each chapter with one SVG illustration + 2-4 sentences, with content taken from the README "How It Works" and the spec.
2. Architecture & trust boundaries: the division of responsibility between off-chain research, on-chain funds, the private signer and the indexer (SVG diagram).
3. Worked example: buy 100 YES @ 6,000 bps → taker 60 bUSD + maker 40 bUSD = 100 bUSD collateral; the three payouts YES / NO / INVALID (INVALID pays 0.5 bUSD per share).
4. Not in v0.1: a short list taken from spec §0.2.

### 4.5 `/docs`

- Concepts: rewritten in English from the `CONTEXT.md` glossary (Market, MarketSpec, Forecast window, Baseline, Quote, Complete set, Finality, INVALID).
- Connecting an agent: the steps for invite-only writes, wallet challenge authentication (`/v1/auth/wallet-challenges`, `/v1/auth/wallet-verifications`), getting questions and submitting forecasts.
- Current limits: the API is not deployed externally, there is no Sepolia deployment, and trading / RFQ / signer are not yet wired.

### 4.6 `/docs/api`

- At build time, call `generateOpenApi()` from `@blink/schemas` (`artifacts/openapi.json` is gitignored and does not exist in CI). Pure functions in `content/openapi-index.ts` extract method, path, `x-status` and `x-planned-access` and group by the first segment after `/v1/`. The web app needs a new workspace dependency on `@blink/schemas`.
- The page header states that what is shown is the default contract state, not a running service.

## 5. Sample market data (`content/sample-markets.ts`)

Type:

```ts
type SampleMarket = {
  id: string;            // "sample-01" …
  mode: "REPLAY";        // examples are always REPLAY
  entity: string;        // fictional company name
  fiscalPeriod: string;  // "FY2025Q3"; the question text is produced by marketQuestion() from GM_LT_V1
  thresholdBps: number;
  forecastBps: number;   // 0–10000, platform forecaster average (example value)
  updatedAt: string;     // YYYY-MM-DD
  state: "OPEN" | "CLOSED" | "PROPOSED" | "DISPUTED" | "FINAL"; // same as schemas effectiveState
  outcome: "YES" | "NO" | "INVALID" | null;                    // only FINAL has a value
};
```

Data principles: fictional companies, `example.com`-style sources, and no claim of any prior forecast record.

## 6. File structure

```
apps/web/
  app/layout.tsx, app/globals.css, app/page.tsx (+ page.module.css)
  app/markets/page.tsx, app/how-it-works/page.tsx, app/docs/page.tsx, app/docs/api/page.tsx
  components/SiteHeader.tsx, TestnetStrip.tsx, SiteFooter.tsx, MarketLedger.tsx
  components/home/Hero.tsx, HeroTrail.tsx (client), trail-geometry.ts, components/motion/Reveal.tsx (RevealObserver)
  components/illustrations/HalftoneDefs.tsx, Trail.tsx, Evidence.tsx, Forecast.tsx, Quote.tsx, Resolution.tsx, Evaluation.tsx, Architecture.tsx
  content/sample-markets.ts, content/openapi-index.ts
```

- Delete `apps/web/app/route.ts`: it occupies `/` and conflicts with the home page, and it is only a temporary JSON placeholder; nothing else in the repo references it.
- Before starting implementation, read the relevant guides in `apps/web/node_modules/next/dist/docs/` (Next 16 has breaking changes; see `apps/web/AGENTS.md`).

## 7. Testing and verification

- `tests/web-sample-markets.test.ts`, `tests/web-openapi-index.test.ts`, `tests/web-trail-geometry.test.ts` (node test runner, split into files to allow parallel implementation; the trail tests fix that the path passes through every point, is deterministic, and falls back to a fallback route on narrow screens):
  - Every sample market has `mode === "REPLAY"`, `forecastBps` within 0–10000, and a unique id.
  - The number of `openapi-index` entries produced from `generateOpenApi()` equals the number of paths × methods; a missing vendor extension shows `unspecified`.
- `pnpm check`, `pnpm build`.
- Start `pnpm --filter @blink/web dev`, and inspect desktop and 375px screenshots by eye; confirm the final state by simulating reduced-motion.

## 8. Execution

Implement in parallel with several subagents:

- T0 foundation (done first): tokens, layout, fonts, TestnetStrip, header/footer, Reveal, HalftoneDefs, delete `route.ts`.
- In parallel after T0: T1 hero animation; T2 illustration components; T3 `/markets` + sample data + tests; T4 `/how-it-works`; T5 `/docs` + `/docs/api` + OpenAPI index + tests.
- T1 and T4 use the T2 illustration components; the implementation plan must first fix the file name and props interface of each illustration component (for example `{ className?: string }`), so that parallel tasks depend only on the interface.
- Last: assemble the home page, integration verification, update the progress document, commit and push.
