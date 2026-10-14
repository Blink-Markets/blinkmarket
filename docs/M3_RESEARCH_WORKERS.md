# M3 discovery, forecaster and baseline workers

中文摘要：加入 discovery.scan、forecast.dispatch、forecast.run、baseline.run 四個 worker job，以固定回應的 fixture 模型與預算帳本，經公開 API 以平台 agent 身分建立候選與提交預測；沒有真實模型供應商，不代表整個 M3 已完成。

## Scope

Platform agents act through the public HTTP API with their own invited keys (`@blink/client`), exactly like an external agent. The worker holds no write grant on candidate or forecast tables; it records its own bookkeeping and reads what it needs to build prompts. Model access is the `ModelGateway` port; the only implementation is the deterministic fixture gateway, so nothing here spends money or calls a network. Tests run the real API (`buildApi` with the real services over PGlite) on a loopback port and point the real client at it.

| Piece | Where |
| --- | --- |
| Migration | `packages/adapters/migrations/0017_discovery_runs.sql` |
| Prompts and constants | `packages/domain/src/prompts.ts` (`DISCOVERY_PROMPT_V1`, `FORECAST_PROMPT_A_V1`, `FORECAST_PROMPT_B_V1`, `BASELINE_PROMPT_V1`, `discoveryPrompt`, `forecastPrompt`) |
| Model output schemas | `packages/schemas/src/research.ts` |
| Ports | `packages/ports/src/research.ts` (`DiscoveryStore`, `PlatformRunStore`, `DiscoveryApi`, `ForecastApi`) |
| Application | `discovery.ts`, `platform-forecaster.ts`, `api-failure.ts` |
| Adapters | `discovery-store.ts`, `platform-run-store.ts`, `model-fixtures.ts`, `content-hash.ts` |
| Client | `submitForecast` and `listForecastWindows` added; `createCandidate` and `getMarket` already existed |
| Worker | `apps/worker/src/{config,research,handlers,main}.ts` |
| Fixtures | `fixtures/replay/models/gm-replay.json` and its README (format) |

## Discovery (`discovery.scan`)

Payload `{ sourceId, day, slot }`. `createDiscoveryScheduler` enqueues one per fetch-enabled source for the current UTC day and slot (slot 0 before 12:00 UTC, slot 1 after) through `schedulePeriodic`, so at most two scans per source per UTC day; the day and slot come from the database clock.

1. `discovery.scan_runs` is unique on `(source_id, day, slot)`. A run that already ended makes any rerun or redelivery a no-op.
2. Evidence: Task 3's fetch handler runs as a function with the run id as its job id (so a redelivered fetch does nothing twice). If the fetch fails for a reason other than `SOURCE_NOT_FETCHABLE`, the newest evidence of the same UTC day is used instead; with none, the job fails with the fetch error.
3. The archived bytes are hash-checked, then placed between fixed delimiters by `discoveryPrompt` with an instruction that the document is untrusted data; the delimiter strings inside a document are removed so it cannot close its own block.
4. The budgeted model call uses question key `scan:<runId>`, cap 2,000,000 and `maxOutputTokens` 800. At most two model calls start per run (`attempts` is incremented before each call): the first uses the run id as its reservation run id, the retry a new id and a new reservation under the same question key. Budget errors (`BUDGET_EXHAUSTED`, gate closed) end the run `FAILED` and fail the job without retry.
5. The answer is parsed by a zod schema `{ entityId, fiscalPeriod, thresholdBps (int 0..10000), thesis (<= 1000 chars) }`; unknown keys are dropped. One invalid answer is retried once; a second ends the run `MANUAL_REVIEW` with an `operations.audit_log` row (`discovery.manual_review`). The model may also answer `{"candidate": null}`, which ends the run `NO_CANDIDATE`.
6. A valid answer takes one of the day's ten slots (`discovery.daily_counters`, row lock, `CHECK candidates BETWEEN 0 AND 10`) and is stored on the run (`scan_runs.answer`) in the same transaction; with no slot left the run ends `SKIPPED_DAILY_CAP`. Then `createCandidate({ templateId: "GM_LT_V1", entityId, fiscalPeriod, thresholdBps, evidenceIds: [fetchedEvidenceId], thesis })` is sent with the discovery key and `Idempotency-Key` = run id. Evidence ids never come from model output.
7. A redelivery of a run that holds a stored answer never asks the model again: it sends the same request under the same key, so the API replays the stored result and a differing payload (`IDEMPOTENCY_CONFLICT`) cannot arise. A refusal by the API (for example `EVIDENCE_NOT_ALLOWED` for a mismatching entity) means no candidate exists: the run ends `MANUAL_REVIEW` and returns the slot. Network errors, malformed responses and retryable API errors fail the job for retry; when that was the job's last attempt the outcome is unknown (a candidate may exist), so the run ends `MANUAL_REVIEW` with an audit row and its slot stays counted. Every other end (`NO_CANDIDATE`, `FAILED`, `SKIPPED_DAILY_CAP`, `MANUAL_REVIEW` for a known refusal) returns the slot, so the daily counter never under-counts a candidate that exists.

## Forecasters and baseline

`forecast.dispatch` (every 60 s) lists open windows of OPEN markets by the database clock and enqueues `forecast.run` jobs for the configured `FORECASTER_A` and `FORECASTER_B` and a `baseline.run` job for `BASELINE`, with dedupe key `forecast.run:<windowId>:<role>` and at most 2 attempts.

`forecast.run` / `baseline.run` (payload `{ windowId, role }`; a job type runs only its own roles):

1. Load the registered platform agent (`model`, `prompt_hash`) and the window with its market and the approval of the market's spec hash (`candidate_id`, `budget_micros`). A run this agent already has `SUBMITTED` or `LATE` for the window ends the job.
2. `client.getMarket` supplies the spec; evidence is the spec's `sourceEvidenceIds` with `observed_at <= window.open_at` (the data cutoff), read from the object store and hash-checked. No qualifying evidence fails the job (`NO_EVIDENCE_BEFORE_CUTOFF`).
3. `forecastPrompt(role, spec, evidence)` builds the prompt; `keccak256(utf8(template))` must equal the registered `prompt_hash`, else `PROMPT_MISMATCH` (non-retryable, no model call). The input hash recorded in `forecasts.model_runs` is `keccak256(utf8(input))`.
4. Each model call is its own `model_runs` row (id = reservation run id = submission `Idempotency-Key`), question key `candidate:<candidateId>`, cap = `approval.budget_micros`. The answer is `{ probability (<= 6 decimals), rationale, evidenceIds }`, and every cited id must be among the evidence shown; otherwise the run is `SCHEMA_INVALID`, retried once with a new run, then the job fails without retry.
5. A valid answer is stored (`forecasts.pending_answers`, with the run's reservation and provider request id) before it is submitted with the role's own key. If the response is lost, the run stays `STARTED` and the retry finds the stored answer and submits it again under the same run id and `Idempotency-Key`: no second model call or reservation, and the run that made the real submission ends `SUBMITTED`. The stored answer is deleted when the run ends (`SUBMITTED`, `LATE` or `FAILED`), so it exists only between the model's reply and the settled submission.
6. `409 FORECAST_WINDOW_CLOSED` (the database clock decides) ends the run `LATE` without retry; a window already closed when the job starts is `LATE` without a model call. `BUDGET_EXHAUSTED` ends the run `FAILED`, non-retryable. Other API refusals end the run `FAILED` and keep their code and retryability; a retryable failure on the job's last attempt also ends it `FAILED`.

The runner never queries `forecasts.submissions` or `forecasts.snapshots`; the `blink_worker` grants deny them (tests assert both). Stored pending answers are the one place the worker role can read forecast answers, and only its own unsettled ones; the runner reads them by agent and window only, and no other role has a grant on that table. The grant-level wall between the worker and published answers is unchanged.

## Worker composition and configuration

`buildResearch` (in `apps/worker/src/research.ts`, re-exported by `handlers.ts` so that file stays a thin registry) returns the handlers to merge into the worker's map and a `tick` that `main.ts` calls every 30 s, which enqueues the periodic jobs (`forecast.schedule` every 5 min, `forecast.dispatch` every 60 s, discovery scans) with deduplication, using the database clock for the buckets.

| Variable | Enables |
| --- | --- |
| none | `forecast.schedule` (Task 7's handler; needs only the database, so it runs whenever the worker is enabled) |
| `WORKER_EVIDENCE_DIRECTORY` + `WORKER_PLATFORM_OPERATOR_ID` | `evidence.fetch` (file object store; DNS by `dns.promises.lookup`, `httpsTransport()`) |
| `WORKER_API_URL`, `WORKER_MODEL_FIXTURES`, evidence variables, `WORKER_DISCOVERY_API_KEY`, `WORKER_DISCOVERY_MODEL` | `discovery.scan` |
| `WORKER_API_URL`, `WORKER_MODEL_FIXTURES`, evidence variables, and `WORKER_FORECASTER_A_API_KEY` with `WORKER_FORECASTER_B_API_KEY` | `forecast.run` and `forecast.dispatch` (the two forecasters are one capability and are configured only as a pair) |
| `WORKER_API_URL`, `WORKER_MODEL_FIXTURES`, evidence variables, and `WORKER_BASELINE_API_KEY` | `baseline.run` and `forecast.dispatch` |

Everything is off without its variables, and a worker that runs other jobs is unaffected. A feature that is half configured stops startup with a specific code (`WORKER_EVIDENCE_CONFIGURATION_INCOMPLETE`, `WORKER_DISCOVERY_CONFIGURATION_INCOMPLETE`, `WORKER_FORECASTER_CONFIGURATION_INCOMPLETE`, `WORKER_FORECASTER_PAIR_INCOMPLETE` for exactly one of the two forecaster keys, `INVALID_WORKER_PLATFORM_OPERATOR_ID`). `WORKER_PLATFORM_OPERATOR_ID` must be the operator of the discovery agent, because the API lets only the owner cite private (auto-fetched, default `PRIVATE`) evidence.

## Database grants (0017)

`blink_worker` gets `discovery.scan_runs` (select, insert, column-level update), `discovery.daily_counters`, column-level select on `markets.approvals` (`candidate_id`, `deployment_id`, `spec_hash`, `budget_micros`, `created_at`) and on `forecasts.model_runs` (`agent_id`, `window_id`, `state`, on top of `id`). It still cannot read an approval's reason or actor, a model run's submission id, or any submission or snapshot. `scan_runs.slot_taken` and `scan_runs.answer` are additions to the specified columns: they record that a run holds one of the day's slots, and the validated answer it will send, so a redelivery never counts twice and never changes its payload. `forecasts.pending_answers` is new (select, insert, delete for `blink_worker` only).

## Verification

Run on 2026-10-14 in the task worktree.

- `pnpm check`: exit 0 (TypeScript including the web typecheck, contract compilation, 293 Node tests, package boundaries).
- `pnpm build`: exit 0.
- `pnpm build:services && pnpm test:service-build`: exit 0, 3 tests (the worker bundle includes `@blink/client`).
- `TEST_POSTGRES_ADMIN_URL=<local throwaway server> pnpm test:postgres`: exit 0, 13 tests, no skips. The three new tests run on real PostgreSQL: fifteen workers racing for the daily slots admit exactly ten; a redelivered run never holds two slots and returned slots stay consistent under contention; the worker role's grants.
- New tests: `tests/discovery.test.ts` (15), `tests/platform-forecaster.test.ts` (15), `tests/model-fixtures.test.ts` (5), `tests/worker-research.test.ts` (5).
- `pnpm test:anvil`: not applicable; no chain code.

## Remaining limits and open items

- No real model provider (Ruling 3). Documents are decoded as UTF-8 text; no HTML or PDF text extraction and no truncation, so a large document makes the conservative reservation exceed the question cap and the run fails with `BUDGET_EXHAUSTED`. Derived text objects (design 05) are an open item before real sources.
- `WORKER_PLATFORM_OPERATOR_ID` must equal the discovery agent's operator, and each platform API key must belong to the agent registered for its role. The worker cannot verify either at startup: the public API has no endpoint that returns the caller's agent identity, and the worker role cannot read `identity.api_keys`. A wrong value shows up as `EVIDENCE_NOT_ALLOWED` for every scan or as a forecast under the wrong agent. Open item: an identity endpoint (or a startup self-check) before real keys are configured.
- `schedulePeriodic` gained an optional `maxAttempts` argument (a one-line change to Task 2's `worker-runtime.ts`) so scan jobs use the policy's 2 attempts; `forecast.run` and `baseline.run` jobs are enqueued with 2 as well.
- `thesis` is document-derived free text. Admin and public renderers must treat it as inert text.
- Platform agent API keys expire after at most 30 days (identity schema) and the worker has no rotation; keys are plain environment variables. Rotation and secret storage are deployment items.
- Discovery does not record `forecasts.model_runs` rows (that table requires a registered agent id); its provenance is the scan run, the budget reservation and the idempotency record.
- The `NO_CANDIDATE` answer form and the same-day evidence fallback are small additions to the brief.
- Real LIVE sources, the end-to-end REPLAY wiring (Task 16) and the Task 16 registration of the platform agents with the prompt hashes are not part of this slice.
