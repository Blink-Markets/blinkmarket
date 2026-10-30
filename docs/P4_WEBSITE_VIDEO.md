# P4 — Website and introduction video

Scope: present the autonomous market on the website and introduce it in a video. This record covers Tasks 1–6.

## Task 1 — Advantages page

Added the advantages page, approved positioning, implemented and under-construction labels, evidence references, dated comparisons, navigation and static export checks. The page now includes the no-custody advantage and custody comparison: 8 implemented items, 4 under construction, 17 comparison facts and 5 topics. It states the limits of each feature and the local-only deployment status.

Verification: `node --import tsx --test tests/web-advantages.test.ts tests/web-no-wallet.test.ts` (2 test files passed), `pnpm typecheck` (passed), and `pnpm check` (passed, including contract and boundary checks); full counts and durations are in the Task 1 report. Browser and Pages checks: branch CI. See the Task 1 report for results and durations.

## Task 2 — How it works and home

Rewrote the five chapters and home introduction for the agent-only design, added a link to the advantages, and added a site claims guard with the two Task 3 exceptions. Verification: the claims and advantages tests, `pnpm typecheck`, and `pnpm check`; see the Task 2 report for results. Build, Pages export, and browser verification remain for branch CI on a compatible host.


## Task 3 — Sample markets

Reworked the fictional REPLAY market details around agent consensus, fill prices, reasoning and agent resolution roles. The chart distinguishes consensus from fills and leaves missing fills as gaps; the site claims guard now scans the market data and detail page.

Verification: sample-market and claims tests, `pnpm typecheck`, and `pnpm check` (see the Task 3 report for results). Build, Pages export, and browser verification remain for branch CI on a compatible host; the website milestone remains in progress.

## Task 4 — Drill record and introduction video script

The existing local autonomous drill passed five scenarios with 14 agents in 950 seconds. `pnpm video:capture` captured its whitelisted events and roster before the Task 4 commit. The introduction script and independent video workspace notes are in place; the video itself remains under construction.

Verification: capture tests, `pnpm typecheck`, and `pnpm check`; see the Task 4 report for results. Build, Pages export, and browser verification remain for branch CI on a compatible host.

## Task 5 — Introduction video workspace

Added the independent Remotion workspace, timeline, script and local-drill scenes. The MP4, poster, website embedding and visual verification remain for Task 6; this milestone is still in progress. The development host could not launch Chrome for the still because `libgbm.so.1` is missing and its glibc is 2.28. See the Task 5 report for verification and the container rendering instructions in `video/README.md`.

Verification: Task 5 local checks passed (`pnpm check`: 663 tests), and branch CI passed. The controller rendered in the container using the steps in `video/README.md`: from `ws/p4-t5` commit `d79c26b`, the MP4 is 150.000000 seconds and 1,240,426 bytes (1.24 MB). The controller checked scene stills against the script; a Remotion zod version warning had no effect on output.


## Task 6 — Embed and close P4

Embedded the introduction video and poster on the home page with controls and a transcript, and marked the video implemented. Updated the READMEs and roadmap. The intro-video, advantages and claims tests passed, as did `pnpm typecheck`. Build, Pages export and browser verification run in branch CI on a compatible host.

## Final state

P4 delivers the advantages page, rewritten home and how-it-works pages, sample markets and introduction video. Nine advantages are implemented; public deployment, handling illegal or harmful questions and the platform token remain under construction.

The video uses the 2026-10-30 `pnpm alpha:autonomous` drill at commit `abb43ec`, on local chain 84532; it is not a public deployment. The drill passed five scenarios with 14 agents.

Known limitations:

- The 1,240,426-byte (1.24 MB) video is a binary in git history.
- Sealing is between agents: the platform database can read answers before the deadline. A window root reaches the chain only if an agent anchors it.
- Handling illegal or harmful questions remains an open U17 decision.
- No automatic `OUTCOME_ALREADY_PUBLIC` path exists; contamination is marked from proposal timing.
