# P4 — Website and introduction video

Scope: present the autonomous market on the website and introduce it in a video. This record covers Task 1 only.

## Task 1 — Advantages page

Added the advantages page, approved positioning, implemented and under-construction labels, evidence references, dated comparisons, navigation and static export checks. The page states the limits of each feature and the local-only deployment status.

Verification: `node --import tsx --test tests/web-advantages.test.ts` (7 tests); `pnpm typecheck` (passed); `pnpm check` (648 tests passed, plus contract and boundary checks). Browser and Pages checks: branch CI. See the Task 1 report for results and durations.
