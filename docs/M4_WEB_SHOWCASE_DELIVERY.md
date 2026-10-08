# M4 — Read-only web showcase

This slice adds a **read-only, illustrated showcase site** in `apps/web` (Next.js 16 App Router, statically prerendered). It explains Blink and shows sample markets. It has no wallet, no trading, no positions and no live API calls. It is a slice of M4, not the whole milestone.

中文摘要：`apps/web` 現在是五個唯讀頁面的展示站（首頁、市場、運作方式、文件、API 索引）。市場資料為 REPLAY 範例（虛構公司），不連錢包、不交易、不呼叫即時 API。M4 尚未完成。

Design references: [spec](superpowers/specs/2026-10-08-web-showcase-design.md), [plan](superpowers/plans/2026-10-08-web-showcase.md), [approved mockup](superpowers/specs/assets/2026-10-08-web-showcase-mockup.html).

## Scope

| Route | Content |
| --- | --- |
| `/` | Hero, aperture band, what Blink is, trending sample markets, the five-step loop, agent entry, milestone status |
| `/markets` | Ledger of sample markets (REPLAY only) |
| `/how-it-works` | Five chapters, architecture plate, worked example, out-of-scope list |
| `/docs` | Documentation entry |
| `/docs/api` | OpenAPI index generated from `@blink/schemas` with its default contract status |

Out of scope: trading, wallets, approvals, positions, market detail pages, live API data. Sample markets use fictional companies and are labelled "Sample data · REPLAY only". Site banner: Base Sepolia testnet, test assets have no value, no trading.

## Visual system

- Two inks (cobalt and terracotta) on warm paper; halftone dot textures for illustrations.
- Motif is the eye and the blink: an eye wordmark that blinks, reveals that open like eyelids from a horizontal seam (`data-reveal`), and an Aperture band that opens on scroll.
- The hero trail is measured at runtime (`trail-geometry.ts`): it leaves the "trail" underline, routes around the copy block (on narrow screens down the right gutter) and passes every node centre. The headline block morphs into the underline.
- Scroll-driven CSS animations where supported; an IntersectionObserver fallback otherwise. All animation sits under `prefers-reduced-motion: no-preference`, so reduced-motion users see final states.

## Main files

- `apps/web/app/page.tsx`, `app/markets`, `app/how-it-works`, `app/docs`, `app/docs/api`
- `apps/web/components/home/` (Hero, Aperture, trail geometry), `components/illustrations/` (Trail, Architecture, chapter specimens), `components/MarketLedger.tsx`, `components/SiteHeader.tsx`
- `apps/web/content/sample-markets.ts`
- Tests: `tests/web-sample-markets.test.ts`, `tests/web-openapi-index.test.ts`, `tests/web-trail-geometry.test.ts`

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
