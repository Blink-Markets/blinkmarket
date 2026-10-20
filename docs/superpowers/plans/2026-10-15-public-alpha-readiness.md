# Public Alpha Readiness (M5, with the M4 decision) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Track A approved by the user on 2026-10-17, with D1 = (a), D7 = (a) and D8 = (b) as recommended. A2 is deferred until an API is deployed (it is optional and needs a mockup); A7 waits for D6. Track B is not approved: it still needs the user's answers to D3–D6, D9 and D10 and an explicit go-ahead for each outward-facing action. For those choices the user prefers free or the cheapest options while the project is experimental.

**Track A result (2026-10-17):** A1, A3, A4, A4b, A5, A6, A8 and A9 are done, reviewed and merged to `main`; A2 stays deferred and A7 still waits for D6. Verification on `main` after the last merge: `pnpm check` 697 pass, 0 fail; `pnpm build`; `pnpm build:services` and `pnpm test:service-build`; `pnpm test:anvil` 50 pass; `pnpm test:postgres` 57 pass; `pnpm alpha:local` 8 pass; `node --test tests/images.test.mjs` 16 pass; on freshly built images, `pnpm images:smoke` (fast) ok in 103 s and `pnpm images:smoke -- --market` without the signer restart ok in 2034 s; `--full` ok in 5768 s (keeper finalized, agent redeemed 10,000,000 micro-bUSD); CI green on 3b216a1 and a4ba2ee. Everything is local: nothing is deployed, no real key signed and no public-chain transaction was sent. Track A does not complete M5; the remaining §17.3 items need Track B.

**Goal:** Take the locally verified v0.1 backend (plan `2026-10-14-remaining-milestones.md`, Tasks 1–17) to the spec §17.3 Public Alpha Definition of Done on Base Sepolia. Track A does everything that can be built and proven locally. Track B lists the deployment steps that need the user's resources and authorization. The functional web UI (spec §13 trading, positions, admin) is decision D1, not an assumption.

**Architecture:** Keep the modular monolith and the four service bundles (`dist/services/{api,worker,indexer,signer}.mjs`). Track A adds:
- production packaging: one container per service, built from the existing `infra/Dockerfile.api` pattern;
- an operator status surface (read-only admin endpoints plus a CLI), because the web stays read-only unless D1 changes it;
- an alert delivery port;
- a backup/restore drill;
- a deployment runbook with a preflight check;
- optional live read-only data on the public site.

Track B applies these to real infrastructure, one authorized step at a time.

**Tech Stack:** As in the previous plan (Node 22, TypeScript ESM, Fastify, PostgreSQL 17, viem 2.56.8, Foundry/Anvil, Next.js 16 static export for the site), plus Docker for images. No new runtime dependency without a ruling.

**Spec:** `Blink_MVP_v0.1_Base_Sepolia_Spec.md` (§13, §17.3, §19, Appendix A), refined by `docs/OPERATIONS.md` (target Alpha topology, identity matrix, health, backup), `docs/design/02-api-contracts.md` (admin auth, no bearer key in the public bundle) and ADR 0002.

## Decisions needed from the user

Each decision names the tasks it blocks. Recommendations are mine. None of the values below are filled in, and none may be invented.

| # | Decision | Options | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| D1 | Functional web UI (spec §13: trading area, positions, admin page) | (a) keep the site read-only; Alpha trading is agent-only through the SDK; (b) build it now; (c) after the first external feedback | (a) for this plan, then (c). The previous plan recorded the user's choice of a read-only explainer, and §17.3's "UI 明示測試資產…" can be met on read-only pages | Track C |
| D2 | If D1 = (b): how a human taker authenticates for RFQ | (a) wallet sign-in → HttpOnly/Secure/SameSite session cookie + CSRF (needs web and API on one site); (b) the invited user pastes their API key, kept in memory only | (a) if web and API share a site; otherwise (b) for Alpha only | Track C |
| D3 | Hosting: app host (API/worker/indexer), private signer host, managed PostgreSQL, private S3-compatible bucket with versioning/retention, region | user's choice of providers | One region, no Kubernetes (`docs/OPERATIONS.md`); signer on a separate host/identity | B1, A6 values |
| D4 | Base Sepolia RPC primary and backup | providers that serve historical state at `deploymentBlock − 1` and a `finalized` tag | two independent providers | B1, B3 |
| D5 | Role wallets and custody: ADMIN, RESULT_PROPOSER, CHALLENGER, ARBITER (human wallets); MAKER, faucet minter, keeper, internal trader (signer key files); deployer; who funds Sepolia ETH | user generates and controls keys; agents never see them | user generates every key outside this repo and its sessions | B2, B3 |
| D6 | Public URLs and feedback entry: API URL, site URL (GitHub Pages today), feedback channel (spec §19 fields) | user's choice | keep the site on GitHub Pages; pick a feedback channel that does not require public repo issues | A2, A7, B7 |
| D7 | Model provider for discovery/forecasters/baseline | (a) stay REPLAY/fixture for Alpha; (b) a paid provider with model IDs, rates and keys | (a) first; (b) only with a written rate card and the USD 20/day cap | B5 |
| D8 | LIVE markets | (a) 1–3 companies with verified official IR sources and schedules; (b) "restricted preview" without forward-looking claims (§17.3 bullet 4) | (b) unless the user names companies | B5 |
| D9 | Alert channel for budget, pause, RPC failure and keeper timeout | e-mail, chat webhook, pager | a webhook the user owns | A4 adapter config, B4 |
| D10 | External acceptance: a non-team operator, a usability tester, the demo video | people and recording are the user's | — | B6, B7 |

Recorded 2026-10-17: D1 = (a) read-only site, agent-only trading; D7 = (a) REPLAY/fixture; D8 = (b) restricted preview. D2 does not apply. Open: D3, D4, D5, D6, D9, D10 (preference: free or cheapest first).

## Global Constraints

- Everything from the previous plan's Global Constraints still applies: chain ID 84532 only, `MAINNET_REFUSED` on 8453, bigint money, `blink.now()` business time, keys only in the signer, package boundaries, Idempotency-Key, error envelope, least-privilege DB roles, no edits to merged migrations.
- AGENTS.md: commits and pushes are authorized; deployment, paid services, signing and broadcasting are not. Every Track B step that provisions, deploys, signs, broadcasts or spends money stops for the user's explicit approval of that step.
- No secret, key, RPC URL with credentials, or real provider endpoint goes into the repo, logs, the site bundle, a plan or an agent prompt. Config examples use `<TO BE PROVIDED: …>` markers, and a preflight check rejects them.
- Container images: pinned base image (exact version, digest recorded in the runbook when built), non-root user, no dev dependencies, one service per image.
- The public site keeps saying what is true at each moment: before B4 it says nothing is deployed; after B4 it says Base Sepolia testnet, test assets with no value, no early exit, trusted resolution roles, INVALID pays 0.5 per share.
- Visual changes to the site need an approved mockup artifact first. Copy-only changes do not.
- Each task writes its delivery record `docs/M5_<NAME>.md` (English with a one-line 中文摘要) and does not edit `docs/ROADMAP.md`. The controller owns the roadmap.

## Review Focus

1. **A secret reaching an image, log or page.** Build args, `.env` files copied into images, error messages that echo config, and Next.js `NEXT_PUBLIC_*` variables. Owner tests: A1 (image content scan), A6 (preflight rejects secrets in public variables), A2 (bundle scan).
2. **Restore that looks fine but is wrong.** A restore that skips canonical event replay, or that reopens quoting before reservations reconcile. Owner test: A5 must fail if quoting reopens before reconciliation.
3. **Alerts that never fire.** An alert sink that fails while the job is marked delivered, or the keeper being the only process that notices a deadline. Owner tests: A4 (sink failure keeps the alert pending; deadline alerts are produced by a process other than the keeper).
4. **Admin status endpoints leaking private data.** Private candidates, raw evidence, or other operators' keys appearing in admin views or to non-admin keys. Owner test: A3.
5. **Live site data overstating reality.** An unreachable or empty API shown as "no markets", or sample data shown without its label. Owner test: A2.

---

## Track A — local, no authorization needed

These run after the previous plan's final review. They can run in parallel: A1 ∥ A3 ∥ A4 ∥ A5, then A6 (it documents A1–A5), with A2 and A7/A8 independent.

### Task A1: Service images

**Goal:** Reproducible, minimal container images for api, worker, indexer and signer from the existing bundles, testable locally.

**Files:** create `infra/Dockerfile.worker`, `infra/Dockerfile.indexer`, `infra/Dockerfile.signer`, `infra/compose.alpha.yaml` (local smoke: PostgreSQL + Anvil + the four images), `tests/images.test.mjs` (opt-in, runs when Docker is available), `docs/M5_SERVICE_IMAGES.md`. Modify `infra/Dockerfile.api` (its readiness comment is stale), `package.json` (`images:build`, `images:smoke`).

**Rules:**
1. Follow `infra/Dockerfile.api`: build stage runs `pnpm build:services`; the runtime stage copies only the service's `.mjs` and runs as `node`.
2. The signer image reads keys only from mounted files (mode 0600) at paths from config, and exposes only the internal sign port. No key material at build time.
3. The healthcheck uses `/health/live`; readiness stays a separate endpoint for the orchestrator.
4. `images:smoke` starts `compose.alpha.yaml` and runs the Task 16 REPLAY scenarios against the containers, with test keys only and Anvil only.

**Tests:** the image test asserts non-root, that no `node_modules`, `.env`, `*.key` or `contracts/artifacts` source appears in the runtime layer, and that each entry fails closed without config, matching `tests/service-build.test.mjs`.

### Task A2: Live read-only data on the public site (optional; needs a mockup)

**Goal:** The market list, market detail, settlement detail and metrics pages read the public API when `NEXT_PUBLIC_API_URL` is set at build time, and keep today's labelled REPLAY samples when it is not. This covers the read-only rows of spec §13.1 without trading.

**Gate:** a mockup artifact of the new states (loading, API unreachable, empty deployment, live data, stale indexer) approved by the user before any visual change.

**Files:** create `apps/web/lib/api.ts` (fetch through `@blink/client` from Task 15, browser-safe, no keys), the live-data components beside the existing ones, and `tests/web-live-data.test.ts`. Modify the market pages and `docs/M4_WEB_SHOWCASE_DELIVERY.md`.

**Rules:**
1. Public endpoints only; no API key in the bundle (design 02).
2. An unreachable API shows "not connected", never "no markets".
3. `getMarketSpec` verifies the spec hash before display.
4. Indexer lag shows "not tradable: indexer behind", and no price is invented.
5. The GitHub Pages build without `NEXT_PUBLIC_API_URL` is byte-for-byte the current behaviour.

### Task A3: Operator status surface

**Goal:** The spec §13 "管理頁" needs, served without a web admin UI: candidate review queue, approvals, failed jobs, budgets, pause state, resolution and dispute queue.

**Files:** add admin read contracts in `packages/schemas` (`GET /v1/admin/candidates?status=`, `GET /v1/admin/jobs?state=DEAD`, `GET /v1/admin/budgets`, `GET /v1/admin/pause`), application services, store queries, and `scripts/ops-status.ts` (`pnpm ops:status`, a one-screen summary using an admin key). Add tests and `docs/M5_OPERATOR_STATUS.md`.

**Rules:**
1. Admin keys only; other keys get 404 as for any private resource.
2. Read-only.
3. Pause or unpause is an ADMIN wallet transaction. The CLI prints an unsigned calldata draft like `resolution:draft` and never signs.
4. No raw evidence bytes or secrets in responses.
5. Reuse Task 16a's health details instead of duplicating them.

### Task A4: Alert delivery

**Goal:** Deliver the existing outbox `alert.*` events (budget, pause, RPC failure, keeper deadline, indexer lag) through an `AlertSink` port, with a stdout/file sink for local use and a generic webhook sink whose URL comes from config (D9 picks the target).

**Files:** port in `packages/ports`, sinks in `packages/adapters`, worker job `alert.deliver`, `tests/alerts.test.ts`, and `docs/M5_ALERTS.md`.

**Rules:**
1. At-least-once delivery with a dedupe key per alert.
2. A sink failure retries with backoff and never marks the alert delivered.
3. Deadline alerts come from a scheduler tick that does not depend on the keeper process (`docs/OPERATIONS.md`: "期限告警不依賴 keeper 單一 process").
4. Webhook payloads contain no secrets or private evidence.

**Drill:** the local harness triggers each alert once.

### Task A4b: Alert producers (added 2026-10-17 after the A4 review)

**Why:** the A4 review found that only `alert.deadline` has a producer. Spec §17.3 requires 「budget、pause、RPC 故障、keeper 超時告警可演練」. Delivery of injected events does not meet that. Each family must fire from its real condition.

**Goal:** a periodic worker job `alert.evaluate` that detects each condition, opens an alert episode, re-alerts while it stays open, and sends a CLEARED alert when it ends. All of these go through the A4 outbox → `alert.deliver` path.

**Files:**
- Create: migration `0022_alert_episodes.sql`, `packages/application/src/alert-evaluate.ts`, `packages/adapters/src/alert-evaluate-store.ts`.
- Modify: the worker registry, handlers and scheduler (scheduled like `scheduleResolution`), worker config, `packages/adapters/src/alert-payload.ts` (allow-list), `tests/postgres/alerts.test.ts`, the `drill:alerts` script, `docs/M5_ALERTS.md`, `docs/OPERATIONS.md`.

**Rules:**
1. **Episodes.** `operations.alert_episodes(deployment_id, family, subject, active, reason, opened_at, last_alert_at, consecutive_failures)`, keyed by `(deployment_id, family, subject)`. Grants follow 0019/0020: worker only, no PUBLIC.
   - Inactive → active: emit `alert.<family>` with `state: "OPEN"`.
   - Active for longer than the re-alert interval (default 60 min): emit `state: "STILL_OPEN"`.
   - Active → inactive: emit `state: "CLEARED"`.
   - The episode row and its outbox row are written in one transaction.
2. **Families and conditions.** Reuse existing queries and predicates; do not write a second version of them.
   - `alert.budget`:
     - the daily research gate, using the same SQL as health-reader `BUDGET_GATE_CLOSED`, with the reason taken from `gate_closed_reason`;
     - any closed question gate;
     - signer gas-cap refusals: `signing.sign_requests` rows with `state = 'REJECTED'` and `reject_code` in (`GAS_CAP_EXCEEDED`, `GAS_DAILY_CAP_EXCEEDED`) in the last 24 hours, with role as the subject (spec: 「超過即停止並告警」).
   - `alert.pause`:
     - the indexed global and per-market pause projection, with the same query as the A3 operator-status `pause()`; subject `global` or `market:<id>`;
     - a closed maker-pool gate; subject `pool`, reason `gate_reason`.
   - `alert.indexer_lag`: the health reader's `INDEXER_LAG` freshness predicate, with block and head numbers.
   - `alert.rpc`: when the worker has an RPC configured, probe it with `eth_chainId` and `eth_blockNumber` (5 s timeout, chain 84532 expected).
     - Open after 3 consecutive failures (configurable).
     - Clear on the first success.
     - Without an RPC configured, this family is not evaluated, and the docs say so.
   - `alert.keeper_overdue`: a non-FINAL market whose finalize is due (the keeper's own due predicate) and has stayed due for more than 600 chain-seconds (configurable). Subject `market:<id>`. This is separate from `alert.deadline`, which warns before a deadline.
   - `alert.jobs_dead`: the DEAD job count is above 0. The payload carries the count and job types only.
3. **Keeper independence.** `alert.evaluate` runs whenever the worker runs, including when execution and the keeper are not configured (`docs/OPERATIONS.md`: 「期限告警不依賴 keeper 單一 process」).
4. **Payload hygiene.**
   - The payload allow-list carries `deploymentId`, `family`, `state`, `subject`, `reason`, `since`, and numeric/block fields only.
   - `reason` and codes must match `^[A-Z0-9_]{1,64}$`.
   - No free-text errors, URLs, evidence, keys or job payloads.
5. **Drill.** `pnpm drill:alerts` creates each real condition in its test database (closed budget gate, gas-cap refusal row, pause projection, stale cursor, RPC probe against a closed local port, overdue market, DEAD job). It asserts OPEN delivered through the file sink, then clears the condition and asserts CLEARED. No injected `alert.*` rows remain in the drill.

**Tests:**
- Episode transitions, including no duplicate OPEN across ticks.
- The re-alert interval.
- CLEARED.
- One test per family from its real condition.
- Keeper not configured.
- Payload allow-list.

### Task A5: Backup and restore drill

**Goal:** The §17.3 "備份恢復成功" evidence, runnable locally and in CI: dump a deployment database, restore into a fresh one, replay canonical chain events, reconcile reservations, and reopen quoting only after reconciliation.

**Files:** `scripts/restore-drill.ts` (`pnpm drill:restore`), `tests/alpha/restore-drill.test.ts`, `docs/M5_RESTORE_DRILL.md`. It builds on Task 16's `chain:rebuild --verify` and the local Alpha harness.

**Rules:**
1. Uses `pg_dump`/`pg_restore` from the PostgreSQL 17 image, never a host install assumption.
2. Restored projections must equal the pre-dump projections and the contract views.
3. Quoting stays gated (`RECONCILE_REQUIRED` or `OVERCOMMITTED`) until the reconciler clears it.
4. The object archive restore is out of scope until D3 picks storage; the drill documents that limit.

### Task A6: Deployment runbook and preflight

**Goal:** A step-by-step runbook from empty infrastructure to a ready Alpha, plus `pnpm deploy:preflight <env-file>`, which validates every service's environment offline.

**Files:** `docs/DEPLOYMENT_RUNBOOK.md`, `scripts/deploy-preflight.ts`, `tests/deploy-preflight.test.ts`, `deployments/base-sepolia/env.example` (only `<TO BE PROVIDED: …>` markers).

**Rules:**
1. Variable lists come from the config parsers in `apps/*/src/config.ts`, not from memory. A test fails if a parser accepts a variable the runbook does not list.
2. The preflight rejects placeholder markers, chain ID ≠ 84532, secrets in `NEXT_PUBLIC_*`, world-readable key files, and a signer URL that is not private/loopback.
3. The runbook order:
   1. Contracts (`contracts:deploy` dry run, then `--broadcast` by the user).
   2. `manifest:verify`.
   3. `db:migrate`.
   4. `deployment:register`.
   5. Signer.
   6. Indexer catch-up.
   7. Worker.
   8. API.
   9. Readiness.
   10. REPLAY smoke.
   11. Open trading.
4. Rollback means a new deployment ID, never an in-place contract change.

### Task A7: Feedback entry (needs D6)

**Goal:** The spec §19 feedback form fields (role, the question they would forecast, current alternative, would they use it again, agent integration obstacles, optional contact with consent), delivered through the channel D6 picks. The site links to it.

**Rules:** Copy only, unless D6 picks an embedded form, which then needs a mockup. Contact details are optional, with consent stated before display.

### Task A8: Demo script

**Goal:** A written 3-minute storyboard following spec §19 (30 s problem, 60 s data to forecast, 60 s RFQ trade and rights, 30 s REPLAY result and next steps). It runs on the local Alpha harness, with historical data labelled. Recording is the user's (D10).

**Files:** `docs/M5_DEMO_SCRIPT.md`.

### Task A9: Follow-ups found by the A1 container runs (added 2026-10-17)

**Why:** The A1 full container run (keeper finalize and redeem in containers, 5764 s) and its review found three product defects. Local harnesses did not show them.

**Files:**
- Modify `packages/application/src/signer.ts` and the signer store (`deploymentEnabled` read).
- Modify `packages/application/src/tx-dispatcher.ts`.
- Modify `scripts/deploy-preflight.ts` and `docs/DEPLOYMENT_RUNBOOK.md`.
- Modify `docs/M5_SERVICE_IMAGES.md` (remove the restart workaround note).
- Add tests beside the existing ones.

**Rules:**
1. **Trading flag per request.** The signer reads the deployment's current `manifest.tradingEnabled` per quote sign request, in the same transaction that reads `enabled` today (`signer.ts`, `tx.deploymentEnabled`). It stops using the copy loaded at start.
   - The startup manifest is still used for contracts, roles and the startup equality check.
   - Turning trading off makes the next quote sign return `TRADING_DISABLED` without a restart. Turning it on lets the next one through without a restart.
   - Transaction kinds keep their current gating: keeper finalize must keep working while trading is off.
   - Test both directions against a running service instance.
2. **Dispatcher error mapping.** `TxDispatchError` becomes a `JobError` (or maps to one) with its own retryable flag. This way the worker logs and dead-letters with the dispatcher's real code (for example `SIGN_REJECTED:POLICY`, not retryable) instead of retryable `INTERNAL_ERROR`.
   - Update `tests/job-failures.test.ts`, which documents the mismatch today.
   - Check that the `jobs_dead` alert and admin metrics then show the real codes.
3. **Worker → API URL.** The preflight rejects a `WORKER_API_URL` that is neither https nor a loopback host, with its own code and a test. This matches what `@blink/client` accepts.
   - The runbook explains the two valid layouts: same host over loopback, or https between hosts.
   - The runbook drops any "restart the signer after enabling trading" step that rule 1 makes unnecessary.

---

## Track B — needs the user's decisions and authorization

Each step lists its prerequisites. The agent prepares commands and checks. The user, or an agent with explicit approval for that exact step, executes anything outward-facing.

- [ ] **B1 Provision** (D3, D4): app host, signer host, managed PostgreSQL, bucket with versioning/retention, RPC primary/backup, secret manager, network ACL/mTLS between API/worker and the signer. Record choices and costs as quoted by the providers. Never estimate a price.
- [ ] **B2 Keys** (D5): the user generates each role key outside agent sessions and stores signer keys as 0600 files on the signer host. The four human roles stay in the user's wallets. The user funds Sepolia ETH; gas caps stay at 0.0002 ETH per transaction and 0.002 ETH per role per day.
  - Progress (2026-10-20): the user generated the nine role keys (deployer, the four human roles, maker, faucet minter, keeper, internal trader) outside the repo and agent sessions as 0600 files, and funded the deployer from the CDP faucet (0.0009 ETH). The human-role keys still have to be imported into the user's wallet before those roles act.
- [ ] **B3 Contracts** (D4, D5): `pnpm contracts:deploy` dry run, then the user runs `--broadcast`; then `manifest:verify` and publish the manifest. Contract source and ABI must be verifiable (§17.3 bullet 2).
  - Progress (2026-10-20): the dry run passed on `811c6a7` against `https://sepolia.base.org` (chain 84532, constructor arguments matched the role addresses). The first broadcast, deployment ID `alpha-1`, deployed BlinkTestUSD at `0x83517271696F7420296EDD7872BC50C5B83141A8` and then failed before sending BlinkMarket with `Execution reverted for an unknown reason`; the deployer's nonce was 1 and no manifest was written. A read-only estimate of the same market deployment succeeded minutes later, so the likely cause (an inference, not proven) is that viem's gas estimate reached an RPC node that had not yet seen the token's block. That token is not part of any deployment.
  - Fix merged in `346b4f0`: explicit nonces and gas, a read-only gas estimate and the post-deploy verification retried 30 × 1 s, sends never retried (`docs/M5_DEPLOYMENT_TOOLING.md`). Verification: `pnpm check` 697 pass, `pnpm test:anvil` 54 pass, service build tests 6 pass. Then the user broadcast deployment ID `alpha-2` from `0ae8f36`: BlinkTestUSD `0x6A656a6576DFfB6697754E378B3f8d620c7250FC`, BlinkMarket `0x0936fDce1aCB72c88a786250b5454094068D41b9`, deployment block 48371702, `tradingEnabled: false`; the tool's own verification passed, and `pnpm manifest:verify` against `https://sepolia.base.org` returned `verified; does not enable trading`. The manifest is kept by the user outside the repo. The deployer has 0.000878 ETH left (nonce 3).
  - Still open in B3: publishing the manifest (outward-facing; needs the user's approval of where), and source/ABI verification on a public explorer (§17.3 bullet 2).
- [ ] **B4 Services** (B1–B3, A1, A6): migrate, register, start in runbook order, readiness green, alerts delivered to the D9 channel, then the restore drill (A5) on the real database.
- [ ] **B5 Markets** (D7, D8): REPLAY normal/dispute/timeout scenarios on Base Sepolia through finalize and redeem (§17.3 bullet 3). Either a LIVE market with timestamped forecasts, or the "restricted preview" label.
- [ ] **B6 External acceptance** (D10): one non-team operator submits forecasts and completes an invited test trade using only the docs and the Task 15 example. A separate usability check. The two sets of metrics are kept apart.
- [ ] **B7 Publish** (D6, D10): README and site updated to "deployed on Base Sepolia (testnet)" with the true caveats, OpenAPI, client example, feedback entry and demo video.

## Free-first candidates for D3, D4, D6 and D9 (researched 2026-10-17)

The user asked for free or the cheapest options while the project is experimental. Figures below are quoted from each provider's own page as fetched on 2026-10-17 unless marked otherwise; none is a commitment, and nothing is signed up for or provisioned without the user's go-ahead. Pages carry no "last updated" date, so re-check before choosing.

| Need | Free candidate | What the provider's page says | What it gives up |
| --- | --- | --- | --- |
| App host (api, worker, indexer) | Oracle Cloud Always Free, Ampere A1 (arm64) | "first 1,500 OCPU hours and 9,000 GB hours per month for free", "equivalent to 2 OCPUs and 12 GB of memory"; 200 GB block storage | Oracle may reclaim instances idle over 7 days (95th-percentile CPU, network and, on A1, memory all under 20%). Secondary reports say the A1 allowance was halved in June 2026 without announcement. No SLA |
| Signer host (separate) | A second Always Free instance: an A1 slice or an AMD micro ("1/8 OCPU", "1 GB memory", up to two) | as above | Same account as the app host; separation is per instance and per OS user, not per provider |
| PostgreSQL | Self-hosted PostgreSQL 17 on the app host (A1 image, A5 drill for dump/restore) | — | Not managed: backups, upgrades and disk are ours |
| PostgreSQL (managed, alternative) | Neon Free: 100 CU-hours per project, 1 GB storage, scale-to-zero after 5 minutes "cannot be turned off", 6-hour history | — | The worker and indexer poll continuously, so the compute never sleeps; at the smallest size a full month needs more than 100 CU-hours. Neon Launch is $0.106 per CU-hour and $0.35 per GB-month (pay as you go) |
| PostgreSQL (managed, alternative) | Supabase Free: 500 MB, "paused after 1 week of inactivity", automatic backups "Not included" | — | No backups; Pro is $25 per month |
| Private bucket | Oracle Object Storage (Always Free 20 GB), Backblaze B2 ("First 10GB storage is always free", then $6.95/TB/month) or Cloudflare R2 (10 GB-month free, then $0.015/GB-month) | — | None of the three pricing pages confirms versioning plus retention on the free allowance; verify before choosing (plan requires versioning/retention) |
| RPC primary | Alchemy Free: "30M CU per month", "15 requests per second", "All mainnets & testnets" | — | Archive access on Free is not stated clearly; verify `eth_call` at `deploymentBlock − 1` and the `finalized` tag before relying on it |
| RPC backup | Base's public endpoint `https://sepolia.base.org` (chain 84532) | page states no rate limit and no production guidance | Unknown limits and archive depth; a second free provider account is the alternative |
| Site | GitHub Pages (today) | — | — |
| API URL | needs a hostname with TLS | — | Open: a domain the user owns, or a free hostname service; the user picks |
| Alerts (D9) | a chat webhook the user owns | — | Payload shape must match what A4's webhook sink sends |
| Feedback (D6) | a free form tool with the §19 fields and an optional, consented contact field | — | The user picks the tool |

Cheapest paid fallback if a free tier fails: a small VPS per host. Secondary sources (not the provider's page) put Hetzner's smallest shared plans at about €5.49–5.99 per month after a June 2026 increase; confirm on the provider's page before choosing.

Consequence for Track A: Oracle's free A1 is arm64, so the A1 images must build and run on linux/arm64 (the build machine is arm64 today).

## Track C — functional web UI (only if D1 = b)

A separate plan, written after mockups of the trading area (§13.2 confirmation fields, approve exactly the needed amount, re-quote on expiry, probability vs ask vs fill price shown apart), positions and redeem, settlement detail, and the admin console. It depends on D2. Not planned further here.

## Open Items (deferred; not done by this plan)

1. Functional web UI (D1); human taker authentication (D2).
2. Paid model provider (D7) and LIVE companies (D8), if the user defers them.
3. Shared rate limiter and multi-instance API, before horizontal scaling.
4. Signer key encryption at rest beyond file permissions; hardware or KMS custody.
5. Smart-account (ERC-1271) wallets (out of v0.1 scope, ADR 0002 §7).
6. Parked findings from the previous plan (2026-10-14), copied from its SDD ledger at its close on 2026-10-16:
   - Before any Sepolia deployment (from the whole-branch review): retention for `operations.jobs` and `operations.outbox` and indexes for the worker's recovery lookups; trusted-proxy configuration for the per-IP limiter behind TLS ingress; unmapped outbox events (`alert.deadline`, `market.creation_requested`, `market.creation_observed`) are stamped dispatched with no consumer — keep them for the alert sink (A4) or list them as unconsumed; declared job types never enqueued or handled (`candidate.validate`, `market.deploy`, `budget.reconcile`, `chain.reconcile`, `tx.track`) — `budget.reconcile` must exist before any paid model gateway; a harness or seam test with per-caller signer tokens (maker-only API, keeper/faucet/trader worker) and distinct logins; the runtime-role refusal should say what to fix (`runtime-role.ts`).
   - T1/T3: minors in their review files; the rate limiter's trusted proxy (as above).
   - T4: deployment write errors drop their cause; the deploy-contracts test helper.
   - T5: idle-poll gate clear; a mismatch detours through reorg handling; maker row recreate; no bound on DROP retries; no EIP-1898 fallback; no tooling to clear FINALIZED_CONFLICT.
   - T8: operator tooling for an abandoned v1 nonce hole; FINALIZED is reached only through fakes in tests; a non-final revert shows as INCLUDED.
   - T9: Minors M6–M12 (M11's unused grants need a new migration), plus the duplicate signer call on concurrent stale-quote resumes.
   - T10: no whoami check; no reaper for pending answers; truncation.
   - T11: archive-absent reporting; polling cadence; the challenge draft outcome; admin list ordering.
   - T13: the long Anvil scenario; a clock offset restored without `finally`; no lock-interleaving test; a disabled deployment after the v1 plan abandons a nonce.
   - T14: no mandate administration tool; wallet binding needs a trader-key signature; one trader per deployment (the job queue cannot route by role); the session-settable clock in the trader view (M4); M6–M8 (caps enforced only in the worker).
   - T15: `Retry-After` above the client's cap is still retried; untested `QUOTE_EXPIRED` branch and `MAX_QUOTE_ATTEMPTS` exhaustion; the example's Anvil test composes the stack by hand; `consumed(digest)` read from a node behind the one that served chain time.
   - T16a: no deadline on `/v1/health` database reads; harness clock jumps inflate transaction latency metrics.
   - T16b: the leak check looks at the whole shared server; on a failing run the stage-keyed abort test's `finally` SIGKILLs the child and can leave its database and Anvil behind; the pump's delay is not tied to the run's signal; ack-level worker errors (`LEASE_LOST`, `JOB_ACK_FAILED`, `JOB_LEASE_FAILED`) are not reported; the window scheduler, creation tracker, quote reconciler and scoring run directly rather than through the worker's ticks.
   - T17: `FORCE_COLOR`/`NO_COLOR` warnings in the browser run; the `metadataBase` localhost warning.
   - Done by the user (reported 2026-10-17): GitHub repository setting Issues → "Creation allowed by: Collaborators only".
7. Real Safari and real-device checks for the site; CSP inline styles; site search (from `docs/M4_WEB_SHOWCASE_DELIVERY.md`).
8. Per-mode (LIVE/REPLAY) budget split.
9. Parked findings from this plan's Track A (copied from its SDD ledger at Track A close, 2026-10-17):
   - A1: the `--market` (about 34 min) and `--full` (about 96 min) smokes are slow because of the forecast-window rules and are not in CI; in Compose the worker shares the API's network namespace because `@blink/client` accepts only https or the exact loopback hosts (the runbook lists both valid layouts); the worker's `/health/ready` is loopback-only. The `tx.dispatch` retries after the faucet mint are the handler's designed `TX_PENDING` (it retries until the transaction is FINALIZED; job row seen at attempt 4 of 10 on `main`). **Before any Sepolia deployment:** each `TX_PENDING` retry uses an attempt; the backoff starts at 5 s, doubles and caps at 300 s, and `max_attempts` is 10, about 20 minutes in total. Compare that with the measured Base Sepolia finalized-head lag; if the lag is longer, the job dead-letters (and raises a `jobs_dead` alert) while the transaction is fine.
   - A3: identity service built per request; the 20000000 default cap is hard-coded in the status display; admin diagnostics (jobs, budgets, pause) are global, not scoped per operator (fine for a single-operator Alpha); `approval.state` is a plain string.
   - A4: no startup check that the alert sink is reachable; the runbook's post-start step covers it by hand.
   - A4b: pause-family truncation keeps the pool alert from clearing above 100 paused markets; the worker pool's max of 4 connections with one pinned by the evaluation lock; no "last successful evaluation" health signal.
   - A5: the drill test waits a fixed 65 s.
   - A9: the signer trading-flag test toggles one service instance only (no second instance or clock change).
