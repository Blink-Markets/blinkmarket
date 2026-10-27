# M3 evaluation scores and public metrics

> Partly historical: this describes the v1 scoring over platform agents, the ensemble and the baseline. P2 Task 2 scores every submission as `AGENT`, and Task 10 added the `v2` entries and the credit-weighted consensus; `ENSEMBLE` and `BASELINE` rows stay in the table and are ignored by public metrics. See [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md).

Task 12 implements the evaluation slice only; it does not complete the whole M3 milestone.

## Delivered scope

- `brierExact(x, outcome)` uses bigint arithmetic to return the exact decimal squared error, where `x` is twice the probability in millionths. It preserves half-millionth ensemble averages and rejects probabilities outside the valid range.
- Migration `0015_evaluation.sql` adds append-only `analytics.score_entries`. The unique key uses `NULLS NOT DISTINCT` so ensemble/baseline rows are idempotent despite their null agent IDs. Workers can insert/select scores; the API can only select them.
- An owner-rights security-barrier view exposes scoring inputs only for FINAL markets. Workers still cannot read the underlying submissions or snapshots, preserving the existing pre-deadline isolation. No rationale, evidence or key data is exposed by this view.
- Every FINAL market window receives an ENSEMBLE row and BASELINE row, plus one AGENT row per external submission. Missing or withdrawn forecasters mark the ensemble missing; the baseline never substitutes for a missing member. Any annotation on either member marks the ensemble contaminated. Baseline/external annotations are retained on their respective rows. INVALID and missing entries have null Brier scores.
- The `evaluation.score` handler is registered in the worker composition root. `market.indexed` events enqueue scoring; the handler checks FINAL eligibility against the current projection rather than trusting event payloads. Startup and the existing outbox tick enqueue one periodic job per ten-minute `blink.now()` bucket. Reruns use evaluation version `v1` and do not change existing scores. Each scoring run is transactional and honors cancellation.
- `GET /v1/metrics?mode=LIVE|REPLAY` is registered in markets/trading API modes. It returns `Cache-Control: public, max-age=60`. Counts and USD micros are decimal strings; Brier is a JSON number rounded to six decimals, or null without eligible events.
- Metrics first average eligible ensemble windows within each event, then average events equally. Missing and contaminated rows are excluded from Brier/event counts. Missing rows and INVALID markets are counted separately, including INVALID markets with no forecast windows. Budget spent/reserved/unknown totals are **platform-wide**, not split by mode.

## Precision clarification

The brief's `probability_millionths INTEGER` cannot represent an odd ensemble sum divided by two. The migration therefore also stores `probability_millionths_times2 INTEGER`. The original column contains the exact integer-millionths value when representable, otherwise null; the extra column preserves the exact sum. No rounding is applied to stored Brier values. For example, probabilities 0.6 and 0.600001 yield `x=1200001` and Brier `0.15999960000025` for YES.

## Verification

- `pnpm check:contracts`: passed; generated ignored ABI artifacts.
- `node --import tsx --test tests/brier.test.ts`: passed (1 test).
- `node --import tsx --test tests/evaluation.test.ts`: passed (4 integration tests).
- `pnpm check`: passed; TypeScript, contracts, all 258 tests (0 failures/skips), and package boundaries.
- `pnpm build:services && pnpm test:service-build`: passed; service/tool bundles and 3 isolation/startup tests.
- `pnpm build`: attempted, blocked by the existing web app's Google Fonts fetches (Geist, Geist Mono, Kalam) in this restricted environment. No frontend files were changed.
- `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/t12-font-mocks.cjs pnpm --filter @blink/web exec next build --experimental-build-mode compile`: passed with temporary CSS fixtures using local Arial and sandbox escalation for Turbopack's local subprocess port. This verifies compilation/source-export resolution, not production fonts, prerendering or share-card generation. Temporary fixtures were not committed.
- `git diff --check`: passed.
- Real PostgreSQL and Anvil suites: not applicable to added tests; no new race or chain integration test was introduced.


## Remaining limits

- Scoring uses directly seeded local chain projections, as Task 5 is not a dependency available at this branch's start point. No RPC, Anvil or deployed-chain evaluation was added.
- Integration tests use PGlite and actual API/worker roles. They establish permissions, append-only enforcement and repeat-run idempotency, not multi-connection PostgreSQL races. No real-PostgreSQL test was added.
- Version `v1` is an immutable evaluation snapshot. Annotations or platform-agent registrations added after scoring do not rewrite its rows. Revising historical evaluations requires a separately designed evaluation version workflow.
- Public aggregation excludes scores if the current projection is no longer FINAL or its outcome no longer matches the stored score. Re-scoring a changed final outcome under a new evaluation version is outside this slice.
- This implements ensemble public aggregation; individual baseline/external scores and flags are stored for subsequent comparisons. No extra public score-list route or frontend was requested.
