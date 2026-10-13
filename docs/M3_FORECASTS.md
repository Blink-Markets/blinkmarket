# M3 forecast windows, submissions and snapshots

中文摘要：本階段完成資料庫時鐘約束的預測窗口與不可變提交、截止前後可見性、平台模型登錄與註記，以及固定雙模型快照；不代表整個 M3 已完成。

## Delivered scope

Migration `0009_forecasts.sql` adds the platform-agent registry, DAILY/PRE_CLOSE windows, immutable submissions, append-only annotations and snapshots, and model-run provenance/lifecycle records. Windows deliberately have no foreign key to the rebuildable chain market projection. API, worker and forecast-admin grants are separate; workers cannot read submissions or snapshots.

`plannedWindows` creates future UTC midnight deadlines and the close-minus-one-hour deadline, each with a 30-minute submission period. Coincident horizons remain separate. `createWindowScheduler` reads OPEN markets using `blink.now()`, inserts idempotently, and checks the clock again at insertion to avoid backfill. `createForecastScheduleHandler` exports the structural job-handler interface for later worker composition.

The markets/trading API modes register these existing contracts:

- `GET /v1/markets/:id/forecast-windows?deploymentId=...`: statuses and keyset pagination by scheduled time, then horizon type.
- `POST /v1/markets/:id/forecasts?deploymentId=...`: `forecast:write`, existing transactional idempotency, window row lock before the database clock check, open-market/evidence checks, immutable insert, audit and stored response in one transaction. A second precise SQL clock check prevents insertion after the deadline. Deployment identity is included in the normalized payload hash because the existing contract carries it in the query.
- `GET /v1/markets/:id/forecasts?deploymentId=...&windowId=...`: anonymous callers see no answers before closing; authenticated callers see only their agent's answer. Closed windows expose all submissions and withdrawal/contamination flags. Invalid Authorization always fails. Submission pagination uses immutable UUID order.

`createSnapshotReader(store).latest(deploymentId, marketId)` returns the most recent qualifying closed window no more than 24 hours old. It requires both immutable registered FORECASTER_A/B submissions, rejects annotated answers, and never substitutes BASELINE or external agents. Integer millionths are summed in SQL. Existing snapshots are reused, but eligibility is rechecked on every read and after a potentially competing insert. `snapshotPriceBase` rounds each side upward independently.

Model-run metadata is fixed after insertion. Workers can update only state, provider request ID, reservation ID, submission ID and update time. The narrow `SELECT(id)` grant supports targeted updates; it does not expose answers. Window row locking requires PostgreSQL column UPDATE permission, so API receives `UPDATE(id)` with an immutable trigger that rejects actual changes.

## Administration

Use a dedicated non-superuser login inheriting `blink_forecast_admin`, with `FORECAST_ADMIN_DATABASE_URL`. API startup rejects identities that also inherit this role or own the forecasts schema. The CLI requires a nonblank reason and atomically writes an audit row:

```sh
pnpm forecast:admin register-platform-agent --agent-id <uuid> --role FORECASTER_A --model <model> --prompt-hash <0x-hash> --policy-version <version> --reason <reason>
pnpm forecast:admin annotate --submission-id <uuid> --kind WITHDRAWN --reason <reason>
```

Other roles are `FORECASTER_B` and `BASELINE`; other annotation kinds are `OUTCOME_ALREADY_PUBLIC` and `WINDOW_CONTAMINATED`. The registry cannot be edited or rotated. The service build also emits `dist/tools/forecast-admin.mjs`.

## Verification

Run on 2026-10-14 in the task worktree.

- `pnpm check`: exit 0. TypeScript (including the web typecheck), contract compilation, 137 Node tests (129 foundation plus 8 new) and package boundaries.
- `pnpm build`: exit 0 (Turbopack web build; the shared-package source exports resolve).
- `pnpm build:services && pnpm test:service-build`: exit 0, 2 bundle tests pass; `forecast-admin` is bundled and normal API startup still fails closed without configuration.
- `TEST_POSTGRES_ADMIN_URL=<local throwaway server> pnpm test:postgres`: exit 0, 3 tests, no skips (the identity concurrency test plus two new forecast tests). The race test confirms a request is blocked on the window row before the deadline, releases that lock after the deadline, and rejects both the waiting request and a later request; the only accepted row predates the deadline. The second test runs the scheduler as `blink_worker` and the snapshot reader as `blink_api` on real PostgreSQL and confirms the worker cannot read submissions. Random test databases are dropped.
- Focused tests cover UTC schedules, coincident horizons, price rounding, API response schemas, exact-deadline rejection, replay, duplicate submission, evidence visibility, answer publication, flags, pagination, registry/audit permissions, model-run grants, the `UPDATE(id)` window-lock grant staying immutable, missing forecaster/baseline exclusion, snapshot reuse, annotation invalidation and the inclusive 24-hour age boundary. PGlite pins the test clock origin and changes `blink.test_clock_offset_seconds`; the real PostgreSQL tests use the unmodified production clock function.
- `pnpm test:anvil`: not applicable; this slice has no chain code.

## Remaining limits

This completes the forecast slice only. Worker queue wiring awaits Task 2 integration; platform model execution and budget integration belong to later tasks. No real provider, live deployment, chain transaction or M3-wide completion is claimed. The tables add foreign keys the brief left implicit (submissions to operators and API keys, model runs to submissions); `reservation_id` stays unconstrained because the budget tables belong to Task 2.
