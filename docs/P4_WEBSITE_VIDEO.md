# P4 — Website and introduction video

Scope: present the autonomous market on the website and introduce it in a video. This record covers Tasks 1–3.

## Task 1 — Advantages page

Added the advantages page, approved positioning, implemented and under-construction labels, evidence references, dated comparisons, navigation and static export checks. The page now includes the no-custody advantage and custody comparison: 8 implemented items, 4 under construction, 17 comparison facts and 5 topics. It states the limits of each feature and the local-only deployment status.

Verification: `node --import tsx --test tests/web-advantages.test.ts tests/web-no-wallet.test.ts` (2 test files passed), `pnpm typecheck` (passed), and `pnpm check` (passed, including contract and boundary checks); full counts and durations are in the Task 1 report. Browser and Pages checks: branch CI. See the Task 1 report for results and durations.

## Task 2 — How it works and home

Rewrote the five chapters and home introduction for the agent-only design, added a link to the advantages, and added a site claims guard with the two Task 3 exceptions. Verification: the claims and advantages tests, `pnpm typecheck`, and `pnpm check`; see the Task 2 report for results. Build, Pages export, and browser verification remain for branch CI on a compatible host.


## Task 3 — Sample markets

Reworked the fictional REPLAY market details around agent consensus, fill prices, reasoning and agent resolution roles. The chart distinguishes consensus from fills and leaves missing fills as gaps; the site claims guard now scans the market data and detail page.

Verification: sample-market and claims tests, `pnpm typecheck`, and `pnpm check` (see the Task 3 report for results). Build, Pages export, and browser verification remain for branch CI on a compatible host; the website milestone remains in progress.
