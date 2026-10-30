# P4 Website Advantages and Introduction Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The website states Blink's advantages, marking each item implemented or under construction and backing every comparison with a dated source. Every site page describes the agent-only design. A Remotion introduction video, built from a real `pnpm alpha:autonomous` run, plays on the site.

**Architecture:**
- The advantages page renders typed data from `apps/web/content/advantages.ts`. A node test checks that data: statuses, evidence paths that exist in the repo, and comparison sources and dates.
- The how-it-works page, the home page and the sample markets are rewritten for the agent-only design. A claims test bans the v0.1 phrases from the site's source.
- `scripts/video-capture.ts` turns the drill's `report.json` and the agents' JSON logs into a whitelisted run record, `video/data/drill-run.json`. The `video/` workspace (`@blink/video`, Remotion) renders the script in `docs/INTRO_VIDEO_SCRIPT.md` from that record.
- The rendered MP4, its poster and its transcript are committed under `apps/web/public/video/` and embedded on the home page. Nothing in `apps/*` or `packages/*` depends on `@blink/video`.

**Tech Stack:**
- Next 16.3.5 static export (GitHub Pages under `/blinkmarket`) and React 19.3.0
- Remotion 4, in its own pnpm workspace package
- node:test and Playwright 1.63.0

**Spec:** `docs/superpowers/specs/2026-10-23-autonomous-market-design.md` (§2.1.6, §3, §5.12, §9, §10, §11)

**Prerequisite:** P3 (`docs/superpowers/plans/2026-10-25-p3-reference-agents-drill.md`) has passed its final review, is merged to main, and CI is green. Every P4 task starts from that main.

## Global Constraints

- §9: "Mark each item 'implemented' or 'under construction', and move it to implemented only when the feature is done. Facts compared with other platforms must carry a verification date and a source; do not write descriptions that cannot be verified."
- Anti-goal (§3): "The website or documentation claims a capability that is not implemented yet."
- "Implemented" on the site means built and verified locally by the tests and `pnpm alpha:autonomous`. Nothing is deployed, and every page that uses the word says so.
- §5.12: the site states the claim as "**Under the publicly listed assumptions**, honesty is the provably best strategy", never as an unconditional guarantee, and links `/docs/trust`.
- §10: the video is made with Remotion "in a separate workspace inside the repo, so that the website and services do not depend on it". Its footage is "mainly from an actual run of `pnpm alpha:autonomous`; historical or fixture data must be labeled".
- Positioning (spec U19). Every page that introduces Blink, and the video's first scene, use this copy verbatim. Task 1 puts it in `apps/web/content/positioning.ts`:
  - **For agents:** "A market where agents trade and earn fees, each working to maximize its profit."
  - **For people:** "An open encyclopedia of the future: look up the probability of an event that has not happened yet, and read how agents reached it. People read; agents do the work."
  - Nothing on the site invites a person to trade, take a role or suggest a question.
- Liquidity for long-tail questions is the lead advantage (spec U20). It is first on the advantages page and the first difference in the video.
- Per spec U21:
  - no suggestion form;
  - the platform token is described only as a test-network experiment, with no price-source text;
  - deployment and banned-question handling get one neutral line each, with no design detail.
- Per spec U22 (2026-10-30): the website offers no trading, signing or wallet connection, and the platform custodies no funds. The advantages page presents this smaller attack surface as an advantage, and a test keeps the website free of wallet code. Custody comparison facts describe mechanisms only and never name another platform's security incident.
- User decisions (2026-10-29):
  - The Remotion Free License applies: the project is run by an individual or a team of at most three. `video/README.md` records this, with the license URL and the date checked.
  - The video is English only, with on-screen text and no voice-over.
  - The rendered MP4 is committed and embedded on the website.
- The video uses no footage of the optional LLM demo. It has never been run, and running it costs the operator money.
- Every new dependency is pinned to an exact version at least two weeks old. Every `@remotion/*` package uses the same version as `remotion`.
- `apps/web/AGENTS.md`: read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing Next code.
- Every root-relative `src` or `href` that Next does not rewrite goes through `withBase` (`apps/web/lib/base-path.ts`), and `scripts/check-pages-export.mjs` must pass.
- `pnpm build`, `pnpm build:pages` and `pnpm test:browsers` cannot run on this development host (glibc 2.28), so they run in branch CI. A web task is verified only when its branch CI is green.
- Merging to main publishes the site through `.github/workflows/pages.yml`. Nothing else is deployed, and no paid service is used (`AGENTS.md`).
- English for code comments, docs and commit messages. Every commit ends with its implementer's `Co-Authored-By` line.

## Review Focus

1. **The static export under `/blinkmarket`.** The video, the poster and the advantages page must resolve on GitHub Pages, not only under `next start`. Tests: in Task 6, `check-pages-export.mjs` lists the video files and `advantages.spec.ts` checks that the video `src` returns 200. In Task 1, `check-pages-export.mjs` lists `advantages/index.html`.
2. **A status claimed without the feature.** Every implemented advantage names evidence paths, and a test fails if one does not exist. Test: Task 1 `every implemented advantage names evidence that exists`.
3. **A secret or stray field in the run record.** Agent logs carry free-form fields, and one could hold a key. Capture keeps only whitelisted events and fields. Test: Task 4 `capture keeps only whitelisted events and fields`.
4. **A 375 px phone.** The comparison's long source URLs and the video must not push the page sideways. Tests: Task 1 adds `/advantages` to `routes.spec.ts`, and its overflow check covers the comparison. Long links wrap (`overflow-wrap: anywhere`). Task 6 checks that the video fits the viewport.
5. **Status shown by colour only.** A screen reader or a monochrome print loses it. Every status is a text label. Test: Task 1 `advantages.spec.ts` reads the label text.

---

## Pre-flight rulings (the controller records these in the ledger before Task 1)

- **No suggestion form, and no invitation to suggest (U19, U21).** The protocol's suggestion channel (U9) stays as built. The drill still runs its suggestion scenario, and the video may show that scenario as a fact of the run. The site neither offers nor promotes the channel to people.
- **Comparison facts are fixed in this plan.** They come from the controller's research of 2026-10-29 (`.superpowers/research/reports/`, git-ignored). The implementer copies them verbatim and does not research further. A reviewer may check a source URL, but never changes a fact without a new source and date.
- **Video data is real, and the illustrations are labeled.** Scenes that show agents, markets or events read `video/data/drill-run.json`. Any other visual carries an on-screen "Illustration" label.
- **Rendering needs a browser download and a newer glibc.** Remotion downloads Chrome Headless Shell, and its compositor may need a newer glibc than this host's 2.28. `pnpm video:render` runs on the host if it can. Otherwise it runs in the `node:22-bookworm` container command recorded in `video/README.md`. CI never renders.

---

### Task 1: The advantages page

**Files:**
- Create:
  - `apps/web/content/positioning.ts`
  - `apps/web/content/advantages.ts`
  - `apps/web/app/advantages/page.tsx` and `page.module.css`
  - `tests/web-advantages.test.ts`
  - `tests/web-no-wallet.test.ts`
  - `tests/browser/advantages.spec.ts`
  - `docs/P4_WEBSITE_VIDEO.md`
- Modify:
  - `apps/web/components/SiteHeader.tsx` (nav: Markets, How it works, Advantages, Docs)
  - `tests/browser/routes.spec.ts` (add `/advantages`)
  - `scripts/check-pages-export.mjs` (`KEY_FILES` gains `advantages/index.html`)

**Interfaces:**
- Produces, in `apps/web/content/positioning.ts`: `export const FOR_AGENTS: string;` and `export const FOR_PEOPLE: string;`, the two positioning lines, verbatim.
- Produces, in `apps/web/content/advantages.ts`:
  - `export type AdvantageStatus = "implemented" | "under-construction";`
  - `export type Advantage = { id: string; title: string; summary: string; points: readonly string[]; limits: readonly string[]; status: AdvantageStatus; evidence: readonly string[]; docs: string };`
    - `evidence` holds repo-relative paths.
    - `docs` is a site path such as `/docs/trust`.
  - `export type ComparisonFact = { platform: string; topic: ComparisonTopic; fact: string; source: string; checkedOn: string };`
  - `export type ComparisonTopic = "market-creation" | "resolution" | "liquidity" | "agents" | "custody";`
  - `export const advantages: readonly Advantage[];`
  - `export const comparison: readonly ComparisonFact[];`
  - `export const blinkPosition: Readonly<Record<ComparisonTopic, string>>;`
  - `export const STATUS_LABEL: Readonly<Record<AdvantageStatus, string>>;` (`"Implemented"`, `"Under construction"`)
- Task 6 changes the `introduction-video` item to implemented.

**The items, in this order.** The ids, titles and statuses are fixed. The implementer writes `summary`, `points` and `limits` from the spec section and the docs named here. Every limit below must appear.

| id | Title | Status | Evidence | Docs | Required limits |
| --- | --- | --- | --- | --- | --- |
| `rfq-long-tail` | Liquidity for long-tail questions, on request | implemented | `tests/rfq-relay.test.ts`, `contracts/test/protocol/MarketsTrading.t.sol` | `/docs/maker` | The relay polls; there is no push delivery yet. A question gets a price only when at least one registered maker chooses to quote it. |
| `no-custody` | No custody, and a website that cannot move funds | implemented | `tests/web-no-wallet.test.ts`, `tests/platform-keys.test.ts`, `tests/client-verify-quote.test.ts`, `tests/wallet-challenge.test.ts` | `/docs/trust` | Each agent guards its own key: a stolen key loses that agent's funds. An agent that skips the client's checks can be fed a bad quote or challenge by a compromised API. The contracts have had no external audit. |
| `agent-only` | Every role is an agent, with layered settlement and per-role credit | implemented | `tests/alpha/autonomous.test.ts`, `scripts/alpha-autonomous.ts`, `contracts/test/protocol/ResolutionDispute.t.sol`, `contracts/test/protocol/Registry.t.sol` | `/docs/roles` | The §5.12 sentence: under the publicly listed assumptions, honesty is the provably best strategy. Link `/docs/trust`. |
| `readable-reasoning` | Readable reasoning behind every forecast | implemented | `tests/forecast-signing.test.ts`, `tests/content.test.ts` | `/docs/forecaster` | The reference forecaster publishes no reasoning document, because it uses a fixture model. A forecaster with its own model can. |
| `closed-loop` | A verifiable loop from raw data to score | implemented | `tests/content.test.ts`, `tests/forecast-signing.test.ts`, `tests/forecast-merkle.test.ts`, `contracts/test/protocol/Anchor.t.sol`, `tests/evaluation.test.ts` | `/docs/forecaster` | A window root is on chain only if an agent anchors it. |
| `contamination` | Protection against forecast contamination | implemented | `tests/forecasts.test.ts`, `tests/clock-sealing.test.ts`, `tests/postgres/forecasts.test.ts`, `tests/evaluation.test.ts` | `/docs/forecaster` | Sealing holds between agents. The platform's database can read sealed answers before the deadline, but it cannot forge or alter them. |
| `research-vs-price` | Research probability shown apart from price | implemented | `tests/consensus.test.ts`, `tests/rfq-relay.test.ts` | `/docs/concepts` | The consensus is a read model: it moves no funds. |
| `agent-safety` | Safety boundaries for autonomous agents | implemented | `tests/platform-keys.test.ts`, `tests/client-verify-quote.test.ts`, `tests/protocol-abi.test.ts` | `/docs/agents` | A registration fee and distinct addresses are not a trusted identity. |
| `public-deployment` | A public deployment | under-construction | none | `/docs/deployment` | Not deployed yet; everything runs on a local test chain. |
| `banned-questions` | Handling illegal or harmful questions | under-construction | none | `/docs/trust` | Under discussion. |
| `platform-token` | The platform token | under-construction | none | `/docs/trust` | A test-network experiment for now. |
| `introduction-video` | An introduction video | under-construction | none | `/` | The introduction video is still in production. |

**What the `rfq-long-tail` points say.** One point compares Blink with others using only the liquidity facts at the end of this plan. For example: "In the markets checked on 2026-10-29, liquidity comes from an order book, a designated liquidity provider program or the creator's own pool (sources below)." A second point states Blink's mechanism: any registered maker can quote any question when a taker asks, with no standing pool. Never claim that no other market has such a mechanism: the research supports only the markets it checked.

**What the `no-custody` points say.** The platform holds no funds and no key that can move them. Collateral sits in the protocol contracts, which have no owner, admin, pause or upgrade function; the governor can only adopt the next generation and cannot touch an existing market (`/docs/trust`). Each agent holds its own wallet and signs its own transactions; the platform creates, funds and custodies no wallet, and an API key never authorizes a withdrawal or a transfer. The website only reads: it asks for no wallet, requests no signature and sends no transaction. The client and the reference agents check a quote's signature and terms, and a wallet challenge's origin and action, before they sign. Name no other platform's incident.

**What the `readable-reasoning` points say.** A forecast's signed message includes `contentHash`, the hash of a `/v1/content` document holding the agent's reasoning. So the reasoning cannot be swapped after signing, and anyone can fetch it by hash.

**The comparison.** One section, "How other markets handle this". It is a `<section aria-label="Comparison with other markets">` with one block per topic, in the order market-creation, resolution, liquidity, agents, custody.
- Each block lists its facts: the platform, the fact, the source as a link and "checked" with the fact's `checkedOn` date.
- Each block ends with Blink's approach, taken from `blinkPosition`.
- The facts are sparse across platforms, so this is a list per topic, not a grid. It cannot overflow a phone.
- Facts and sources: the "Comparison facts" section at the end of this plan, verbatim.
- `blinkPosition` holds one sentence per topic. Each sentence names a mechanism this repo implements, from the docs page in the table above.

- [ ] **Step 1: Write `tests/web-advantages.test.ts`**

```ts
test("the advantages list has the fixed ids, order and statuses", () => {
  assert.deepEqual(advantages.map((a) => [a.id, a.status]), [
    ["rfq-long-tail", "implemented"], ["no-custody", "implemented"], ["agent-only", "implemented"],
    ["readable-reasoning", "implemented"],
    ["closed-loop", "implemented"], ["contamination", "implemented"], ["research-vs-price", "implemented"],
    ["agent-safety", "implemented"],
    ["public-deployment", "under-construction"], ["banned-questions", "under-construction"],
    ["platform-token", "under-construction"], ["introduction-video", "under-construction"],
  ]);
});
test("no advantage claims what the research cannot support, or names a token price source", () => {
  const text = JSON.stringify(advantages);
  assert.ok(!/no other (market|platform)|only (market|platform)|nobody else/i.test(text));
  assert.ok(!/price source|TWAP|oracle price/i.test(advantages.find((a) => a.id === "platform-token")!.limits.join(" ")));
});
test("every implemented advantage names evidence that exists", () => {
  for (const a of advantages.filter((x) => x.status === "implemented")) {
    assert.ok(a.evidence.length > 0, a.id);
    for (const path of a.evidence) assert.ok(existsSync(path), `${a.id}: ${path}`);
  }
  for (const a of advantages.filter((x) => x.status === "under-construction")) assert.deepEqual(a.evidence, [], a.id);
});
test("every advantage states its limits and links a docs page that exists", () => {
  // Every advantage has a non-empty `limits`, and its `docs` path is "/" or matches a page under apps/web/content/docs.
});
test("agent-only carries the §5.12 wording and links /docs/trust", () => {
  // The joined text includes "Under the publicly listed assumptions, honesty is the provably best strategy" and "/docs/trust".
});
test("the positioning lines are the approved copy", () => {
  assert.equal(FOR_AGENTS, "A market where agents trade and earn fees, each working to maximize its profit.");
  assert.equal(FOR_PEOPLE, "An open encyclopedia of the future: look up the probability of an event that has not happened yet, and read how agents reached it. People read; agents do the work.");
});
test("every comparison fact has an https source and the check date", () => {
  for (const f of comparison) {
    assert.match(f.source, /^https:\/\/[^\s]+$/);
    assert.equal(f.checkedOn, f.topic === "custody" ? "2026-10-30" : "2026-10-29");
    assert.ok(f.fact.length > 0 && !/\b(best|leading|only)\b/i.test(f.fact), f.platform);
  }
  assert.deepEqual(Object.keys(blinkPosition).sort(), ["agents", "custody", "liquidity", "market-creation", "resolution"]);
});
```

Also write `tests/web-no-wallet.test.ts`, which keeps the `no-custody` claims true:

```ts
test("the website depends on no wallet or chain library", () => {
  // apps/web/package.json dependencies and devDependencies contain none of: viem, wagmi, ethers, web3,
  // @rainbow-me/rainbowkit, connectkit, @reown/*, @web3modal/*, @walletconnect/*, @coinbase/wallet-sdk, @metamask/*.
});
test("no website source asks for a wallet, a signature or a transaction", () => {
  // No .ts, .tsx, .js, .jsx or .mjs file under apps/web (excluding node_modules, .next and out) matches the pattern below.
  // Markdown and text are agent documentation, which may name these calls; they are not website code.
  // /window\.ethereum|eth_requestAccounts|eth_sendTransaction|personal_sign|eth_signTypedData|signTypedData|sendTransaction|writeContract/.
});
test("no protocol contract has an owner, admin, pause or upgrade function", () => {
  // For each contract in contracts/src/protocol/*.sol, read the ABI in contracts/artifacts/<Name>.json
  // (as tests/protocol-abi.test.ts does): no function name matches /owner|admin|pause|upgrade|rescue|sweep|emergency/i.
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --import tsx --test tests/web-advantages.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Write `apps/web/content/advantages.ts`**

Use the table above and the comparison facts.

- [ ] **Step 4: Write the page**

Build `apps/web/app/advantages/page.tsx`, with `export const metadata = { title: "Advantages" }`. It has four parts:
1. An intro. It contains the two positioning lines (Global Constraints) and the sentence "Implemented means built and verified locally by the tests and the autonomous drill. Nothing is deployed yet."
2. The implemented items.
3. The under-construction items.
4. The comparison.

Layout rules:
- Each status is a visible text label from `STATUS_LABEL`, never colour alone.
- Source links wrap with `overflow-wrap: anywhere`, so that no URL is wider than a 375 px screen.
- Follow the style of the existing pages: `container section`, `eyebrow` and the CSS modules. Add no new dependency.

- [ ] **Step 5: Write `tests/browser/advantages.spec.ts`**

```ts
test("advantages page labels every status in text", async ({ page }) => {
  await page.goto("./advantages");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Implemented", { exact: true })).toHaveCount(8);
  await expect(page.getByText("Under construction", { exact: true })).toHaveCount(4);
  await expect(page.getByText(FOR_PEOPLE)).toBeVisible();
  await expect(page.getByRole("region", { name: "Comparison with other markets" })).toBeVisible();
  await expect(page.getByText(/Nothing is deployed yet/)).toBeVisible();
});
test("the header links the advantages page", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Advantages" }).click();
  await expect(page).toHaveURL(/\/advantages\/?$/);
});
```

Also add `/advantages` to `routes.spec.ts` and `advantages/index.html` to `KEY_FILES`.

- [ ] **Step 6: Check the nav on a phone**

Read `nav.spec.ts`. If the header has a mobile menu or a fixed link count, update that spec so that the four links fit at 375 px.

- [ ] **Step 7: Run the local checks**

Run each once: `node --import tsx --test tests/web-advantages.test.ts tests/web-no-wallet.test.ts`, `pnpm typecheck`, `pnpm check`.
Expected: all pass. Browser and Pages checks run in branch CI.

- [ ] **Step 8: Start the P4 doc**

Create `docs/P4_WEBSITE_VIDEO.md`, styled like `docs/P3_AGENTS_PROGRESS.md`:
- the title and scope;
- a `## Task 1` section: what changed, the commands and their counts, and "browser and Pages checks: branch CI".

- [ ] **Step 9: Commit**

```bash
git add apps/web/content/positioning.ts apps/web/content/advantages.ts apps/web/app/advantages tests/web-advantages.test.ts tests/web-no-wallet.test.ts tests/browser/advantages.spec.ts tests/browser/routes.spec.ts apps/web/components/SiteHeader.tsx scripts/check-pages-export.mjs docs/P4_WEBSITE_VIDEO.md
git commit -m "feat: add the advantages page with statuses and sourced comparisons"
```

Add `tests/browser/nav.spec.ts` to the commit if Step 6 changed it.

### Task 2: How it works and the home page, for the agent-only design

**Files:**
- Modify:
  - `apps/web/app/how-it-works/page.tsx`
  - `apps/web/app/page.tsx`
  - `apps/web/app/markets/page.tsx` (only if its copy names a removed role)
  - `tests/browser/spine.spec.ts` and `tests/browser/reveal.spec.ts` (only if the chapter count changes)
- Create: `tests/web-claims.test.ts`

**Interfaces:**
- Consumes: the `/advantages` route from Task 1.
- Produces: `tests/web-claims.test.ts`, which Tasks 3 and 6 keep passing.

**The how-it-works chapters.** Keep the five chapters, the spine, the illustrations and the worked example. Rewrite the copy, using the role pages in `apps/web/content/docs/` as the source of truth:
- **Define:** a creator agent stakes a bond and creates the market with a question class and spec bytes addressed by hash. A challenge window follows: any agent may challenge on `WRONG_CLASS`, `AMBIGUOUS` or `MANIPULABLE`. A creator agent may also claim a question suggested through the API.
- **Forecast:** forecaster agents sign forecasts inside sealed windows, and each window's Merkle root can be anchored by anyone. A window whose market already had a proposal at or before its deadline is marked contaminated automatically; it stays on record but earns no credit (`forecaster.md`). The consensus is weighted by track record, and it is not a price.
- **Quote:** a taker requests quotes through the RFQ relay. Any registered maker may answer with a signed quote. The taker verifies the quote before it fills on chain, and the platform cannot forge a quote.
- **Resolve:** a proposer submits the outcome with a bond. A challenger may dispute it, jurors vote by commit-reveal weighted by snapshot stake, and the losing side may appeal (`roles.md`). A market past its hard deadline becomes INVALID and pays 0.5 per share. A keeper triggers each permissionless step.
- **Evaluate:** the indexer rebuilds projections from events. Brier scores and per-role credit come only from final outcomes, and credit relaxes limits but cannot be transferred.

**The rest of the page:**
- Replace the lede and the v0.1 notice with one paragraph: the current design, local verification only, nothing deployed.
- "Out of scope" becomes the §3 non-goals:
  - deployment;
  - mainnet and real stablecoins, and real issuance of the platform token;
  - a human trading UI;
  - order book, AMM, partial fills, selling back, leverage and cross-chain;
  - a platform-paid model;
  - upgradeable contracts.

**The home page:**
- The hero states both positioning lines from `positioning.ts`: what Blink is for people, and what it is for agents.
- The "For agents" heading becomes "Reference agents for every role. One-command drill. API not deployed."
- Add a short section that links `/advantages`.
- The pillars stay unless they name a removed role.

- [ ] **Step 1: Write `tests/web-claims.test.ts`**

It reads every `.tsx` and `.ts` file under `apps/web/app`, `apps/web/components` and `apps/web/content`, excluding `content/docs`, which `agent-docs-coverage.test.ts` already covers.

```ts
const banned = [
  "platform forecaster", "two platform forecasters", "A human approves", "administrator creates",
  "allowlisted proposer", "designated arbiter", "private signer", "internal trader", "operator mandate",
  "reserved for the Blink team", "P3 and P4 rewrite", "describes the v0.1 design", "Permissionless market creation",
  "Operator working notes", "Research cost", "suggest a question", "start trading",
];
test("no site page describes a removed v0.1 role as current", () => {
  for (const file of siteFiles) for (const phrase of banned)
    assert.ok(!read(file).toLowerCase().includes(phrase.toLowerCase()), `${file}: "${phrase}"`);
});
test("the home page and the advantages page state both positioning lines", () => {
  // app/page.tsx and app/advantages/page.tsx both use FOR_AGENTS and FOR_PEOPLE from content/positioning.ts.
});
test("how it works states the trust claim with its condition", () => {
  // how-it-works/page.tsx includes "Under the publicly listed assumptions" and "/docs/trust".
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --import tsx --test tests/web-claims.test.ts`
Expected: FAIL on `how-it-works/page.tsx`, and on `sample-markets.ts` and the market detail page, which Task 3 fixes.

- [ ] **Step 3: Narrow the scope until Task 3**

Until Task 3 rewrites them, skip `content/sample-markets.ts` and `app/markets/[id]/page.tsx` with a `const pendingTask3 = [...]` list. Task 3 removes the list.

- [ ] **Step 4: Rewrite the copy**

Rewrite `how-it-works/page.tsx` and `page.tsx` as above.

- [ ] **Step 5: Run the local checks**

Run each once: `node --import tsx --test tests/web-claims.test.ts`, `pnpm typecheck`, `pnpm check`.
Expected: all pass.

- [ ] **Step 6: Update the P4 doc and commit**

Append `## Task 2` to `docs/P4_WEBSITE_VIDEO.md`.

```bash
git add apps/web/app/how-it-works/page.tsx apps/web/app/page.tsx tests/web-claims.test.ts docs/P4_WEBSITE_VIDEO.md
git commit -m "feat: rewrite how it works and the home page for the agent-only design"
```

### Task 3: Sample markets on the agent-only model

**Files:**
- Modify:
  - `apps/web/content/sample-markets.ts`
  - `apps/web/app/markets/[id]/page.tsx` and its CSS module
  - `apps/web/components/markets/ForecastChart.tsx`
  - `tests/web-sample-markets.test.ts`
  - `tests/browser/market-detail.spec.ts`
  - `tests/web-claims.test.ts` (remove `pendingTask3`)

**Interfaces:**
- `ForecastWindow` becomes `{ date: string; consensus: number; lastFill: number | null; forecasters: number }`.
  - `consensus`: the track-record-weighted consensus, in percent.
  - `lastFill`: the last fill price, in percent, or `null` when nothing filled in that window.
  - `forecasters`: the number of signed answers.
- `platformForecast(m)` is renamed `consensusForecast(m)`. Its callers and tests follow.
- `SampleMarket` loses `cost`, and the `PRIVATE` evidence visibility is removed.
- `SampleMarket` gains `reasoning: readonly { agent: string; probability: number; summary: string }[]`. `probability` is in percent.

**Rules:**
- The headline stat is labeled "Agent consensus · YES", with the sub-line "Track-record-weighted consensus of signed agent forecasts. Not a price." A separate stat, "Last fill", shows the price.
- The chart draws two series, consensus and last fill, in distinct line styles with a legend in text. Its `aria-label` and table name both. The tooltip shows "Consensus" and "Last fill".
- Delete the "Research cost" section: agents bring their own models, and the platform has no research budget (§3).
- Every lifecycle and resolution helper must describe the agent roles: a proposer bond, a challenge, a juror vote, a keeper. The 2-minute REPLAY window wording stays only if it matches the alpha params. Otherwise it says "challenge window (REPLAY parameters)".
- A "How agents reasoned" section lists two or three `reasoning` entries per market: the agent, its probability and a one- or two-sentence summary of its analysis. It has the sub-line "Sample reasoning. On a live market, each summary comes from the reasoning document that a forecast signs by hash." This is what a reader comes for (U19).
- The data stays fictional and REPLAY-only, with the existing "Sample data · REPLAY only" notice.

- [ ] **Step 1: Update the tests**

Update `tests/web-sample-markets.test.ts`:
- every window has `0 <= consensus <= 100`, `lastFill` null or in `0..100`, and an integer `forecasters >= 1`;
- no market has `cost`, and no evidence entry is `PRIVATE`;
- `chartAriaLabel` names "consensus" and "last fill";
- every market has two or three `reasoning` entries, each with `1 <= probability <= 99` and a non-empty `summary`.

Update `market-detail.spec.ts` so that the tooltip contains "Consensus" and "Last fill", and the "How agents reasoned" heading is visible.

- [ ] **Step 2: Run them and see them fail**

Run: `node --import tsx --test tests/web-sample-markets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite the data, helpers, page and chart**

Remove `pendingTask3` from `tests/web-claims.test.ts`.

- [ ] **Step 4: Run the local checks**

Run each once: `node --import tsx --test tests/web-sample-markets.test.ts tests/web-claims.test.ts`, `pnpm typecheck`, `pnpm check`.
Expected: all pass.

- [ ] **Step 5: Update the P4 doc and commit**

Append `## Task 3` to `docs/P4_WEBSITE_VIDEO.md`.

```bash
git add apps/web/content/sample-markets.ts "apps/web/app/markets/[id]" apps/web/components/markets/ForecastChart.tsx tests/web-sample-markets.test.ts tests/browser/market-detail.spec.ts tests/web-claims.test.ts docs/P4_WEBSITE_VIDEO.md
git commit -m "feat: show agent consensus and fill price on the sample markets"
```

### Task 4: The drill run record and the video script

**Files:**
- Create:
  - `scripts/video-capture.ts`
  - `video/src/run-record.ts` (the `RunRecord` type only; Task 5 builds on it)
  - `tests/video-capture.test.ts`
  - `video/data/drill-run.json`
  - `video/README.md`
  - `docs/INTRO_VIDEO_SCRIPT.md`
- Modify:
  - `package.json` (script `"video:capture": "node --import tsx scripts/video-capture.ts"`)
  - `docs/M5_DEMO_SCRIPT.md` (a first-line notice: superseded by `INTRO_VIDEO_SCRIPT.md`, kept as v0.1 history)

**Interfaces:**
- Produces, in `scripts/video-capture.ts`:
  - `export function buildRunRecord(report: unknown, logs: ReadonlyMap<string, string>, meta: { commit: string; capturedOn: string }): RunRecord`
- Produces, in `video/src/run-record.ts`: `export type RunRecord` (below). `scripts/video-capture.ts` imports it as a type. The video workspace never imports from `scripts/`.

```ts
export type RunRecord = {
  schema: "blink.video-run/1";
  source: "pnpm alpha:autonomous";
  commit: string;      // 40-hex commit the drill ran on
  capturedOn: string;  // YYYY-MM-DD
  chainId: 84532;
  durationSeconds: number;
  scenarios: readonly { name: string; status: "pass"; durationSeconds: number }[];
  roster: readonly { agent: string; roles: readonly string[] }[];
  events: readonly { t: number; agent: string; event: string; market?: string }[];
};
```

**Rules for `buildRunRecord`:**
- It throws `RUN_NOT_PASSED` unless `report.result === "pass"` and every scenario passed. §10 says the video is made after the drill passes.
- `logs` maps an agent name to the text of `tmp/alpha-autonomous/agents/<name>.log`. Lines that are not JSON are skipped.
- It keeps only these events: `registered`, `joined_role`, `juror_staked`, `market_created`, `challenged`, `suggestion_claimed`, `rfq_posted`, `quote_posted`, `filled`, `forecast_submitted`, `anchor`, `proposed`, `committed`, `revealed`, `appealed`, `distribute_fees`, `redeemed`, `claimed_rewards`.
- It keeps only these fields: `ts`, which becomes `t` (whole seconds since the earliest kept event); `agent`; `event`; and `marketId`, which becomes `market` (its first 10 characters).
- Events are sorted by `t`, then by agent name.
- The CLI reads `tmp/alpha-autonomous/`, takes `commit` from `git rev-parse HEAD` and `capturedOn` from today in UTC, and writes `video/data/drill-run.json` with a trailing newline.

**The script, `docs/INTRO_VIDEO_SCRIPT.md`.** It replaces the v0.1 "3-minute demo" positioning (§10). It targets about 2:30, at 1920×1080 and 30 fps.
- Scenes:
  1. the positioning: `FOR_PEOPLE` and `FOR_AGENTS`, verbatim (U19);
  2. how Blink differs, led by liquidity for long-tail questions (U20): Task 1's liquidity facts, then one resolution fact, each with its source named on screen, then Blink's RFQ;
  3. the run: the agents joining their roles, from `roster` and the `joined_role` events;
  4. the five scenarios, each with its real duration and its key events;
  5. the trust assumption, with the §5.12 wording;
  6. what is under construction, from Task 1's list;
  7. the close: `/llms.txt` and the site URL.
- Each scene lists its duration, its exact on-screen text (English) and its data source: a `drill-run.json` field, or "Illustration".
- A closing card says: "Data: a `pnpm alpha:autonomous` run on <capturedOn>, commit <first 7 characters>, local chain 84532. Not a public deployment."

**`video/README.md`:**
- what the workspace is, and that nothing depends on it;
- the license: the Free License applies to an individual or a for-profit organisation with up to 3 employees (user decision 2026-10-29), with https://github.com/remotion-dev/remotion/blob/main/LICENSE.md and "checked 2026-10-29";
- how to capture and how to render.

- [ ] **Step 1: Write `tests/video-capture.test.ts`**

```ts
test("capture keeps only whitelisted events and fields", () => {
  const logs = new Map([["maker-1", [
    JSON.stringify({ ts: "2026-11-01T00:00:10Z", agent: "maker-1", event: "quote_posted", marketId: "0xabcdef0123456789", rfqId: "r1", apiKey: "blink_sk_SECRET", key: "0x" + "11".repeat(32) }),
    JSON.stringify({ ts: "2026-11-01T00:00:05Z", agent: "maker-1", event: "api_key_issued", secret: "SECRET" }),
    "not json",
  ].join("\n")]]);
  const r = buildRunRecord(passingReport, logs, { commit: "a".repeat(40), capturedOn: "2026-11-01" });
  assert.deepEqual(r.events, [{ t: 0, agent: "maker-1", event: "quote_posted", market: "0xabcdef01" }]);
  assert.ok(!JSON.stringify(r).includes("SECRET") && !JSON.stringify(r).includes("11".repeat(32)));
});
test("capture refuses a failed drill", () => {
  assert.throws(() => buildRunRecord({ ...passingReport, result: "fail" }, new Map(), meta), /RUN_NOT_PASSED/);
});
test("events are ordered by time, then agent", () => { /* two agents, out-of-order lines */ });
```

`passingReport` has the shape of `scripts/alpha-autonomous.ts`'s `report.json`: `result: "pass"`, the five scenarios passing, and a roster.

- [ ] **Step 2: Run it and see it fail**

Run: `node --import tsx --test tests/video-capture.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `scripts/video-capture.ts`**

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/video-capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the drill and capture it**

Run `pnpm alpha:autonomous` from a clean tree, then `pnpm video:capture`.
Expected:
- the drill passes all five scenarios;
- `video/data/drill-run.json` holds the five scenarios with `status: "pass"`, at least 14 roster agents, and at least `market_created`, `challenged`, `filled`, `forecast_submitted`, `proposed`, `committed`, `revealed`, `appealed`, `suggestion_claimed` and `redeemed`;
- the report lists any of the 18 kept names that this run never logged.

- [ ] **Step 6: Write the docs**

Write `docs/INTRO_VIDEO_SCRIPT.md`, using the real durations from `drill-run.json`, and `video/README.md`. Add the notice to `docs/M5_DEMO_SCRIPT.md`.

- [ ] **Step 7: Run the local checks**

Run each once: `pnpm typecheck`, `pnpm check`.
Expected: both pass.

- [ ] **Step 8: Update the P4 doc and commit**

Append `## Task 4` to `docs/P4_WEBSITE_VIDEO.md`, with the drill result and the capture command.

```bash
git add scripts/video-capture.ts video/src/run-record.ts tests/video-capture.test.ts video/data/drill-run.json video/README.md docs/INTRO_VIDEO_SCRIPT.md docs/M5_DEMO_SCRIPT.md package.json docs/P4_WEBSITE_VIDEO.md
git commit -m "feat: capture a drill run record and write the introduction video script"
```

### Task 5: The Remotion workspace

**Files:**
- Create:
  - `video/package.json` (`@blink/video`, private)
  - `video/tsconfig.json`
  - `video/remotion.config.ts`
  - `video/src/index.ts` (`registerRoot`)
  - `video/src/Root.tsx`
  - `video/src/script.ts`
  - `video/src/timeline.ts`
  - `video/src/scenes/*.tsx`
  - `tests/video-timeline.test.ts`
- Modify:
  - `pnpm-workspace.yaml` (add `video`)
  - `package.json`:
    - `typecheck` adds `&& pnpm --filter @blink/video typecheck`;
    - scripts `"video:studio"`, `"video:render"` and `"video:still"`.
  - `scripts/check-boundaries.mjs`
  - `.gitignore` (Remotion's cache and output, if it writes outside `tmp/`)

**Interfaces:**
- Consumes: `video/data/drill-run.json` and `video/src/run-record.ts` (`RunRecord`, Task 4), and `docs/INTRO_VIDEO_SCRIPT.md`.
- Produces:
  - `export type Scene = { id: string; seconds: number; lines: readonly string[]; source: "drill-run" | "illustration" };`
  - `export const scenes: readonly Scene[];` in `video/src/script.ts`
  - `export function sceneFrames(scenes: readonly Scene[], fps: number): readonly { id: string; from: number; durationInFrames: number }[];` in `video/src/timeline.ts`
  - `export function scenarioCards(run: RunRecord): readonly { name: string; durationSeconds: number; events: readonly string[] }[];` in `video/src/timeline.ts`
  - The composition id `BlinkIntro`, at 1920×1080 and 30 fps.
  - `pnpm video:render` writes `tmp/video/blink-intro.mp4`.
  - `pnpm video:still` writes the poster, `tmp/video/blink-intro-poster.png`.

**Rules:**
- `remotion`, `@remotion/cli` and any other `@remotion/*` package use one exact version: the latest 4.x on npm that is at least two weeks old. `react` and `react-dom` match `apps/web` (19.3.0).
- `video/src` imports only `remotion`, `@remotion/*`, `react`, its own files and `../data/drill-run.json`. `scripts/check-boundaries.mjs` enforces two things:
  - no `package.json` under `apps/`, `packages/` or `examples/` depends on `@blink/video`;
  - no file under `video/src` imports from `apps/`, `packages/` or `examples/`.
- `script.ts`, `timeline.ts` and `run-record.ts` import no React and no Remotion, so that the root node tests can load them.
- Every on-screen line comes from `scenes` in `script.ts`, copied verbatim from `docs/INTRO_VIDEO_SCRIPT.md`. Every illustration scene shows the label "Illustration". The closing card's data line is built from `capturedOn`, `commit` and `chainId`.
- If Remotion has telemetry or update checks, `remotion.config.ts` turns them off, and `video/README.md` says how.
- The render settings are H.264 with a CRF that keeps the file at or under 25 MB. The chosen value goes in `video/README.md`.

- [ ] **Step 1: Write `tests/video-timeline.test.ts`**

```ts
test("scenes are contiguous and add up to the script's length", () => {
  const frames = sceneFrames(scenes, 30);
  frames.forEach((f, i) => assert.equal(f.from, i === 0 ? 0 : frames[i - 1]!.from + frames[i - 1]!.durationInFrames));
  const total = scenes.reduce((s, x) => s + x.seconds, 0);
  assert.ok(total >= 120 && total <= 180, String(total));
});
test("the first scene states both positioning lines", () => {
  assert.ok(scenes[0]!.lines.includes(FOR_PEOPLE) && scenes[0]!.lines.includes(FOR_AGENTS));
});
test("every on-screen line appears verbatim in the script doc", () => {
  const doc = readFileSync("docs/INTRO_VIDEO_SCRIPT.md", "utf8");
  for (const s of scenes) for (const line of s.lines) assert.ok(doc.includes(line), `${s.id}: ${line}`);
});
test("scenario cards come from the real run record", () => {
  const cards = scenarioCards(run);
  assert.deepEqual(cards.map((c) => c.name), run.scenarios.map((s) => s.name));
  for (const c of cards) assert.equal(c.durationSeconds, run.scenarios.find((s) => s.name === c.name)!.durationSeconds);
});
```

Add a boundary regression too: a temporary `apps/web` dependency on `@blink/video` makes `node scripts/check-boundaries.mjs` fail. Use the same style as the existing boundary checks: a fixture or an in-memory check, never a real edit left in the tree.

- [ ] **Step 2: Run it and see it fail**

Run: `node --import tsx --test tests/video-timeline.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create the workspace**

Then run `pnpm install`, and check that `pnpm-lock.yaml` still has one `react` 19.3.0 and that `apps/web` is unaffected (`pnpm why react` from the root).

- [ ] **Step 4: Write the code**

Write `script.ts` from the doc, `timeline.ts`, `Root.tsx` and the scenes.

- [ ] **Step 5: Run the local checks**

Run each once: `node --import tsx --test tests/video-timeline.test.ts`, `pnpm typecheck`, `pnpm check:boundaries`, `pnpm check`.
Expected: all pass.

- [ ] **Step 6: Render a still**

Run `pnpm video:still`. If the host cannot run it, use the container command in `video/README.md`. If the implementer's sandbox has no network, the report says so and the controller renders.
Expected: a 1920×1080 PNG.

- [ ] **Step 7: Update the P4 doc and commit**

Append `## Task 5` to `docs/P4_WEBSITE_VIDEO.md`.

```bash
git add video pnpm-workspace.yaml package.json pnpm-lock.yaml scripts/check-boundaries.mjs tests/video-timeline.test.ts .gitignore docs/P4_WEBSITE_VIDEO.md
git commit -m "feat: add the Remotion workspace for the introduction video"
```

### Task 6: Render, embed and close P4

**Controller step before dispatch:** from the merged Task 5, run `pnpm video:render` and `pnpm video:still`, on the host or in the container.
- Render one still at the middle frame of every scene, with `remotion still --frame`, from the `sceneFrames` output. Check each still against `docs/INTRO_VIDEO_SCRIPT.md`: its text, its "Illustration" label where one is required, and the closing data line.
- Check the MP4's duration and size with `ffprobe`.
- Hand the implementer the two output paths.

**Files:**
- Create:
  - `apps/web/public/video/blink-intro.mp4`
  - `apps/web/public/video/blink-intro-poster.png`
  - `apps/web/content/intro-video.ts` (the transcript: one entry per scene, with its `lines`)
  - `apps/web/components/home/IntroVideo.tsx`
  - `tests/web-intro-video.test.ts`
- Modify:
  - `apps/web/app/page.tsx` (a "Watch" section after the hero)
  - `apps/web/content/advantages.ts` (`introduction-video` → implemented, with evidence `apps/web/public/video/blink-intro.mp4` and `tests/web-intro-video.test.ts`)
  - `tests/web-advantages.test.ts` (the new status)
  - `tests/browser/advantages.spec.ts` (counts 9 and 3)
  - `tests/browser/home.spec.ts`
  - `scripts/check-pages-export.mjs` (`KEY_FILES` gains `video/blink-intro.mp4` and `video/blink-intro-poster.png`)
  - `README.md` and `README.zh-TW.md`
  - `docs/ROADMAP.md`
  - `docs/M4_WEB_SHOWCASE_DELIVERY.md` (a dated note pointing to the P4 doc)
  - `docs/P4_WEBSITE_VIDEO.md`

**Rules:**
- `IntroVideo` renders:
  - `<video controls preload="none" playsInline poster={withBase(...)} width={1920} height={1080}>`, scaled by CSS to the container width, with no autoplay and no loop;
  - a `<details>` transcript built from `apps/web/content/intro-video.ts`;
  - the closing data line as text: the run date, the commit and "local chain 84532, not a public deployment".
- `intro-video.ts` is a copy of `video/src/script.ts`'s `scenes`, because the web may not import the video workspace. `tests/web-intro-video.test.ts` imports both and asserts that they are equal, so the two cannot drift.
- ROADMAP: tick both P4 items, with the date and the P4 doc link. Note that deployment is reassessed next (§11).
- README, in both languages: open with the positioning (the two lines; `README.zh-TW.md` translates them), replace every "P4 … Neither is done" claim with what is now true, and mention the advantages page and the video.

- [ ] **Step 1: Write `tests/web-intro-video.test.ts`**

```ts
test("the committed video is at most 25 MB and has a poster", () => {
  assert.ok(statSync("apps/web/public/video/blink-intro.mp4").size <= 25 * 1024 * 1024);
  assert.ok(statSync("apps/web/public/video/blink-intro-poster.png").size > 0);
});
test("the site transcript matches the video script", () => {
  assert.deepEqual(introVideoTranscript.map((s) => [s.id, s.lines]), scenes.map((s) => [s.id, s.lines]));
});
```

In `home.spec.ts`:

```ts
test("intro video has controls, a poster, no autoplay, a transcript, and fits a phone", async ({ page, request }) => {
  await page.goto("./");
  const video = page.locator("video");
  await expect(video).toHaveAttribute("controls", "");
  expect(await video.getAttribute("autoplay")).toBeNull();
  const src = await video.evaluate((v: HTMLVideoElement) => v.currentSrc || v.querySelector("source")?.src || v.src);
  expect((await request.get(src)).status()).toBe(200);
  const box = await video.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.getByText("Transcript")).toBeVisible();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --import tsx --test tests/web-intro-video.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Copy the files, then write the component, the section, the status change and the docs.

- [ ] **Step 4: Run the local checks**

Run each once: `node --import tsx --test tests/web-intro-video.test.ts tests/web-advantages.test.ts`, `pnpm typecheck`, `pnpm check`.
Expected: all pass. The browser and Pages checks, including the video `src` returning 200 under `/blinkmarket`, run in branch CI.

- [ ] **Step 5: Close the P4 doc**

Append `## Task 6` and `## Final state` to `docs/P4_WEBSITE_VIDEO.md`:
- what is implemented;
- what is under construction;
- the drill run behind the video;
- known limitations: the 25 MB video in git history; the sealed-window and anchoring limits; the open U17 question.

- [ ] **Step 6: Commit**

```bash
git add apps/web/public/video apps/web/content/intro-video.ts apps/web/components/home/IntroVideo.tsx apps/web/app/page.tsx apps/web/content/advantages.ts tests/web-intro-video.test.ts tests/web-advantages.test.ts tests/browser/advantages.spec.ts tests/browser/home.spec.ts scripts/check-pages-export.mjs README.md README.zh-TW.md docs/ROADMAP.md docs/M4_WEB_SHOWCASE_DELIVERY.md docs/P4_WEBSITE_VIDEO.md
git commit -m "feat: embed the introduction video and close P4"
```

---

## Comparison facts

Copy these verbatim into `comparison` (Task 1). Every fact has `checkedOn: "2026-10-29"`, except the custody facts, which have `checkedOn: "2026-10-30"`. The topic of each is its heading. Source: the controller's research report of 2026-10-29. It keeps only facts with a primary source that no other note contradicts.

### market-creation

- **Polymarket:** "Polymarket's markets team creates markets with input from users and the community; users cannot create markets directly but can suggest them by posting on X."
  https://help.polymarket.com/en/articles/13364541-how-are-markets-created
- **Polymarket US:** "Polymarket US says its Markets Team evaluates trending topics, reliable data sources and user suggestions to decide which events to list, and reviews all markets before launch."
  https://docs.polymarket.us/learn/markets/how-markets-are-created.md
- **Limitless (Base):** "Limitless lets users create custom markets with a title, two outcomes, resolution criteria and end time; these markets are unlisted and can be reached through the link the creator shares."
  https://docs.limitless.exchange/user-guide/custom-markets.md
- **Seer:** "Seer lets users create a market by entering a question, outcomes and opening date; verification through a Kleros Curate list is optional, and unverified markets show a warning."
  https://docs.seer.pm/app/create-a-market.md

### resolution

- **Polymarket:** "Polymarket resolves markets other than crypto up/down through UMA's Optimistic Oracle: a proposer posts a bond, typically $750 pUSD, and a 2-hour challenge period follows."
  https://docs.polymarket.com/concepts/resolution.md
- **Kalshi:** "Kalshi's API documents market statuses determined, disputed, amended and finalized, and a determined result can be disputed while the settlement timer runs."
  https://docs.kalshi.com/getting_started/market_lifecycle.md
- **UMA:** "UMA settles escalated disputes by a vote of staked UMA holders; resolution needs at least 65% of staked UMA on one outcome, and wrong or missed votes are slashed."
  https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work.md
- **Kleros:** "Kleros draws jurors in proportion to staked PNK, jurors vote by commit-reveal, and each appeal roughly doubles the jury size."
  https://docs.kleros.io/concepts/game-theory.md
- **Limitless (Base):** "On Limitless custom markets the creator's wallet reports the outcome, and Limitless states it does not judge outcomes or handle disputes."
  https://docs.limitless.exchange/user-guide/custom-markets.md

### liquidity

- **Polymarket:** "Polymarket's documentation describes trading on a peer-to-peer central limit order book where users trade directly with other users, not against the house."
  https://docs.polymarket.com/polymarket-101.md
- **Kalshi:** "KalshiEX filed a CFTC amendment renaming its Liquidity Provider Program the Designated Liquidity Provider program, aimed at increasing volume and liquidity on its central limit order book."
  https://www.cftc.gov/filings/orgrules/rules10182634499.pdf
- **Limitless (Base):** "On a Limitless custom market, the creator funds the pool and is the sole liquidity provider."
  https://docs.limitless.exchange/user-guide/custom-markets.md

### agents

- **Kalshi:** "Kalshi's changelog states registered MCP clients can read portfolio balances, positions, orders and fills with a read grant, and these grants do not allow order execution."
  https://docs.kalshi.com/changelog.md
- **Limitless (Base):** "Limitless offers an official MCP server where every new order requires browser approval, the OAuth scope is limited to trading, and there is no withdraw tool."
  https://docs.limitless.exchange/developers/mcp-server.md
- **Olas Predict:** "Olas Predict describes four agent roles (market creator, trader, prediction broker and closer), with agents trading Omen markets on Gnosis Chain and Polymarket markets on Polygon."
  https://olas.network/agent-economies/predict

### custody

- **Polymarket:** "Polymarket orders are EIP-712 messages that the user signs with a private key; the signature lets the settlement contract execute the trade without taking custody of the user's funds, and the CLOB operator submits matched trades to the chain."
  https://docs.polymarket.com/concepts/order-lifecycle.md
- **Kalshi:** "Kalshi describes segregation of customer funds under CFTC oversight, and states that its clearinghouse, Kalshi Klear, handles all settlement."
  https://news.kalshi.com/p/kalshi-fully-regulated-trustworthy-not-a-scam

The page shows `platform` as written in bold above. UMA and Kleros are listed as the resolution layers that other markets use, not as markets.
