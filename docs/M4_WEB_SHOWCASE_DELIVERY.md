# M4 — Read-only web showcase

This slice adds a **read-only, illustrated showcase site** in `apps/web` (Next.js 16 App Router, statically prerendered). It explains Blink and shows sample markets. It has no wallet, no trading, no positions and no live API calls. It is a slice of M4, not the whole milestone.

中文摘要：`apps/web` 現在是唯讀展示站（首頁、市場、運作方式）加上文件系統（12 個 Markdown 頁面，見下方「Docs system」）。市場資料為 REPLAY 範例（虛構公司），不連錢包、不交易、不呼叫即時 API。M4 尚未完成。

Design references: [spec](superpowers/specs/2026-10-08-web-showcase-design.md), [plan](superpowers/plans/2026-10-08-web-showcase.md), [approved mockup](superpowers/specs/assets/2026-10-08-web-showcase-mockup.html).

## Scope

| Route | Content |
| --- | --- |
| `/` | Hero, aperture band, what Blink is, trending sample markets, the five-step loop, agent entry, milestone status |
| `/markets` | Ledger of sample markets (REPLAY only) |
| `/how-it-works` | Five chapters, architecture plate, worked example, out-of-scope list |
| `/docs/*` | Documentation system; see [Docs system](#docs-system) |

Out of scope: trading, wallets, approvals, positions, live API data. Read-only market detail pages are covered in [Market detail pages](#market-detail-pages). Sample markets use fictional companies and are labelled "Sample data · REPLAY only". Site banner: Base Sepolia testnet, test assets have no value, no trading.

## Visual system

- Two inks (cobalt and terracotta) on warm paper; halftone dot textures for illustrations.
- Motif is the eye and the blink: an eye wordmark that blinks, reveals that open like eyelids from a horizontal seam (`data-reveal`), and an Aperture band that opens on scroll.
- The hero trail is measured at runtime (`trail-geometry.ts`): it leaves the "trail" underline, routes around the copy block (on narrow screens down the right gutter) and passes every node centre. The headline block morphs into the underline.
- Scroll-driven CSS animations where supported; an IntersectionObserver fallback otherwise. All animation sits under `prefers-reduced-motion: no-preference`, so reduced-motion users see final states.

## Main files

- `apps/web/app/page.tsx`, `app/markets`, `app/how-it-works`, `app/docs`, `app/docs-md`, `app/llms.txt`
- `apps/web/components/home/` (Hero, Aperture, trail geometry), `components/illustrations/` (Trail, Architecture, chapter specimens), `components/MarketLedger.tsx`, `components/SiteHeader.tsx`
- `apps/web/content/sample-markets.ts`
- Tests: `tests/web-sample-markets.test.ts`, `tests/web-openapi-index.test.ts`, `tests/web-trail-geometry.test.ts`, `tests/web-docs-lib.test.ts`, `tests/web-docs-content.test.ts`

## Verification (HEAD bd209f6, clean worktree)

The shared working tree held unrelated uncommitted M2 creation-tracking work, so the controller verified in a clean worktree.

- `pnpm check`: exit 0; 51 tests pass, 0 fail; package boundaries and contract checks pass.
- `pnpm build`: static routes `/`, `/docs`, `/docs/api`, `/how-it-works`, `/markets` (plus `/_not-found`).
- Headless Chromium (CDP script, not in the repo) at 1440×900 and 375×812, with motion and with reduced motion:
  - no horizontal overflow on any of the five routes (scrollWidth equals innerWidth);
  - hero trail leaves the underline, 0 sampled points inside the copy block, every node centre passed within 1px at both widths;
  - hero block-to-underline morph, aperture opening on scroll, `/how-it-works` spine drawing progressively on scroll (stroke-dashoffset 0.76 → 0.06 → 0), and reduced-motion final states confirmed in screenshots.

## Limitations

- Sample data is static; nothing is read from the API or chain.
- No trading, wallet or positions pages (market detail is read-only, see below); M4 (product interface) is not complete.
- Originally only Chromium was exercised. Superseded by the cross-browser suite below (Firefox and WebKit now covered; real Safari and real devices still untested).
- The API index shows the default contract status from `@blink/schemas`, not a deployment.

## Docs system

Design: [spec](superpowers/specs/2026-10-09-docs-system-design.md), [plan](superpowers/plans/2026-10-09-docs-system.md). This replaces the earlier React `/docs` entry and `/docs/api` page.

### Scope

- 12 Markdown pages in `apps/web/content/docs/` (including the agent guide `agents.md`), rendered with `marked` pinned to 18.0.13 (the only new dependency): `/docs`, `/docs/quickstart`, `/docs/concepts`, `/docs/authentication`, `/docs/markets`, `/docs/forecasts`, `/docs/errors`, `/docs/lifecycle`, `/docs/architecture`, `/docs/api`, `/docs/status`, `/docs/agents`.
- The same pages as raw Markdown at `/docs/<slug>.md` (and `/docs.md`), served by `app/docs-md` through `next.config.ts` rewrites, plus `/llms.txt`.
- `/docs/api` expands a generated operation index from `@blink/schemas` (`## <group>` headings, default scaffold status, `always available` for `GET /v1/config`).
- Copy actions: copy page, copy as Markdown, copy prompt for agent (the agent guide uses a single-instruction prompt), and copy buttons on code and prompt blocks, with a polite "Copied" announcement and a select-the-text fallback when the clipboard is blocked.
- Docs-only light/dark theme toggle (stored as `blink-theme`); marketing pages stay light.
- Audience bar with the active side marked ("For agents" on `/docs/agents`, "For humans" elsewhere); mobile navigation is a closed `<details>` menu.

### Verification

- Clean-worktree `pnpm check` at 2924e5e: exit 0; 65 tests pass. `pnpm build` succeeds.
- `next start` route checks: each `.md` route is byte-equal to its source file; `/llms.txt` lists every page.
- Headless Chromium (CDP script, not in the repo): screenshots of `/docs/quickstart`, `/docs/agents` and `/docs/api` in light and dark at 1440 and 375 wide (dark at 2924e5e; light, API index TOC, active audience switch and closed mobile menu re-shot after the final fix wave at 2466208), plus DOM checks for overflow, docs-only dark scope and clipboard payloads.
- Clipboard payload checks with a stubbed `navigator.clipboard` (page Markdown, prompt text, code and prompt blocks).
- Final-review fix wave: `node --import tsx --test tests/web-docs-lib.test.ts tests/web-docs-content.test.ts tests/web-openapi-index.test.ts` and `pnpm --filter @blink/web typecheck` pass on the working tree; the full clean-worktree `pnpm check` and `pnpm build` were not re-run after the fix wave.

### Limitations

- Superseded by the cross-browser suite below for Firefox and WebKit; real Safari and real devices remain untested. The `::details-content` desktop nav rule depends on browser support; browsers without it rely on a small script to open the nav, so with JavaScript disabled they may show a closed menu on desktop.
- Page facts are written by hand and checked against the repository; they are not generated, so they can drift from the code.
- Status words are static (`Identity mode`, `Preparation mode`, `Approval mode`, `Planned`); there is no live per-mode endpoint status.
- There is no public API or docs host; all commands and prompts use `http://127.0.0.1:3000` and `http://127.0.0.1:3001`.

### Syntax highlighting and cross-browser suite (2026-10-09)

- **Syntax highlighting:** docs code fences (shell, json, ts/js, http) are highlighted at build time with Shiki 4.4.3 (`apps/web/lib/docs/highlight.ts`), using a CSS-variables theme mapped to Blink tokens (cobalt for keywords and commands, lighter cobalt for strings and constants, faint ink italic for comments). No client JavaScript is added, dark mode follows the tokens, and copied text is unchanged. `text` and `prompt` fences stay plain.
- **Cross-browser suite:** `pnpm test:browsers` (Playwright 1.63.0, `tests/browser/`) builds the site, runs `next start` on 127.0.0.1:3200 and checks Chromium, Firefox and WebKit at 1440×900 and 375×812: seven routes (200, no console or page errors, no horizontal overflow by element rects), hero trail measurement and reduced-motion final frame, no reveal left hidden after scrolling, the `/how-it-works` spine fully drawn, docs copy payloads, docs-only dark theme, and the mobile/desktop docs nav.
- **Result on the merged code (clean worktree):** 87 passed, 9 skipped by design (features absent at that viewport), 0 failed. Firefox used the IntersectionObserver reveal fallback and still drew the spine fully; Chromium and WebKit used scroll-driven animations. `pnpm check`: 80 tests pass.

### Engraved landscape footer (2026-10-09)

- **What:** a full-bleed cobalt footer on every page (marketing and docs) with brand, Explore / Developers / Project link columns and the testnet/status line, above an engraved landscape where the hero's terracotta trail winds to an eye-shaped sun on the horizon. Approved reference: `docs/superpowers/specs/assets/2026-10-09-footer-mockup.html`.
- **How:** `apps/web/lib/landscape.ts` generates the engraving deterministically (seeded). The static part is served once as `/footer-landscape.svg` (force-static route, about 94 KB raw / 25 KB gzip, cached), and only the animated trail, walker and eye are inline. Per-page HTML grows by about 12 KB. Footer colours use fixed `--footer-*` tokens, so the docs dark theme does not recolour it. Motion (trail draw, rays and walker fade, one blink then an idle blink every 7 s) runs only with `prefers-reduced-motion: no-preference`; without scroll-timeline support or JavaScript the footer renders complete and static.
- **Star field (2026-10-09):** `lib/landscape.ts` adds up to 260 sky dots and up to 14 four-point sparkles to the cached `/footer-landscape.svg` (about 104 KB raw / 27 KB gzip), plus a faint upper field (140 dots, 6 sparkles) in a second cached file `/footer-stars.svg` (about 10 KB / 1.6 KB gzip) used as the footer's CSS background; only the twinkling sparkles are inline (home HTML 61,148 B to 66,388 B) and twinkle only under `prefers-reduced-motion: no-preference`.
- **Verification:** unit tests for the generator; the Playwright suite (now 99 passed, 9 skipped across Chromium, Firefox and WebKit) checks the footer image loads, the overlay is present and the footer stays cobalt in docs dark mode; screenshots at 1440 and 375 match the mockup.

### Docs diagrams (2026-10-10)

- **What:** five hand-drawn explainers in the README architecture-sketch style: the existing architecture sketch (PNG, `/docs-assets/architecture-sketch.png`, 1536 px, about 1.4 MB, copied unchanged) on `architecture`, and generated SVG sketches for `lifecycle`, `markets` (question pipeline), `authentication` (agent flow, also referenced from `agents` section 5.2) and `concepts` (collateral and payouts). Approved reference: `docs/superpowers/specs/assets/2026-10-10-docs-sketches-mockup.html`.
- **How:** `apps/web/lib/docs/sketches.ts` is a pure seeded generator (`renderSketch`). `render.ts` inlines the SVG in a `figure.docs-sketch` with a focusable, horizontally scrolling sheet (min width 640 px, stays white in docs dark mode); other images render as lazy `<img>`. The same SVGs are served as `/docs-assets/<name>.svg` (force-static, cached). Kalam (400, 700) loads through `next/font/google` as `--font-hand` on the docs layout only. Alt text carries the full description for agents reading the raw `.md`.
- **Tests:** generator, renderer and content tests (every `/docs-assets/*` reference exists); browser specs for the inline SVG, PNG load, the SVG route and no horizontal overflow on `/docs/lifecycle` and `/docs/architecture`.
- **Limits:** diagram labels are drawn in code and must be updated by hand when the docs change; the PNG is not optimised further (no lossless optimiser installed).

## Market detail pages

Mockup: [2026-10-10-market-detail-mockup.html](superpowers/specs/assets/2026-10-10-market-detail-mockup.html) (approved by the user).

- `/markets/<id>` for the six sample markets (`generateStaticParams`, `dynamicParams = false`, unknown ids 404). Read-only; no trading UI. Every `/markets` row question links to its page.
- Sections: breadcrumb, REPLAY tag and sample notice, question, fact row, lifecycle strip (DISPUTED and INVALID-by-timeout variants), forecast history chart, how it resolves, evidence, research cost, frozen spec JSON.
- Chart (`components/markets/ForecastChart.tsx`): server-rendered SVG with `role="img"` and a generated label; client-side hover crosshair and tooltip, and a "Show table" toggle with a real table. The y-axis is floor(min-5) to ceil(max+5) in 10-point steps, so sample-01 shows 40-70%, not the mockup's 40-80%.
- Data: `content/sample-markets.ts` gains deadlines, daily windows, evidence and cost per market, plus pure helpers. All invented values are labelled sample. Tests in `tests/web-sample-markets.test.ts` enforce the window/forecast, deadline and state constraints.
- Browser: both new routes are in the route matrix; `tests/browser/market-detail.spec.ts` covers the row link, hover tooltip (desktop only), table toggle and the 404.
- Limits: the table toggle and tooltip need JavaScript; sample-02 to sample-06 window values are invented; evidence digests are placeholders.

### Open items (not done yet; carry forward)

From the docs-system plan's scope (spec §6.1): site search (deferred by the user on 2026-10-09); Open in Claude/ChatGPT; localisation; live per-mode endpoint status; dark mode on marketing pages (needs token-coloured illustrations).

Footer: palette hex values are duplicated in `lib/landscape.ts`, `SiteFooter.tsx` and the CSS tokens; footer column headings are `h2`s in the page outline; generator tests do not cover the sky clip or rays; docs pages have a larger gap above the footer than marketing pages. New from the 2026-10-09 additions: real Safari (only the WebKit engine is tested) and real devices; mobile projects emulate viewport width only, not touch; highlighted tokens use inline `style` attributes, which a future strict CSP without `style-src 'unsafe-inline'` would block; `escapeHtml` is duplicated in `render.ts` and `highlight.ts`; the theme browser test asserts a background change rather than a specific dark value.

Carried from the 2026-10-08 showcase (spec §6.2): the overflow check method (`overflow-x: clip` masks `scrollWidth`, so use element rects; Task 7 does); deduplicating `.code`, table header and `.title` styles; the unused `.visually-hidden` class (could label the ledger's Forecast column); the Architecture `aria-label` is too long (use a short label plus `<desc>`); Architecture bottom whitespace; whether to keep the Evaluation histogram; no skip link; README/ROADMAP table padding; the rest of M4 (trading, positions, resolution, admin pages, live API data).

Resolved on 2026-10-10: `pnpm test:browsers` runs in CI as a separate `browsers` job (browsers cached, one retry in CI only, Playwright report uploaded on failure); the user kept the disclaimer style (ink text with a terracotta marker) and said per-model commit trailers do not matter.

Resolved by the docs-system plan: the SiteHeader eye's hard-coded hex (now `currentColor`). The `.visually-hidden` class is now also used by the docs copy-feedback live regions.
