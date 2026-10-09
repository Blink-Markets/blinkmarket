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

Out of scope: trading, wallets, approvals, positions, market detail pages, live API data. Sample markets use fictional companies and are labelled "Sample data · REPLAY only". Site banner: Base Sepolia testnet, test assets have no value, no trading.

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
- No market detail, trading, wallet or positions pages; M4 (product interface) is not complete.
- Only Chromium was exercised. Real Safari and Firefox behaviour is unverified; Firefox lacks scroll-driven animations and uses the IntersectionObserver fallback, which was not exercised. No real-device testing.
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

- Only Chromium was exercised; no Safari, Firefox or real-device testing. The `::details-content` desktop nav rule depends on browser support; browsers without it rely on a small script to open the nav, so with JavaScript disabled they may show a closed menu on desktop.
- Page facts are written by hand and checked against the repository; they are not generated, so they can drift from the code.
- Status words are static (`Identity mode`, `Preparation mode`, `Approval mode`, `Planned`); there is no live per-mode endpoint status.
- There is no public API or docs host; all commands and prompts use `http://127.0.0.1:3000` and `http://127.0.0.1:3001`.

### Open items (not done yet; carry forward)

From the docs-system plan's scope (spec §6.1): site search; syntax highlighting; Open in Claude/ChatGPT; localisation; live per-mode endpoint status; dark mode on marketing pages (needs token-coloured illustrations).

Carried from the 2026-10-08 showcase (spec §6.2): real Safari, Firefox and device testing (including the IntersectionObserver fallback and the `/how-it-works` spine under the fallback); the overflow check method (`overflow-x: clip` masks `scrollWidth`, so use element rects; Task 7 does); deduplicating `.code`, table header and `.title` styles; the unused `.visually-hidden` class (could label the ledger's Forecast column); the Architecture `aria-label` is too long (use a short label plus `<desc>`); Architecture bottom whitespace; whether to keep the Evaluation histogram; no skip link; README/ROADMAP table padding; user confirmation still pending on disclaimer colour (ink plus terracotta marker) and on per-model commit trailers; the rest of M4 (market detail, trading, positions, resolution, admin pages, live API data).

Resolved by the docs-system plan: the SiteHeader eye's hard-coded hex (now `currentColor`). The `.visually-hidden` class is now also used by the docs copy-feedback live regions.
