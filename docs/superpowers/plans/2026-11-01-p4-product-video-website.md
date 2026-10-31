# P4 Rework: Product Video and Product-Showcase Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project-explainer video with an animated product introduction of about one minute, and turn the website into a product showcase: the video sits inline under the hero, the advantages continue the home page, and no page carries status labels, comparisons or progress language.

**Architecture:**
- Web: `apps/web/content/advantages.ts` shrinks to the eight implemented advantages with no status or comparison data. The home page renders them after "What Blink is". The `/advantages` route, its nav link, the Watch section and the transcript go. Shared test helpers (`tests/showcase-claims.ts`) ban platform names, status phrases and invitations on every showcase page and in the video script.
- Video: `video/src/script.ts` holds every on-screen string, the shot list in beats and the optional music track. `video/src/time.ts` maps beats to frames at the track's BPM, so a non-120 track rescales the whole cut. Scenes in `video/src/scenes/` port the approved animatic shot by shot with frame-driven motion. Sound effects are synthesised by `video/scripts/sfx.ts` into committed WAVs, and a cue sheet places them.
- Rendering runs only in the `node:22.23.1-bookworm-slim` container via `scripts/video-docker.sh`. The rendered MP4 (with audio) and poster are committed under `apps/web/public/video/`.

**Tech Stack:** Next 16.3.5 static export and React 19.3.0; Remotion 4.0.536 with `@remotion/google-fonts` 4.0.536; node:test with tsx; Playwright 1.63.0; Docker for renders.

**Spec:** `docs/superpowers/specs/2026-10-31-p4-product-video-website-design.md` (the design; it wins where the animatic differs), with its companion `docs/superpowers/specs/2026-10-31-intro-video-animatic.html`, and `docs/superpowers/specs/2026-10-23-autonomous-market-design.md` (U19–U24, §3, §9, §10).

**Prerequisite:** main at `7f6cd6f` or later with green CI. All work happens on branch `p4-product-rework` in a worktree.

## Global Constraints

- Truthfulness (spec §3): every claim matches what the code does.
- Showcase pages and the video script contain no other platform's name, no status label ("implemented", "under construction"), no deployment or local-verification statement, and no invitation to sign up, connect a wallet, trade, take a role or suggest a question (design §2, §5.3; spec U21, U24).
- The positioning lines in `apps/web/content/positioning.ts` stay unchanged and stay in the hero (U19). RFQ long-tail liquidity is the first advantage (U20). Smaller attack surface (no custody) is the second (U22).
- Video truth rules (design §4.2):
  - The market's headline number is the agent consensus of signed forecasts, not a price. Only forecasters move it; trades never do.
  - Traders only buy YES or buy NO. Nobody sells.
  - A market that has just gone live shows "—", not a probability.
  - No agent count, no uptime claim, no URL.
- Video format: 1920×1080, 30 fps, H.264 with AAC audio. At 120 BPM the cut is 117 beats = 58.5 s; at any track tempo from 115 to 125 BPM it stays within 55–62 s.
- MP4 target 8 MB, hard cap 15 MB. Keep 1080p at 30 fps. To meet the cap, tune the encoder first, then simplify the moving gradient layers.
- Remotion stays at 4.0.536 under the Free License. Every `@remotion/*` package uses the same version. Every new dependency is pinned to an exact version at least two weeks old.
- Remotion motion is frame-driven: every animated value is a function of `useCurrentFrame()`. No CSS `animation`, `transition` or `@keyframes` in `video/src`, because Remotion renders frames out of order.
- `video/src` imports only `remotion`, `@remotion/*`, `react` and its own files. Nothing under `apps/`, `packages/` or `examples/` imports from `video/`.
- `apps/web/AGENTS.md`: read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing Next code. Every root-relative `src` or `href` that Next does not rewrite goes through `withBase` (`apps/web/lib/base-path.ts`).
- Host limits: glibc 2.28. `pnpm build`, `pnpm build:pages`, `pnpm test:browsers` and every Remotion render run in branch CI or the container only. Local checks: `pnpm check`, `pnpm typecheck`, `pnpm check:boundaries` and `node --import tsx --test <files>`, with node 22 on PATH. A web task is verified only when its branch CI is green.
- Nothing merges to main before the user approves the final render (Task 8). Merging to main publishes the site through `.github/workflows/pages.yml`. No deployment, paid service or signing (`AGENTS.md`).
- English for code, comments, docs and commits. Commits are authored as `Brian Huang <66238110+BrianHuang813@users.noreply.github.com>` and end with the implementer's `Co-Authored-By` line.

## Review Focus

1. **A stale `/advantages` link or page.** The route was public for a day. It must return 404, and no exported page, `llms.txt` or footer may link to it. Tests: Task 1 adds a 404 browser check; `check-pages-export.mjs` already fails on an internal link that does not resolve.
2. **A 375 px phone.** The advantage blocks and the inline video must not push the home page sideways. Tests: the existing overflow check in `routes.spec.ts` covers `/`; Task 2 checks the video box fits the viewport.
3. **A visitor on metered data or with reduced motion.** The video must never autoplay or preload. Test: Task 2 asserts `preload="none"` and no `autoplay`, `muted` or `loop` attribute.
4. **A music track that is not 120 BPM.** Shot boundaries, cues and the music volume envelope must stay aligned, with the total within 55–62 s. Tests: Task 3 checks frames at 115 and 125 BPM; Task 7 checks every cue in base time.
5. **Committed sound files drifting from their recipes.** Someone edits a recipe and forgets to regenerate. Test: Task 7 regenerates every WAV in memory and compares it with the committed bytes.

---

## Pre-flight rulings (the controller records these in the ledger before Task 1)

- **Music shape with a single track.** Design §4.3 describes stems ("no drums" in shot 1, "a lighter groove" in shots 7–8). A licensed stereo track cannot drop its drums, so the shape is a volume envelope (Task 7). If wrong: the user asks for a track with stems, and Task 7's envelope becomes a stem mix.
- **"Deployment" in how-it-works' "Not in this version" list goes**, under design §5.2's rule that every deployment statement is removed. The other items there describe the product, not progress, and stay.
- **One branch, one merge.** Web and video land together after the user approves the final render, so the live site never shows the new layout with the old video.
- **Shot 4 follows the design, not the animatic** (user decision 2026-11-01): forecasters toss signed notes into the chart, and traders trade with the maker beside it.

---

### Task 1: The advantages continue the home page

**Files:**
- Modify: `apps/web/content/advantages.ts`
- Modify: `apps/web/app/page.tsx`, `apps/web/app/page.module.css`
- Delete: `apps/web/app/advantages/` (both files)
- Modify: `apps/web/components/SiteHeader.tsx` (drop the Advantages link)
- Modify: `apps/web/content/docs/trust.md`, `forecaster.md`, `concepts.md`, `roles.md`
- Modify: `scripts/check-pages-export.mjs` (drop `advantages/index.html` from `KEY_FILES`)
- Test: `tests/web-advantages.test.ts` (rewrite), `tests/web-claims.test.ts` (positioning test), `tests/browser/home.spec.ts`, `tests/browser/nav.spec.ts`, `tests/browser/routes.spec.ts`; delete `tests/browser/advantages.spec.ts`

**Interfaces:**
- Produces, in `apps/web/content/advantages.ts` (its only export):
  - `export type Advantage = { id: string; title: string; summary: string; points: readonly string[]; evidence: readonly string[]; docs: string };`
  - `export const advantages: readonly Advantage[];` with ids in this order: `rfq-long-tail`, `no-custody`, `agent-only`, `readable-reasoning`, `closed-loop`, `contamination`, `research-vs-price`, `agent-safety`.

**Content rules:**
- Keep each item's `title`, `evidence` and `docs` from today's file. Keep `summary` as one sentence.
- Keep at most two points per item, each one sentence of at most 200 characters. Drop any point that mentions another market (today's first RFQ point). Shorten `no-custody` to its two most important facts: collateral sits in contracts with no admin function, and each agent signs with its own wallet while the website only reads.
- `limits` leave the data. Each limit must be stated in its docs page. Most already are. Add these sentences, in the page's existing style:
  - `concepts.md`, "Trading and collateral": "**No quote, no price.** A question gets a price only when at least one registered maker chooses to quote it."
  - `trust.md`, "What else should I know?":
    - "**Each agent guards its own key.** A stolen key loses that agent's funds."
    - "**Check before signing.** An agent that skips the client's checks can be fed a bad quote or challenge by a compromised API."
    - "**No external audit.** The contracts have had no external audit."
  - `forecaster.md`:
    - In "Duties", add a bullet: "**Reasoning is optional.** The reference forecaster publishes no reasoning document because it uses a fixture model; a forecaster with its own model can attach one."
    - At the end of the "Contamination" bullet in "Credit", add: "Only proposal timing marks a window: an outcome that became public some other way before any proposal is not detected." This carries P4 final-review Minor 2.
  - `roles.md`, end of "How independent are the participants?": "A registration fee does not make an identity trusted either."

**Home page (between "What Blink is" and the sample markets):**
- One section replaces today's teaser: eyebrow "Why Blink", `h2` "Liquidity on request, and no custody".
- One `<article id={a.id}>` per advantage, in data order, with an `h3` title, the summary, the points as a list, and a link "Read more →" to `a.docs`.
- The first two items lead: larger and wider than the other six. At 375 px everything is one column.
- Use the page's existing tokens and `data-reveal`. Nothing on the home page renders `evidence`.

- [ ] **Step 1: Rewrite `tests/web-advantages.test.ts`**

Keep today's `the positioning lines are the approved copy` test unchanged. Replace the rest with:

```ts
import * as content from "../apps/web/content/advantages.ts";
const { advantages } = content;

test("the advantages are the eight implemented items, RFQ first and no custody second", () => {
  assert.deepEqual(Object.keys(content), ["advantages"]);
  assert.deepEqual(advantages.map((a) => a.id), ["rfq-long-tail", "no-custody", "agent-only", "readable-reasoning", "closed-loop", "contamination", "research-vs-price", "agent-safety"]);
  for (const a of advantages) assert.deepEqual(Object.keys(a).sort(), ["docs", "evidence", "id", "points", "summary", "title"], a.id);
});
test("every advantage is short enough for the home page", () => {
  for (const a of advantages) {
    assert.ok(a.summary.length > 0 && !/\.\s/.test(a.summary.trim().slice(0, -1)), `${a.id}: one-sentence summary`);
    assert.ok(a.points.length <= 2 && a.points.every((p) => p.length > 0 && p.length <= 200), a.id);
  }
});
test("every advantage names evidence that exists and a docs page that exists", () => {
  for (const a of advantages) {
    assert.ok(a.evidence.length > 0, a.id);
    for (const path of a.evidence) assert.ok(existsSync(path), `${a.id}: ${path}`);
    assert.match(a.docs, /^\/docs\/[a-z0-9-]+$/);
    assert.ok(existsSync(`apps/web/content${a.docs}.md`), a.id);
  }
});
test("every limit that left the home page is stated in its docs page", () => {
  const homes: [string, string][] = [
    ["the relay polls", "trust"], ["only when at least one registered maker chooses to quote it", "concepts"],
    ["A stolen key loses that agent's funds", "trust"], ["skips the client's checks", "trust"], ["no external audit", "trust"],
    ["honesty is the provably best strategy", "trust"], ["do not prove that different people control them", "roles"],
    ["A registration fee does not make an identity trusted", "roles"], ["fixture model", "forecaster"],
    ["anchored only if an agent anchors it", "forecaster"], ["can read sealed answers before the deadline", "forecaster"],
    ["is not detected", "forecaster"], ["It affects no rule about funds", "forecaster"],
  ];
  for (const [phrase, page] of homes) assert.ok(readFileSync(`apps/web/content/docs/${page}.md`, "utf8").includes(phrase), `${page}: ${phrase}`);
});
```

In `tests/web-claims.test.ts`, the positioning test checks `app/page.tsx` only, and is renamed "the home page states both positioning lines".

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --import tsx --test tests/web-advantages.test.ts tests/web-claims.test.ts`
Expected: FAIL. The first test fails on the extra exports, and the docs test fails on "is not detected".

- [ ] **Step 3: Rewrite `advantages.ts`, the home section and the docs sentences; delete `/advantages` and its nav link**

- [ ] **Step 4: Update the browser specs and `KEY_FILES`**

- Delete `tests/browser/advantages.spec.ts`.
- `routes.spec.ts`: drop `/advantages`.
- `nav.spec.ts`: the names are `["Markets", "How it works", "Docs"]`, and add `await expect(nav.getByRole("link", { name: "Advantages" })).toHaveCount(0);`.
- `home.spec.ts`: add this test:

```ts
test("the advantages continue the home page and /advantages is gone", async ({ page }) => {
  await page.goto("./");
  const section = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Liquidity on request, and no custody" }) });
  await expect(section.locator("article h3")).toHaveText(advantages.map((a) => a.title));
  for (const a of advantages) await expect(section.locator(`article#${a.id}`).getByRole("link", { name: "Read more →" })).toHaveAttribute("href", new RegExp(`${a.docs}/?$`));
  expect((await page.goto("./advantages"))?.status()).toBe(404);
});
```

It imports `advantages` from `../../apps/web/content/advantages.ts`.

- [ ] **Step 5: Run the local checks**

Run: `node --import tsx --test tests/web-advantages.test.ts tests/web-claims.test.ts && pnpm typecheck && pnpm check:boundaries`
Expected: PASS.

- [ ] **Step 6: Commit and push; wait for branch CI**

```bash
git add -A apps/web tests scripts/check-pages-export.mjs
git commit -m "feat(web): fold the advantages into the home page and drop the advantages page"
git push -u origin p4-product-rework
```

Expected: the CI jobs check and browsers are green, including `check-pages-export.mjs`.

---

### Task 2: The video in the page's flow, and no progress language

**Files:**
- Modify: `apps/web/components/home/IntroVideo.tsx`
- Delete: `apps/web/content/intro-video.ts`
- Modify the copy:
  - `apps/web/components/home/Hero.tsx:43`
  - `apps/web/components/SiteFooter.tsx:93`
  - `apps/web/app/page.tsx` (pillar body and For-agents heading)
  - `apps/web/app/how-it-works/page.tsx:51,66,88`
  - `apps/web/app/markets/page.tsx:16-17`
  - `apps/web/components/illustrations/Architecture.tsx:8` (title)
- Modify: `apps/web/content/sample-markets.ts` (`chartAriaLabel`)
- Create: `tests/showcase-claims.ts`
- Test: `tests/web-claims.test.ts`, `tests/web-intro-video.test.ts` (rewrite), `tests/web-sample-markets.test.ts`, `tests/browser/home.spec.ts`, `tests/browser/market-detail.spec.ts`

**Interfaces:**
- Produces, in `tests/showcase-claims.ts` (Task 3 also uses it):
  - `export const PLATFORM_NAMES: RegExp`, matching `\b(Polymarket|Kalshi|Limitless|Seer|Olas|UMA|Kleros|Manifold|Augur)\b` (case-sensitive).
  - `export const STATUS_PHRASES: RegExp`, matching `under construction|\bdeployed\b|\b(live|public) deployment\b|after deployment|verified locally|local verification|\bimplemented\b` (case-insensitive).
  - `export const INVITATIONS: RegExp`, matching `connect (your )?wallet|\bsign (up|in)\b|\bjoin (as|the)\b|suggest a question|start trading` (case-insensitive).
  - `export function assertShowcaseClean(text: string, label: string): void`, which asserts none of the three matches.
  - `export function showcaseSources(): string[]`, which returns repo-relative paths:
    - every `.ts`/`.tsx` under `apps/web/app` and `apps/web/components`, except `app/docs/**` and `components/docs/**`;
    - `apps/web/content/advantages.ts`, `positioning.ts` and `sample-markets.ts`.

    A comment in the file says why docs are out of scope: they are agent documentation and keep operational facts such as deployment state (design §5.3).

**Copy:**

| Where | Today | New |
| --- | --- | --- |
| Hero status | `Base Sepolia testnet · Nothing deployed · No trading here` | `Base Sepolia testnet · No trading here` |
| Footer line 93 | `Base Sepolia testnet · Nothing deployed · No trading on this site` | `No trading on this site` (line 92 already gives the testnet) |
| Pillar "Platform: infrastructure only" | `… and sign nothing. Nothing is deployed yet.` | drop the last sentence |
| For-agents `h2` | `… One-command drill. API not deployed.` | `Reference agents for every role. One-command drill.` |
| how-it-works lede | `… provides infrastructure. The current design has been verified locally only; nothing is deployed.` | `Agents take the market roles while the platform provides infrastructure.` |
| how-it-works `notInScope` | first item `"Deployment"` | removed |
| how-it-works caption | `Current architecture, not yet deployed · Local verification only · Read-only site` | `Read-only site` |
| markets intro | `No live markets exist yet: nothing is deployed, and no markets have been created. These REPLAY samples show how a market could read after deployment; these pages …` | `These REPLAY samples show how a market reads; these pages …` |
| Architecture title | `… into PostgreSQL. Not a live deployment.` | drop the last sentence |

**The video block:**
- `IntroVideo` renders `<div className="container">` holding only the `<video>`. It has no `section`, heading, paragraph, data line or `<details>`.
- Attributes: `controls`, `preload="none"`, `playsInline`, the poster through `withBase`, `width={1920} height={1080}`, `style={{ width: "100%", height: "auto" }}`, and `aria-label="Blink introduction, about one minute, with music: AI agents with different jobs run a prediction market, and people read the forecasts."`.
- `page.tsx` keeps it between `<Hero>` and `<Aperture>`.

**`chartAriaLabel`:** `Line chart of the probability of YES from ${first.date} to ${last.date}: consensus moves from ${first.consensus.toFixed(1)}% to ${last.consensus.toFixed(1)}%, with last fill shown.` This carries P4 final-review Minor 3.

- [ ] **Step 1: Write the failing tests**

Add these to `tests/web-claims.test.ts`:

```ts
test("no showcase page names another platform, shows a status or invites people in", () => {
  const files = showcaseSources();
  assert.ok(files.length > 30, "the scan must see the showcase sources");
  for (const file of files) assertShowcaseClean(readFileSync(file, "utf8"), file);
});
test("the website has no form controls", () => {
  for (const file of showcaseSources().filter((f) => f.startsWith("apps/web/app") || f.startsWith("apps/web/components")))
    assert.doesNotMatch(readFileSync(file, "utf8"), /<form\b|<input\b|<textarea\b|<select\b|onSubmit/, file);
});
```

The second test carries P4 final-review Important 3.

Rewrite `tests/web-intro-video.test.ts` to one test: the MP4 is at most 15 MB, and the poster exists and is non-empty.

In `tests/web-sample-markets.test.ts`, extend the `chartAriaLabel` test:

```ts
const s1 = findMarket("sample-01")!;
const label = chartAriaLabel(s1.windows);
assert.ok(label.includes(`${s1.windows[0]!.consensus.toFixed(1)}%`) && label.includes(`${s1.windows.at(-1)!.consensus.toFixed(1)}%`), label);
```

Replace the intro-video test in `tests/browser/home.spec.ts`:

```ts
test("the video sits inline under the hero: controls, poster, no autoplay, no transcript, fits a phone", async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("./");
  const video = page.locator("video");
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute("aria-label", /^Blink introduction, about one minute, with music/);
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("preload", "none");
  await expect(video).toHaveAttribute("poster", /\/video\/blink-intro-poster\.png$/);
  for (const attr of ["autoplay", "muted", "loop"]) expect(await video.getAttribute(attr)).toBeNull();
  const src = await video.evaluate((v: HTMLVideoElement) => v.querySelector("source")?.src ?? v.src);
  expect((await request.get(src)).status()).toBe(200);
  expect((await video.boundingBox())!.width).toBeLessThanOrEqual(375);
  await expect(page.getByText("Transcript")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Watch" })).toHaveCount(0);
  const order = await page.evaluate(() => {
    const at = (el: Element | null) => (el ? Array.from(document.querySelectorAll("*")).indexOf(el) : -1);
    return [at(document.querySelector("h1")), at(document.querySelector("video")), at(Array.from(document.querySelectorAll("h2")).find((h) => h.textContent?.startsWith("Coordination off-chain")) ?? null)];
  });
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
});
```

Add this to `tests/browser/market-detail.spec.ts`. It carries P4 final-review Minor 8:

```ts
test("the facts row fits at 900 px", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("./markets/sample-01");
  const tight = await page.locator('[class*="fact"]').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
  expect(tight).toEqual([]);
});
```

- [ ] **Step 2: Run the node tests and verify they fail**

Run: `node --import tsx --test tests/web-claims.test.ts tests/web-intro-video.test.ts tests/web-sample-markets.test.ts`
Expected: FAIL. The showcase scan reports "deployed" in `Hero.tsx`, and the chart label test fails.

- [ ] **Step 3: Implement the copy table, the video block and the label; delete `intro-video.ts`**

If the 900 px test fails in CI, fix the facts row CSS in `apps/web/app/markets/[id]/page.module.css`, and remove the stray blank line there while you are in the file.

- [ ] **Step 4: Run the local checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit and push; wait for branch CI**

```bash
git add -A apps/web tests
git commit -m "feat(web): put the video inline and drop progress language from the showcase pages"
git push
```

Expected: branch CI green.

---

### Task 3: Video groundwork: script data, timing, guards and the render loop

**Files:**
- Delete:
  - `scripts/video-capture.ts`
  - `tests/video-capture.test.ts`
  - `tests/video-timeline.test.ts`
  - `video/src/run-record.ts`
  - `video/src/timeline.ts`
  - `video/data/`
- Modify: `package.json` (drop `video:capture`)
- Rewrite: `video/src/script.ts`, `video/src/Root.tsx`, `video/src/scenes/Intro.tsx`
- Create: `video/src/time.ts`, `video/src/fonts.ts`, `scripts/video-docker.sh`
- Modify: `video/package.json` (add `"@remotion/google-fonts": "4.0.536"`), `pnpm-lock.yaml`
- Modify: `scripts/check-boundaries.mjs`
- Rewrite: `docs/INTRO_VIDEO_SCRIPT.md`, `video/README.md`
- Test: `tests/video-script.test.ts`, `tests/video-boundaries.test.ts`

**Interfaces:**
- Produces, in `video/src/script.ts`:
  - `export const BASE_BPM = 120;`
  - `export type ShotId = "hook" | "montage" | "goes-live" | "trading" | "dispute" | "human" | "browse" | "free" | "ending";`
  - `export type Transition = "pop" | "zoom" | "whip" | "fade";`
  - `export type Line = { text: string; accent?: string };`
  - `export type Shot = { id: ShotId; beats: number; in: Transition; out: Transition | null; lines: readonly Line[] };`
  - `export const shots: readonly Shot[];`
  - `export type Music = { file: string; bpm: number; firstBeatSeconds: number; gain: number; source: string; licence: string; checkedOn: string; committed: boolean };`
  - `export const music: Music | null = null;` (Task 8 sets it)
  - `export const screen`: a `const` object with one key per shot (`montage`, `goesLive`, `trading`, `dispute`, `human`, `browse`, `free`, `ending`). It holds every other visible string of that shot: props, bubbles, toasts, labels, market rows, opinions, sources and the wordmark. Later tasks add to it. Scenes take every visible string from `script.ts`.
- Produces, in `video/src/time.ts`:
  - `export function timeScale(bpm: number): number` returns `BASE_BPM / bpm`.
  - `export function shotStarts(): readonly number[]` returns each shot's start in base seconds (one beat is 0.5 s).
  - `export const BASE_SECONDS: number` (58.5).
  - `export function shotFrames(fps: number, bpm: number): readonly { id: ShotId; from: number; durationInFrames: number }[]` uses `from = Math.round(start × scale × fps)`. Each duration is the next `from` minus this one, so the shots are contiguous.
  - `export function totalFrames(fps: number, bpm: number): number`.
  - `export function useShotTime(): number` returns the base seconds since the current `<Sequence>` started: `useCurrentFrame() / fps / timeScale(music?.bpm ?? BASE_BPM)`. Every scene animates on base seconds, so the animatic's timings carry over unchanged.
- Produces, in `video/src/fonts.ts`: `export const FONT_FAMILY: string`, from `loadFont("normal", { weights: ["600", "700"], subsets: ["latin"] })` of `@remotion/google-fonts/Geist`. If 4.0.536 has no `Geist` module, add the `geist` npm package (exact version) instead, and load its woff2 files with `@remotion/fonts` 4.0.536.
- Produces, in `scripts/video-docker.sh <command>`: a script that runs `<command>` in `video/` inside the container. It takes the copy-in, `apt-get` and `pnpm install --frozen-lockfile` steps from today's `video/README.md`, mounts `tmp/video` at `/out`, and mounts a named volume `blink-video-pnpm-store` as the pnpm store so repeat runs reuse downloads.

**The shot list** (copy is fixed by design §4.2 and the 2026-11-01 decision):

| id | beats | in / out | lines (accent) |
| --- | --- | --- | --- |
| hook | 8 | pop / — | "A market run entirely by AI agents." ("AI agents.") |
| montage | 28 | zoom / whip | "Creators ask the questions.", "Makers quote the prices.", "Traders take a side.", "Forecasters sign a probability.", "Proposers report what happened.", "Challengers call it out.", "Jurors vote in secret.", "Keepers keep the clock.", "Everyone has a job." ("job.") |
| goes-live | 9 | whip / whip | "One question goes live." ("goes live.") |
| trading | 10 | whip / fade | "They forecast.", "They trade.", "On what they believe." ("believe.") |
| dispute | 14 | pop / zoom | "And keep each other honest." ("honest."), "Lies cost a bond." ("a bond.") |
| human | 7 | zoom / zoom | "What about you, human?" ("human?") |
| browse | 24 | pop / fade | "Scroll through the future." ("the future."), "Tap one.", "Watch the odds move." ("the odds move."), "Read why." ("why."), "Check the sources." ("the sources.") |
| free | 6 | pop / fade | "No sign-up. No wallet. Free to read." ("Free to read.") |
| ending | 11 | pop / — | (none) |

`screen` strings that Task 3 fixes (later tasks add the rest from the animatic):
- `screen.goesLive.newMarket = { question: <the animatic's new row>, probability: null }`
- `screen.trading.consensusLabel = "Agent consensus"`
- `screen.trading.traderLines = ["Buy YES!", "Buy NO."]`
- `screen.trading.makerQuote = "0.63"`
- `screen.trading.consensusFrom = 41`
- `screen.trading.consensusTo = 63`
- `screen.ending.wordmark = "Blink"`

**`check-boundaries.mjs`:**
- `video/src` may import only `remotion`, `@remotion/*`, `react` and files inside `video/src`. Drop the `drill-run.json` allowance.
- New rule, carrying P4 final-review Important 2. Scan every `.ts`/`.tsx`/`.js`/`.mjs` file under `apps/`, `packages/` and `examples/`, skipping `node_modules`, `.next` and `out`, with `ts.preProcessFile`. Report `${path}: imports the video workspace ${dep}` when a relative import resolves inside `video/`, or when an import names `@blink/video`.

**`docs/INTRO_VIDEO_SCRIPT.md`:** design §4.2 as the script, with the shot 4 staging from the design. It contains every line of `shots` verbatim, plus a short "Sound" section that points to design §4.3.

**`video/README.md`:**
- Keep: the Remotion Free License paragraph and the Studio network note.
- Replace: the capture paragraph with "Every on-screen string lives in `src/script.ts`", and the render paragraph with `scripts/video-docker.sh`.
- Add: an empty "Music" section that Task 8 fills.

- [ ] **Step 1: Write `tests/video-script.test.ts` and `tests/video-boundaries.test.ts`**

`tests/video-script.test.ts`:

```ts
import { shots, screen, music } from "../video/src/script.ts";
import { shotFrames, totalFrames, BASE_SECONDS, timeScale } from "../video/src/time.ts";
import { assertShowcaseClean } from "./showcase-claims.ts";

test("the cut is 117 beats on the 120 BPM grid", () => {
  assert.deepEqual(shots.map((s) => [s.id, s.beats]), [["hook", 8], ["montage", 28], ["goes-live", 9], ["trading", 10], ["dispute", 14], ["human", 7], ["browse", 24], ["free", 6], ["ending", 11]]);
  assert.equal(BASE_SECONDS, 58.5);
  assert.deepEqual(shotFrames(30, 120).map((f) => f.from), [0, 120, 540, 675, 825, 1035, 1140, 1500, 1590]);
  assert.equal(totalFrames(30, 120), 1755);
});
test("a track from 115 to 125 BPM keeps the cut contiguous and within 55-62 s", () => {
  for (const bpm of [115, 125]) {
    const frames = shotFrames(30, bpm);
    frames.forEach((f, i) => assert.equal(f.from, i === 0 ? 0 : frames[i - 1]!.from + frames[i - 1]!.durationInFrames));
    const seconds = totalFrames(30, bpm) / 30;
    assert.ok(seconds >= 55 && seconds <= 62, String(seconds));
  }
  assert.equal(timeScale(120), 1);
});
test("every line is in the script doc, and every accent is part of its line", () => {
  const doc = readFileSync("docs/INTRO_VIDEO_SCRIPT.md", "utf8");
  for (const s of shots) for (const l of s.lines) {
    assert.ok(doc.includes(l.text), `${s.id}: ${l.text}`);
    if (l.accent) assert.ok(l.text.endsWith(l.accent), `${s.id}: ${l.accent}`);
  }
});
test("the video copy is true to the protocol", () => {
  const text = JSON.stringify({ shots, screen, music });
  assertShowcaseClean(text, "video/src/script.ts");
  assert.doesNotMatch(text, /\bsell/i);
  assert.doesNotMatch(text, /\b(thousands|hundreds|millions) of agents\b|\b\d[\d,]* agents\b|24\/7|around the clock|round-the-clock/i);
  assert.doesNotMatch(text, /https?:|www\.|\.github\.io/);
  assert.equal(screen.goesLive.newMarket.probability, null);
  assert.equal(screen.trading.consensusLabel, "Agent consensus");
  assert.deepEqual(screen.trading.traderLines, ["Buy YES!", "Buy NO."]);
  assert.deepEqual(shots.find((s) => s.id === "trading")!.lines.map((l) => l.text), ["They forecast.", "They trade.", "On what they believe."]);
});
```

`tests/video-boundaries.test.ts` moves today's `boundary checker rejects video dependencies and cross-workspace imports` test out of `tests/video-timeline.test.ts`, then adds `apps/web/bad.ts` containing `import { shots } from "../../video/src/script.ts";` to the fixture tree. It asserts both of these:

- `/apps\/web\/bad\.ts: imports the video workspace/`
- `/video\/src\/bad\.ts: forbidden video import/`

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --import tsx --test tests/video-script.test.ts tests/video-boundaries.test.ts`
Expected: FAIL. `time.ts` does not exist, and the checker has no "imports the video workspace" rule.

- [ ] **Step 3: Implement `script.ts`, `time.ts`, `fonts.ts`, the boundary rule and the deletions**

`Root.tsx` registers `BlinkIntro` at 1920×1080, 30 fps, with `durationInFrames = totalFrames(30, music?.bpm ?? BASE_BPM)`.

`Intro.tsx` places one `<Sequence>` per `shotFrames` entry. Each `Sequence` shows a placeholder: the shot's last line, centred in `FONT_FAMILY` 600 on paper `#f4f1ea`. Tasks 4–6 replace the placeholders.

- [ ] **Step 4: Write the docs and `scripts/video-docker.sh`; render one still per shot**

Run, from the worktree root:

```bash
scripts/video-docker.sh 'for f in 60 330 607 750 930 1087 1320 1545 1672; do pnpm exec remotion still src/index.ts BlinkIntro /out/t3-$f.png --frame=$f; done'
```

Expected: nine PNGs in `tmp/video/`, each showing its shot's line in Geist. Open each one.

- [ ] **Step 5: Run the local checks, commit and push**

Run: `pnpm check`
Expected: PASS.

```bash
git add -A video scripts tests docs/INTRO_VIDEO_SCRIPT.md package.json pnpm-lock.yaml
git commit -m "feat(video): script the product introduction on a beat grid and retire the drill capture"
git push
```

---

### Tasks 4–6: The shots

Each task ports animatic shots into Remotion components. Common rules:

- **Source.** The animatic is `docs/superpowers/specs/2026-10-31-intro-video-animatic.html`.
  - Each shot is a `<section class="shot">`: shot 1 at line 245, then 255, 311, 333, 360, 379, 394, 450 and 457.
  - The CSS above line 245 defines the looks and the keyframes.
- **Translating the motion.** Read each element's keyframes, delay and duration, and express them as functions of `useShotTime()`, using Remotion's `spring` and `interpolate`.
  - The animatic's CSS spring curve maps to a `spring` with overshoot.
  - Sizes in `cqw` map to px at 1920 px wide: 1 cqw = 19.2 px.
- **Strings.** Every visible string comes from `script.ts`. Add each string the shot needs to `screen`, copied from the animatic, except where the design changes it.
- **Palette.** Paper `#f4f1ea`, ink `#1d1c1a`, cobalt `#2148b8`, terracotta `#d4562f`, mustard `#e3a62a`, green `#2f9e6e`, violet `#7a5cd6`, sky `#2f9fd0`, pink `#e0679a`.
- **Done means.** The task's stills, rendered with `scripts/video-docker.sh`, match the animatic shot's layout and the design's shot description. The implementer opens every still. Put the stills' paths in the report, so the reviewer can open them too.

### Task 4: Characters, kinetic type and shots 1–2

**Files:**
- Create:
  - `video/src/roles.ts`
  - `video/src/ui/motion.ts`
  - `video/src/ui/Agent.tsx`
  - `video/src/ui/Type.tsx`
  - `video/src/ui/Transition.tsx`
  - `video/src/scenes/Hook.tsx`
  - `video/src/scenes/Montage.tsx`
- Modify: `video/src/scenes/Intro.tsx`
- Test: `tests/video-roles.test.ts`

**Interfaces:**
- Produces, in `video/src/roles.ts`:
  - `export type RoleId = "creator" | "maker" | "trader" | "forecaster" | "proposer" | "challenger" | "juror" | "keeper";`
  - `export const ROLES: readonly { id: RoleId; color: string; accessory: "antenna" | "bars" | "coin" | "goggles" | "flag" | "brows" | "cap" | "clock"; aspect: number; pitch: number }[];`
  - Values, in this order:

    | Role | Colour | Accessory | Aspect | Pitch |
    | --- | --- | --- | --- | --- |
    | creator | `#2148b8` | antenna | 1 | 523 |
    | maker | `#7a5cd6` | bars | 1.3 | 440 |
    | trader | `#d4562f` | coin | 1 (round body) | 659 |
    | forecaster | `#2f9fd0` | goggles | 1 | 784 |
    | proposer | `#1d1c1a` | flag | 1 | 587 |
    | challenger | `#e3a62a` | brows | 1 | 494 |
    | juror | `#2f9e6e` | cap | 1 | 392 |
    | keeper | `#e0679a` | clock | 1 | 698 |

- Produces, in `video/src/ui/`:
  - `<Agent role size x y t pose />`: the minimal character. A solid rounded square (round for the trader), two white vertical-bar eyes, no outline, and the role's accessory. `pose` covers `{ pop?: number; hop?: number; sway?: number; blinkAt?: readonly number[]; shake?: number; grey?: boolean; scale?: number }`.
  - `<KineticLine line={Line} at={number} />`: words pop in one at a time from a blur, 0.15 s apart. The accent is terracotta with a hand-drawn underline that draws on.
  - `<LineSwap lines={readonly Line[]} at={readonly number[]} />`: each line replaces the previous one in place at its time.
  - `<ShotTransition in out>`: wraps a shot and applies pop, zoom, whip (with motion blur) or fade at its edges.
  - `motion.ts` holds `popIn(t, delay)`, `hop(t, at)` and `blink(t, at)`, as pure functions of base seconds over Remotion's `spring`/`interpolate`.

**Shots:**
- Shot 1: the animatic's shot at line 245.
- Shot 2: the animatic's shot at line 255. For roles in order from 0.5 s, each role holds the stage for 1.5 s, doing its job next to its line, then a small copy joins the line-up along the bottom. "Everyone has a job." lands at 12.5 s. The jobs are design §4.1's action column. The challenger's shake and its spring-in run together. The maker's "Quote?" bubble sits beside the maker, not offset.

- [ ] **Step 1: Write `tests/video-roles.test.ts`**

It asserts the `ROLES` ids, colours, accessories and pitches above, in order. It also asserts that the montage lines in `shots[1]` start with the plural of each role in the same order ("Creators", "Makers", …).

- [ ] **Step 2: Run it and verify it fails**

Run: `node --import tsx --test tests/video-roles.test.ts`
Expected: FAIL. `roles.ts` does not exist.

- [ ] **Step 3: Implement `roles.ts`, the `ui/` kit and the two scenes; wire them into `Intro.tsx`**

- [ ] **Step 4: Render and check the stills**

Run:

```bash
scripts/video-docker.sh 'for f in 30 75 165 210 255 300 345 390 435 480 525 615; do pnpm exec remotion still src/index.ts BlinkIntro /out/t4-$f.png --frame=$f; done'
```

The frames cover:

| Frames | What they show |
| --- | --- |
| 30, 75 | the hook |
| 165, 210, 255, 300, 345, 390, 435, 480 | each role mid-job |
| 525 | "Everyone has a job." with the line-up |
| 615 | after the cut to shot 3 (still a placeholder) |

Expected:
- Each role has its colour, its accessory and its prop next to its line.
- The underline sits under "AI agents." and under "job.".
- No element is clipped by the frame.

- [ ] **Step 5: Run `pnpm check`, commit and push**

```bash
git add -A video tests/video-roles.test.ts
git commit -m "feat(video): role characters, kinetic type and the hook and job montage"
git push
```

### Task 5: Product windows and shots 3–5

**Files:**
- Create: `video/src/ui/Window.tsx`, `video/src/scenes/GoesLive.tsx`, `video/src/scenes/Trading.tsx`, `video/src/scenes/Dispute.tsx`
- Modify: `video/src/scenes/Intro.tsx`, `video/src/script.ts` (`screen.goesLive`, `screen.trading`, `screen.dispute`)

**Interfaces:**
- Produces `<ProductWindow t>`: a browser window redrawn in Blink's site style. It has a title bar, a hand-drawn outline frame, and a flowing colour-gradient panel behind it. The gradient moves as a function of `t`.

**Shots:**
- **Shot 3** (the animatic's shot at line 311). The creator sits on the window's top edge, fully inside the frame, at the window's top-right. The "New question!" bubble sits to its left. The new row slides in at the top with the NEW tag and "—".
- **Shot 4.** This shot follows the design, not the animatic's shot at line 333:
  - Forecasters toss signed probability notes into the chart, and the counter under the label "Agent consensus" counts from 41% to 63% while the chart line draws.
  - Beside the window, traders say "Buy YES!" and "Buy NO." to a maker quoting "0.63". Coins pass only between them, never into the chart.
  - The lines swap "They forecast." → "They trade." → "On what they believe." on the beat.
- **Shot 5** (the animatic's shot at line 360):
  1. "Answer: no."
  2. "I challenge that!" with a shake.
  3. Three jurors each show ✓.
  4. The proposer shrinks and greys, and the toast "Challenge upheld · answer corrected" appears.
  5. Coins fly from the proposer to the challenger and the jurors.
  6. The lines swap "And keep each other honest." → "Lies cost a bond.".

- [ ] **Step 1: Add the shots' strings to `screen` and run `tests/video-script.test.ts`**

Run: `node --import tsx --test tests/video-script.test.ts`
Expected: PASS. The truth test now covers the new strings.

- [ ] **Step 2: Implement `Window.tsx` and the three scenes**

- [ ] **Step 3: Render and check the stills**

Run:

```bash
scripts/video-docker.sh 'for f in 570 630 700 735 790 850 900 960 1010; do pnpm exec remotion still src/index.ts BlinkIntro /out/t5-$f.png --frame=$f; done'
```

Expected:
- Shot 3: the creator and its bubble are inside the frame, and the new row shows "—".
- Shot 4: the notes fly into the chart, the coins stay between the traders and the maker, and the counter's label reads "Agent consensus".
- Shot 5: the toast and the greyed proposer.

- [ ] **Step 4: Run `pnpm check`, commit and push**

```bash
git add -A video
git commit -m "feat(video): product windows, the new question, forecasts and trades, and the dispute"
git push
```

### Task 6: Shots 6–9

**Files:**
- Create: `video/src/ui/Phone.tsx`, `video/src/scenes/Human.tsx`, `video/src/scenes/Browse.tsx`, `video/src/scenes/Free.tsx`, `video/src/scenes/Ending.tsx`
- Modify: `video/src/scenes/Intro.tsx`, `video/src/script.ts` (`screen.human`, `screen.browse`, `screen.free`)

**Shots:**
- **Shot 6** (the animatic's shot at line 379). The agents peek up from the bottom edge.
- **Shot 7** (the animatic's shot at line 394). It reuses `ProductWindow`.
  1. The card grid scrolls.
  2. The cursor taps "Will it rain in Taipei on New Year's Eve?" at 63%.
  3. The detail page opens and its chart draws.
  4. "What the agents think" shows three opinions, each with its agent, reason and probability.
  5. "Sources" shows two entries.
  6. The phone slides in at 9.8 s. It is 13 cqw wide (250 px) with a 9:19 aspect ratio, fully inside the frame, and shows the same market.
- **Shot 8** (the animatic's shot at line 450). "No sign-up." "No wallet." "Free to read." pop in.
- **Shot 9** (the animatic's shot at line 457):
  1. The eight agents line up and blink twice together.
  2. They gather at the centre.
  3. At 2.75 s the eye emblem springs in. It is drawn from `apps/web/app/icon.svg`'s paths: the outline, the iris and the terracotta glint. Copy the path data. Do not import the file.
  4. From 3.35 s the letters of "Blink" pop in to its right.
  5. At 3.9 s the eye blinks twice, one third of a second apart.

- [ ] **Step 1: Add the shots' strings to `screen` and run `tests/video-script.test.ts`**

Run: `node --import tsx --test tests/video-script.test.ts`
Expected: PASS.

- [ ] **Step 2: Implement `Phone.tsx` and the four scenes**

- [ ] **Step 3: Render and check the stills**

Run:

```bash
scripts/video-docker.sh 'for f in 1080 1200 1290 1350 1440 1480 1560 1620 1680 1720 1750; do pnpm exec remotion still src/index.ts BlinkIntro /out/t6-$f.png --frame=$f; done'
```

Expected:
- The phone is fully inside the frame and is not stretched.
- The emblem matches the site icon.
- The last frame shows the emblem and "Blink" on paper, with no URL.

- [ ] **Step 4: Run `pnpm check`, commit and push**

```bash
git add -A video
git commit -m "feat(video): the human turn, browsing a market, free to read and the eye ending"
git push
```

---

### Task 7: Sound effects, cues and the music slot

**Files:**
- Create: `video/scripts/sfx.ts`, `video/src/sound.ts`, `video/public/sfx/*.wav`
- Modify: `video/src/scenes/Intro.tsx`, `package.json` (script `"video:sfx": "node --import tsx video/scripts/sfx.ts"`)
- Test: `tests/video-sound.test.ts`

**Interfaces:**
- Produces, in `video/src/sound.ts`:
  - `export type Cue = { shot: ShotId; at: number; sound: string };`, where `at` is base seconds from the shot's start. `sound` is a sound id that encodes its parameters, such as `pop-523`, `ding-2093`, `scribble-0.3`, `blips-12-3.2`, `sweep-3`, `scroll-2.5` or `note-659`.
  - `export const CUES: readonly Cue[];` ported from the animatic's `SFX` table (lines 560–583), shot by shot. Shot 4 instead uses: `whoosh` at 0; `pop-<forecaster pitch>` per note as each note lands; `blips` and `sweep` under the counter; `coinUp`/`coinDown` on each trade between a trader and the maker.
  - `export function musicVolume(t: number): number` is the music envelope over base seconds `t` from the start of the video:

    | Time (base seconds) | Volume |
    | --- | --- |
    | shot 1 (0–4) | 0.5 |
    | 4 to 35 (shot 6 start + 0.5) | 1 |
    | 35 to 35.12 | linear fade to 0 |
    | until shot 7 (38) | 0 |
    | shots 7–8 (38–53) | 0.6 |
    | 53 to 53.5 | linear fade to 0 |
    | after 53.5 | 0 |

    It is multiplied by `music.gain` in the composition.
- Produces, in `video/scripts/sfx.ts`:
  - `export function synth(id: string): Float32Array`, mono at 44,100 Hz. It is an offline port of the animatic's `tone`, `noise`, `env` and `S` recipes (lines 521–559), with the same frequencies, envelopes and levels. Noise comes from a seeded PRNG (mulberry32, seed 1), so the output is deterministic.
  - `export function wav(samples: Float32Array): Buffer` writes 16-bit PCM mono, clamped to [-1, 1].
  - The CLI writes `video/public/sfx/<id>.wav` for every distinct `CUES` sound id and deletes stale files in that folder.
- In `Intro.tsx`:
  - Each cue is a `<Sequence from={cueFrame}>` holding one audio element at volume `0.56` (the animatic's 0.8 SFX bus × 0.7 master).
  - When `music` is set, one audio element plays `staticFile(music.file)` from `firstBeatSeconds`, with `volume={(f) => musicVolume(f / fps / timeScale(music.bpm)) * music.gain}`.
  - Use the audio component that `remotion` 4.0.536 exports (`Html5Audio` if present, else `Audio`; check `node_modules/remotion/dist/cjs/index.d.ts`). Add no package.

- [ ] **Step 1: Write `tests/video-sound.test.ts`**

```ts
test("every cue sits inside its shot", () => {
  const len = Object.fromEntries(shots.map((s) => [s.id, s.beats * 0.5]));
  for (const c of CUES) assert.ok(c.at >= 0 && c.at < len[c.shot]!, `${c.shot} ${c.at} ${c.sound}`);
  assert.ok(CUES.some((c) => c.shot === "ending" && c.sound === "logo"));
});
test("the committed sound files are exactly what the recipes make", () => {
  const ids = [...new Set(CUES.map((c) => c.sound))].sort();
  assert.deepEqual(readdirSync("video/public/sfx").sort(), ids.map((id) => `${id}.wav`));
  for (const id of ids) assert.ok(wav(synth(id)).equals(readFileSync(`video/public/sfx/${id}.wav`)), id);
  assert.ok(wav(synth("pop-523")).equals(wav(synth("pop-523"))));
});
test("the music envelope follows the design's shape", () => {
  assert.equal(musicVolume(1), 0.5);
  assert.equal(musicVolume(20), 1);
  assert.equal(musicVolume(34.9), 1);
  assert.equal(musicVolume(36), 0);
  assert.equal(musicVolume(45), 0.6);
  assert.equal(musicVolume(55), 0);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --import tsx --test tests/video-sound.test.ts`
Expected: FAIL. `sound.ts` does not exist.

- [ ] **Step 3: Implement `sound.ts` and `sfx.ts`, run `pnpm video:sfx`, and wire the audio into `Intro.tsx`**

- [ ] **Step 4: Render a silent-bed preview with effects**

Run: `scripts/video-docker.sh 'pnpm exec remotion render src/index.ts BlinkIntro /out/preview-sfx.mp4'`
Expected: `tmp/video/preview-sfx.mp4` of 58.5 s, with an audio track.

- [ ] **Step 5: Run `pnpm check`, commit and push**

```bash
git add -A video package.json tests/video-sound.test.ts
git commit -m "feat(video): synthesised sound effects, the cue sheet and the music slot"
git push
```

---

### Checkpoint: the music pick (controller, then the user)

The controller shortlists three tracks that meet all of these:

- 115–125 BPM;
- light and playful (plucked or marimba-like over a soft beat);
- at least 60 s long;
- a licence that allows commercial use without attribution.

Prefer CC0 or public domain, so the file can be committed.

For each track, give the user the source page, the licence page, the BPM, and whether the file can be committed. The user picks one by ear. Task 8 starts after the pick.

### Task 8: Final render, embed and the P4 record

**Files:**
- Add: `video/public/music/<file>` if the licence allows committing it. Otherwise add its path to `.gitignore`, and record its download page and SHA-256 in `video/README.md`.
- Modify: `video/src/script.ts` (`music`), `video/remotion.config.ts` (CRF and preset to meet the size target)
- Replace: `apps/web/public/video/blink-intro.mp4`, `apps/web/public/video/blink-intro-poster.png`
- Modify: `video/README.md` (Music section: the source page, licence page, check date, BPM and `firstBeatSeconds`), `tests/web-intro-video.test.ts`
- Modify:
  - `docs/P4_WEBSITE_VIDEO.md`: a "Rework (2026-11)" section with the scope and a verification record. The record names the branch CI run ids, the final `pnpm check` test count and the render settings, which carries P4 final-review Minor 5.
  - `README.md` and `README.zh-TW.md` (line 48)
  - `docs/ROADMAP.md` (lines 17–18)
  - `docs/ARCHITECTURE.md` (line 109)

  These describe the advantages as part of the home page and the video as a product introduction. `README.zh-TW.md` stays in Traditional Chinese.

- [ ] **Step 1: Add the audio-track check to `tests/web-intro-video.test.ts`**

```ts
test("the committed video has a sound track", () => {
  const mp4 = readFileSync("apps/web/public/video/blink-intro.mp4");
  let at = mp4.indexOf("hdlr"), found = false;
  while (at !== -1 && !found) { found = mp4.subarray(at, at + 24).includes("soun"); at = mp4.indexOf("hdlr", at + 4); }
  assert.ok(found, "no audio handler in the MP4");
});
```

Run: `node --import tsx --test tests/web-intro-video.test.ts`
Expected: FAIL, because the old MP4 has no audio.

- [ ] **Step 2: Set `music`, tune `gain` and render the video and the poster**

The poster is the montage line-up under "Everyone has a job.", at shot 2 start + 13.5 base seconds.

Run:

```bash
scripts/video-docker.sh 'pnpm exec remotion render src/index.ts BlinkIntro /out/blink-intro.mp4 && pnpm exec remotion still src/index.ts BlinkIntro /out/blink-intro-poster.png --frame=<poster frame>'
```

Expected: the MP4 is at most 8 MB (hard cap 15 MB) and runs 55–62 s.

- [ ] **Step 3: The user reviews the render**

The controller puts the MP4 on the brainstorm companion page and asks the user to watch it with sound. If the user wants changes, they go back to the owning task: sound to Task 7, shots to Tasks 4–6. Continue only after the user approves.

- [ ] **Step 4: Copy the approved MP4 and poster into `apps/web/public/video/`, update the docs, and run `pnpm check`**

Expected: PASS, including the sound-track test.

- [ ] **Step 5: Commit and push; wait for branch CI; merge**

```bash
git add -A apps/web/public/video video docs README.md README.zh-TW.md tests/web-intro-video.test.ts .gitignore
git commit -m "feat: ship the product introduction video and record the P4 rework"
git push
```

Expected: branch CI green. Then `git merge --no-ff p4-product-rework` into main, push, and watch main CI and the Pages deploy.
