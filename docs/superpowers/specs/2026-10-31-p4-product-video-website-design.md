# P4 rework: a product video and a product-showcase website

Date: 2026-10-31. Status: draft for the user's approval.

This design reworks part of P4 (plan `docs/superpowers/plans/2026-10-29-p4-website-video.md`, merged to main as `211f43f`). It replaces the introduction video and changes how the website presents Blink. It amends spec `2026-10-23-autonomous-market-design.md` §9, §10 and the comparison clause of U22 (see §6).

Companion file: `docs/superpowers/specs/2026-10-31-intro-video-animatic.html`, a playable animatic the user approved as the basis of the video. Open it in a browser and press **Sound on**.

## 1. Why

On 2026-10-31 the user reviewed the merged P4 work and rejected its direction:

- The video explained the project: how Blink was built and tested, with data from the drill on screen. The user wants it to introduce the product instead. It should show what Blink is, what is special about it, what it helps with, and what is cool and fun about it. Lively animation should hold attention. Technical detail and text that must be read are out.
- The website labelled each advantage "implemented" or "under construction" and compared Blink with other markets. The user wants a product showcase, not a progress tracker. It should show only Blink's own advantages, because comparisons "read like criticizing others".
- The website gave the video its own "Watch" section with a transcript, and gave the advantages their own page. The user wants the video placed naturally in the page, with no transcript. The advantages should continue the home page's story.

## 2. Goals, non-goals, anti-goals

Goals

- G1. Make a video of about one minute that a first-time viewer understands without reading. It should leave three things: Blink is a market run entirely by AI agents, like a society where every agent has a job; the agents keep each other honest; people simply read the forecasts and the reasons behind them, for free.
- G2. Present Blink as a product on the home page. The hero comes first, the video sits in the page's flow, and the story continues into Blink's advantages.
- G3. Remove from the showcase pages the status labels, the comparisons, the advantages page, the Watch section and the transcript. Also remove the drill-capture pipeline that only the old video needed.

Non-goals

- Deployment and new protocol features.
- Changes to `/docs` content. Those pages are agent documentation and keep their operational facts. The only exception is removing links to `/advantages`.
- A vertical or social cut, a voice-over, or a subtitle track.
- The automatic `OUTCOME_ALREADY_PUBLIC` path. That is still an open user decision.

Anti-goals: any of these makes the work a failure, even if it renders and the tests pass.

- The video needs reading, or it explains internals such as contracts, Merkle roots, parameters or test counts.
- The video or the site claims something the protocol does not do (spec §3). Examples:
  - an agent sells a position;
  - a new market shows a probability;
  - "thousands of agents";
  - round-the-clock operation.
- Another platform is named, compared with, or its incidents mentioned, on the site or in the video.
- People are invited to trade, take a role, sign, connect a wallet, sign up or suggest a question (U19, U21).
- Progress language on the showcase pages, such as "implemented", "under construction", "nothing deployed" or "API not deployed".

## 3. Constraints carried over

- **Truthfulness (spec §3).** Every claim must match what the code does.
- **Positioning (U19).** The positioning lines `FOR_AGENTS` and `FOR_PEOPLE` stay in the home hero.
- **Liquidity leads (U20).** RFQ long-tail liquidity is the first advantage.
- **No suggestion form (U21).** The site builds none and invites no suggestion. The platform token no longer appears on the showcase pages: it was only an under-construction item, and status items are removed.
- **Smaller attack surface (U22).** It stays a headline advantage. U22's comparison clause is superseded (§6).
- **Remotion.** Remotion 4.0.536 stays pinned under the Free License (user decision 2026-10-29). The `video/` workspace stays separate, and neither the website nor the services depend on it.
- **Rendering.** Renders run in the `node:22.23.1-bookworm-slim` container described in `video/README.md`, because the host has glibc 2.28. CI never renders.
- **Language.** Site copy is in English and `README.zh-TW.md` stays in Traditional Chinese. Internal docs are in English.
- **Process (`AGENTS.md`).** Commit and push each verified stage. `pnpm build` runs in CI.

## 4. The video (decided)

The final video follows the animatic's structure, shot timing, copy and motion. It may be smoother and more polished, but not different. Where this section and the animatic disagree, this section wins: it carries corrections made after the user's review: the trader lines, the new market's probability, and shot 4's staging.

### 4.1 Look and feel

The user decided all of the following during brainstorming.

- **Characters.** Every agent is a minimal flat character: a solid rounded square with two white vertical-bar eyes and no outline. Motion gives it personality: a spring pop-in with overshoot, a hop with squash and stretch, a sway, a blink. It is deliberately not a hexagon, the shape of the reference video's brand.
- **Role looks.** Each role has one colour and one small accessory (table below).
- **Type.** Geist semibold with tight tracking, in sentence case.
  - Words pop in one at a time, out of a blur.
  - Lines swap in place on the beat.
  - One phrase per line is the accent: terracotta, with a hand-drawn underline.
  - There are no eyebrow labels or pills; the user removed them.
- **Transitions.** Bouncy: spring pop-ins, whip pans with motion blur, and zooms through and out.
- **Product screens.** Browser windows and a phone show Blink's website: the market list, a market page with its probability chart, agents' opinions and sources. They are redrawn in the video, not screenshots. They sit on flowing colour-gradient panels inside a hand-drawn outline frame.
- **Palette.**

  | Colour | Hex |
  | --- | --- |
  | Paper (background) | #f4f1ea |
  | Ink | #1d1c1a |
  | Cobalt | #2148b8 |
  | Terracotta | #d4562f |
  | Mustard | #e3a62a |
  | Green | #2f9e6e |
  | Violet | #7a5cd6 |
  | Sky | #2f9fd0 |
  | Pink | #e0679a |

- **Ending.**
  1. The eye emblem springs in. It is the same drawing as `apps/web/app/icon.svg` and the eye in `SiteHeader.tsx`.
  2. The letters of "Blink" pop in to its right, like the site header's wordmark.
  3. The eye blinks twice, once on each note of the sound logo.

  There is no URL.
- **Format.** 1920×1080, 30 fps, about 58.5 s, H.264 video with AAC audio.

| Role | Colour | Accessory | Montage line | Action |
| --- | --- | --- | --- | --- |
| creator | cobalt | antenna with a mustard bulb | Creators ask the questions. | pulls out a question card stamped BOND |
| maker | violet | wider body, two stacked bars above | Makers quote the prices. | gets "Quote?", answers with a signed price tag "YES 0.62" |
| trader | terracotta | round body, a coin | Traders take a side. | picks YES over NO |
| forecaster | sky | white goggles around the eyes | Forecasters sign a probability. | writes 63% and a few lines of reasoning |
| proposer | ink | small terracotta flag | Proposers report what happened. | shows "Result: NO" with evidence attached |
| challenger | mustard | slanted eyes and a terracotta "!" | Challengers call it out. | a big "!", and it shakes |
| juror | green | black cap | Jurors vote in secret. | three sealed envelopes flip to ✓ |
| keeper | pink | small clock on its head | Keepers keep the clock. | clock hand sweeps, then a status chip turns PROPOSED → FINAL ✓ |

Each montage line was checked against `apps/web/content/docs/roles.md`:

- **Jurors.** They vote by commit and reveal, so a vote is hidden until it is revealed.
- **Keepers.** They call the transitions that fall due after a deadline.

### 4.2 Shot list

Times are in seconds. Every shot starts on a beat of a 120 BPM grid.

| # | Time | On screen | Copy | Sound |
| --- | --- | --- | --- | --- |
| 1 | 0–4 | The words pop in, and a creator springs up beside them. | "A market run entirely by AI agents." (accent: "AI agents.") | intro groove (pluck and hats); a tick per word; a pop |
| 2 | 4–18 | Job montage: from 4.5 s each role holds the stage for 1.5 s, does its job next to its line, then a small copy joins a line-up along the bottom. At 16.5 s: "Everyone has a job." | the eight lines in §4.1, then "Everyone has a job." (accent: "job.") | drums enter; each role pops at its own pitch; one effect per role (card flip and ding; stamp; coin; scribble and chord; flag; two-tone buzz; envelopes, flips and gavel; clock ticks, ding and button) |
| 3 | 18–22.5 | Market list in a browser on a gradient panel. A creator sitting on the window's top edge says "New question!", and the new market slides in at the top, marked NEW and showing "—". | "One question goes live." (accent: "goes live.") | whoosh; pops; ding |
| 4 | 22.5–27.5 | Market page: forecasters toss signed probability notes into the chart, and the agent consensus counts up from 41% to 63% while the chart draws. The counter carries the site's small label "Agent consensus". Beside the window, traders say "Buy YES!" and "Buy NO." to a maker quoting "0.63", and coins pass only between them, never into the chart. | "They forecast." → "They trade." → "On what they believe." (accent: "believe.") | whoosh; a pop per note; rising blips; a sweep; coins |
| 5 | 27.5–34.5 | Dispute (see the steps below this table). | "And keep each other honest." → "Lies cost a bond." | gavel; a falling tone; success arpeggio; coin cascade |
| 6 | 34.5–38 | One big centred line; the agents peek up from the bottom edge and look at it. | "What about you, human?" (accent: "human?") | the music stops half a second in, as "human?" lands |
| 7 | 38–50 | Browsing (see the steps below this table). | "Scroll through the future." → "Tap one." → "Watch the odds move." → "Read why." → "Check the sources." | a lighter groove; scroll ticks; a click; a pop; three rising notes; flips; a whoosh |
| 8 | 50–53 | Three phrases pop in. | "No sign-up. No wallet. Free to read." (accent: "Free to read.") | three pops; an underline |
| 9 | 53–58.5 | Ending (see the steps below this table). | no copy beyond the wordmark | a shimmer; five rising notes for the letters; the two-note sound logo on the two blinks; then silence |

Shot 5, the dispute:

1. The proposer says "Answer: no."
2. The challenger says "I challenge that!" and shakes.
3. Three jurors each show ✓.
4. The proposer shrinks and turns grey, and a toast reads "Challenge upheld · answer corrected".
5. Coins fly from the proposer to the challenger and the jurors.

Shot 7, browsing. A browser sits on a gradient panel.

1. The market list scrolls. Each card shows its probability and a sparkline.
2. The cursor taps the rain market, and its page opens.
3. The chart draws.
4. Three forecaster opinions slide in, each with its agent, a one-line reason and a probability.
5. Two sources slide in.
6. A phone slides in, showing the same market.

Shot 9, the ending:

1. The eight agents line up and blink twice together.
2. They gather at the centre.
3. The eye emblem springs in.
4. "Blink" pops in letter by letter.
5. The eye blinks twice.

Content: the final video uses the animatic's questions, probabilities, reasons and sources. The one question that runs through shots 3, 4 and 7 is "Will it rain in Taipei on New Year's Eve?". A replacement must stay neutral: no real person, nothing harmful, and nothing in a banned category.

Truthfulness rules for the video copy. A test enforces them on the script data, and they are why the animatic's "Buy!"/"Sell." and "50%" were corrected.

- The market's headline number is the agent consensus of signed forecasts, not a price. Only forecasters move it; trades never do (user decision, 2026-11-01). This is why shot 4 departs from the animatic.
- Traders only buy YES or buy NO. Nobody sells, and positions are held to settlement.
- A market that has just gone live shows no probability.
- No other platform's name, no count of agents, no uptime claim.
- No invitation to sign up, connect a wallet, trade, take a role or suggest a question.

### 4.3 Sound

All of these were decided by the user ("你的想法都採用", 2026-10-31).

- **Music.**
  - **The track.** A royalty-free track whose licence allows commercial use without attribution, for example under the Pixabay Content License. It should be about 120 BPM, light and playful (plucked or marimba-like over a soft beat), and at least 60 s long.
  - **Choosing it.** The builder shortlists three candidates at 115–125 BPM with links to their licences, and the user picks one by ear. If the chosen track is not 120 BPM, the shot boundaries are scaled to its beat, and the total length may move within 55–62 s *(my call)*.
  - **Recording it.** The repo is public, so candidates should be CC0 or public domain, which allows the file itself to be committed under `video/public/music/` *(my call)*. A track under a licence that forbids redistributing the file on its own, such as the Pixabay Content License, stays out of git. Its path is git-ignored, and `video/README.md` gives its download page and SHA-256 so a render can fetch the same file. Either way, the source page, licence page and check date go into `video/README.md`.
  - **While the pick is pending.** Everything else is built and committed with a silent music bed. Only the final render waits for the pick *(my call)*.
- **Music shape.**
  - Shot 1: no drums.
  - Shots 2–5: the full groove.
  - Shot 6: the music stops on "human?".
  - Shots 7–8: a lighter groove.
  - Shot 9: silence under the ending, apart from the logo sounds.
- **Effects.**
  - **Making them.** A deterministic script in the `video/` workspace synthesises the effects into WAV files committed under `video/public/sfx/`. There are no third-party samples, so the effects are fully owned and need no network to render.
  - **Where they go.** Their placement follows §4.2 and the animatic's effect table.
  - **Role pops.** Each role has one pitch, used for all its pops.
  - **Sound logo.** Two notes, G5 and then D6, a third of a second apart, on the eye's two blinks.
- **No voice-over.**

### 4.4 Production

- **The composition.**
  - Rewrite the Remotion composition `BlinkIntro` in `video/` to this script.
  - Replace `video/src/script.ts` and `video/src/scenes/`.
  - Remove `video/src/run-record.ts`, `video/src/timeline.ts` and `video/data/drill-run.json`.
- **The capture pipeline.**
  - Remove `scripts/video-capture.ts`, the `video:capture` script, `tests/video-capture.test.ts` and `tests/video-timeline.test.ts`.
  - The new video needs no drill data, and spec §10's footage requirement is amended (§6).
- **Rendering.** Render in the container as `video/README.md` describes. Ship `apps/web/public/video/blink-intro.mp4`, now with audio, and a new poster. The poster is the montage line-up under "Everyone has a job.", or another frame that reads without motion.
- **Size.** Aim for an MP4 of 8 MB or less, with 15 MB as the hard cap *(my call)*. It is served by GitHub Pages and loads only when played. Keep 1080p at 30 fps. To meet the cap, tune the encoder first (CRF, preset, tune), then simplify the moving gradient layers. Never lower the resolution or frame rate.
- **No "example" tag in the video** *(my call)*. The video is an animation of how Blink works, not a record of live markets, and a tag would add text to read. The site's sample-data labels stay next to the real sample markets.
- **Checks before review.** The controller looks at a still from every shot and listens to the full render. Reviewers get the stills.

## 5. The website

### 5.1 Home page

The user decided that:

- there is no Watch section and no transcript;
- the advantages continue the home page's story;
- the site shows only Blink's own advantages;
- there are no status labels.

The order below and the items marked *(my call)* were decided during the write-up. Each is listed in §9.

1. **Hero.**
   - The positioning lines stay unchanged.
   - The status line drops "Nothing deployed" and becomes "Base Sepolia testnet · No trading here".
2. **The video**, as the next block after `Hero`, in the place `IntroVideo` holds today *(my call)*. `Hero` and its trail band stay as they are, and `Aperture` follows the video.
   - There is no heading, eyebrow, data line or transcript around it.
   - Markup: `<video controls preload="none" poster=…>`, with an `aria-label` that says what it shows. For example: "Blink introduction, about one minute, with music: AI agents with different jobs run a prediction market, and people read the forecasts."
   - It does not autoplay *(my call)*. It has sound, and people who prefer reduced motion or are saving data choose when to play it.
3. **What Blink is** (the pillars). "Nothing is deployed yet." is removed.
4. **Advantages**, as the next part of the same page. There is no separate page and nothing is compared.
   - **Order.**
     1. RFQ liquidity for long-tail questions (U20 leads).
     2. No custody, and a website that cannot move funds (U22).
     3. Every role is an agent, with layered settlement and per-role credit.
     4. Readable reasoning behind every forecast.
     5. A verifiable loop from raw data to score.
     6. Protection against forecast contamination.
     7. Research probability shown apart from price.
     8. Safety boundaries for autonomous agents.
   - **Content.** Each advantage gets its title, a one-sentence summary, at most two short points, and a link to its docs page.
   - **Left out of the home page.** Statuses, evidence paths and limits blocks.
   - **Limits** live in the linked docs page *(my call)*. The builder checks that each current limit is stated in its docs page and adds it there if it is missing. This also covers the contamination limit from the P4 final review (§7).
   - **Copy.** The builder may tighten the copy within §2 and §3.
5. **Sample markets.** The existing sample notices stay *(my call)*. They are honesty about the data, as spec §10 requires labelling, not progress.
6. **The loop.** Unchanged.
7. **For agents.** The heading drops "API not deployed.".

### 5.2 Removed

- **The advantages page.** The `/advantages` page and its link in `SiteHeader`.
- **Comparison and status data in `content/advantages.ts`.**
  - The comparison data: `ComparisonTopic`, `ComparisonFact` and the comparison list.
  - `STATUS_LABEL` and the `status` field.
  - Four items: the three under-construction ones (public deployment, banned questions, platform token) and the "introduction video" item.
  - The evidence paths may stay in the data, unrendered, so a test keeps every advantage backed *(my call)*.
- **The old video section.** `IntroVideo`'s section heading, data line and transcript, and the transcript in `content/intro-video.ts`.
- **Progress phrases** on the showcase pages and in the footer *(my call: every statement about deployment or verification state counts)*:
  - home: "Nothing is deployed yet." in the pillars, and "API not deployed." in the For-agents heading;
  - footer: "Nothing deployed";
  - how-it-works: "The current design has been verified locally only; nothing is deployed." (line 66), and the caption "Current architecture, not yet deployed · Local verification only" (line 88), which keeps only "Read-only site";
  - markets list: "No live markets exist yet: nothing is deployed, and no markets have been created." The sentence that follows, about what the REPLAY samples show, stays;
  - advantages content: "Implemented means …".
- **What stays.** The network and safety facts stay *(my call)*: "Base Sepolia testnet", "Test assets have no value" and "No trading on this site". They are disclosures, not progress.
- **Docs pages.** `/docs` pages change only where they link to `/advantages` *(my call)*.
- **Old links.** No redirect for `/advantages`. It was public for about a day, and the site's 404 page covers it.

### 5.3 Guards

- **Claims scan.** It covers the home page, how-it-works, the markets pages, the header, the footer, the advantages content and the video's `script.ts`.
  - It bans the platform names the old comparisons used (Polymarket, Kalshi, Limitless, Seer, Olas, UMA, Kleros), plus Manifold and Augur.
  - It bans status phrases: "under construction", any form of "deployed", "verified locally", "local verification", and "implemented" used as a label.
  - It bans "sell" in the video copy.
  - It keeps today's banned phrases.
  - It states in the test why `content/docs` is not scanned.
- **Invitation guard** (carried from the P4 final review).
  - A form-element scan for `<form`, `<input`, `<textarea`, `<select` and `onSubmit` over `apps/web/app` and `apps/web/components`. An existing element, such as a docs search box, may be allow-listed with a reason.
  - A small invitation regex: `connect (your )?wallet`, `sign (up|in)`, `join (as|the)`.
- **Boundary guard** (carried). Nothing under `apps/` or `packages/` may import a path inside `video/`, and the boundary self-test gets a case for it.
- **Browser specs.**
  - The home page shows the video inline with controls and a poster. It has an `aria-label`, does not autoplay, and has no transcript.
  - `/advantages` is gone from the navigation and the route checks.
  - The 375 px layouts hold.
  - `scripts/check-pages-export.mjs` drops `advantages/index.html` from its key files.

## 6. Spec and document changes

The spec changes below (decision rows, §9, §10) were applied in the same commit as this design. The remaining items are work for the plan.

- **Spec decision rows.** Add two rows.
  - **U23** (2026-10-31): "The introduction video introduces the product, not the project. It shows what Blink is, what is special, who it helps and what is fun about it, through lively animation: minimal role characters, kinetic type, bouncy transitions, music and sound effects. It avoids technical detail and text to read. It needs no drill footage. It ends on the eye emblem and the name Blink, with no URL."
  - **U24** (2026-10-31): "The website is a product showcase, not a progress tracker. It shows no implemented or under-construction labels. It makes no comparison with other platforms and shows only Blink's own advantages. There is no standalone advantages page: the advantages continue the home page's story. The video sits inline in the page, with no Watch section and no transcript. U24 supersedes U22's comparison clause and the status and comparison rules of §9."
- **Spec §9.**
  - Replace the paragraph "Mark each item …" with: the advantages are part of the home page, show only implemented capabilities, carry no status label, and name no other platform.
  - Keep the list of advantages and the U19 and U20 sentences.
- **Spec §10.**
  - Replace "explaining the vision, the differences from other markets, and the fully automatic flow" with "introducing the product (U23)".
  - Replace the footage requirement with: the video is animation; placeholder questions and probabilities must stay plausible and truthful to the protocol; the music track's licence is recorded in `video/README.md`.
  - Keep the Remotion, workspace and licence bullets.
- **Script document.** `docs/INTRO_VIDEO_SCRIPT.md` is rewritten to §4.2.
- **Delivery record.** `docs/P4_WEBSITE_VIDEO.md` records the rework and the final state. Its verification record names the CI runs and the final `pnpm check` count, which carries P4 final-review Minor 5.
- **Other docs.** `README.md`, `README.zh-TW.md`, `docs/ROADMAP.md` and `docs/ARCHITECTURE.md` drop the advantages page and the comparisons, and describe the video as a product introduction.
- **Plan.** A new implementation plan covers this rework. Tasks 1, 5 and 6 of the old P4 plan are superseded where this design changes them.

## 7. The P4 final review (Sonnet, 2026-10-31): what happens to each finding

The review covered `74c57e5..211f43f` and is held in the P4 SDD workspace.

| Finding | Outcome |
| --- | --- |
| Important 1: scenario-to-market mapping unguarded | Moot. The run record and timeline are removed. |
| Important 2: no source-import guard from the web into `video/` | Carried (§5.3). |
| Important 3: guards only match literal phrases; no form-element scan | Carried (§5.3). |
| Minor 1: Kalshi custody fact | Moot. Comparisons are removed. |
| Minor 2: the contamination limit does not say what goes undetected | Carried into `/docs/forecaster` (§5.1). |
| Minor 3: the chart's label lost its values | Carried. Restore "rises from X% to Y%" in `chartAriaLabel`. |
| Minor 4: an isolated fill draws no mark | Parked. There are no real fills yet. |
| Minor 5: the P4 doc has no verification record | Carried (§6). |
| Minor 6: terse Watch heading | Moot. The Watch section is removed. |
| Minor 7: stray blank line in `markets/[id]/page.module.css` | Carried, if the file is touched. |
| Minor 8: the facts row is tight at 861–1000 px | Carried. Check it at 900 px in the browser specs. |
| Declined: the token item linked to `/docs/trust` | Moot. The token item is removed. |
| Declined: `content/docs` still documents human suggestions | Stays. U9 stays as built, and docs are agent documentation. |

## 8. Left to the builder

- Animation curves and frame timing inside a shot. Shot boundaries stay on the beat grid.
- The structure of the Remotion components.
- How the effects script synthesises each sound. Keep the sounds close to the animatic's.
- The poster frame, within §4.4.
- The exact advantage summaries, within §2 and §3.
- The layout and CSS of the inline video and the advantage blocks, in the site's existing style.
- Test names, and how the guards are split across test files.

## 9. Calls made in the write-up (for the user to check)

1. The video does not autoplay on the home page. It is the next block after the hero, where `IntroVideo` is today, with a poster and controls.
2. The hero keeps "Base Sepolia testnet · No trading here", and the footer keeps its testnet and test-asset disclosures. Every statement about deployment or local verification is removed, including those on how-it-works and the markets list.
3. The sample-market notices stay, as data honesty.
4. Advantage limits move to the linked docs pages. The home page shows title, summary, at most two points and a docs link.
5. Advantage evidence paths stay in the data, unrendered, so a test keeps every advantage backed by real files.
6. `/docs` content is untouched apart from links to `/advantages`, and `/advantages` gets no redirect.
7. The trader lines are "Buy YES!" and "Buy NO.", and the new market shows "—". This corrects the animatic, because positions cannot be sold and a new market has no probability yet.
8. The drill-capture pipeline and its tests are deleted, not kept unused.
9. The effects are synthesised in-repo. The music is chosen by the user from three candidates at 115–125 BPM, preferably CC0 or public domain so the file can be committed. A non-120 track rescales the shots, and the total length may move within 55–62 s. Everything except the final render is built with a silent bed while the pick is pending.
10. The MP4 aims for 8 MB, with a hard cap of 15 MB, and stays at 1080p and 30 fps.
11. The video carries no "example data" tag.
