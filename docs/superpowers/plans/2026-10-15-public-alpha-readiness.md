# Public Alpha Readiness (M5, with the M4 decision) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Track A approved by the user on 2026-10-17, with D1 = (a), D7 = (a) and D8 = (b) as recommended. A2 is deferred until an API is deployed (it is optional and needs a mockup); A7 waits for D6. Track B is not approved: it still needs the user's answers to D3–D6, D9 and D10 and an explicit go-ahead for each outward-facing action. For those choices the user prefers free or the cheapest options while the project is experimental.

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

---

## Track B — needs the user's decisions and authorization

Each step lists its prerequisites. The agent prepares commands and checks. The user, or an agent with explicit approval for that exact step, executes anything outward-facing.

- [ ] **B1 Provision** (D3, D4): app host, signer host, managed PostgreSQL, bucket with versioning/retention, RPC primary/backup, secret manager, network ACL/mTLS between API/worker and the signer. Record choices and costs as quoted by the providers. Never estimate a price.
- [ ] **B2 Keys** (D5): the user generates each role key outside agent sessions and stores signer keys as 0600 files on the signer host. The four human roles stay in the user's wallets. The user funds Sepolia ETH; gas caps stay at 0.0002 ETH per transaction and 0.002 ETH per role per day.
- [ ] **B3 Contracts** (D4, D5): `pnpm contracts:deploy` dry run, then the user runs `--broadcast`; then `manifest:verify` and publish the manifest. Contract source and ABI must be verifiable (§17.3 bullet 2).
- [ ] **B4 Services** (B1–B3, A1, A6): migrate, register, start in runbook order, readiness green, alerts delivered to the D9 channel, then the restore drill (A5) on the real database.
- [ ] **B5 Markets** (D7, D8): REPLAY normal/dispute/timeout scenarios on Base Sepolia through finalize and redeem (§17.3 bullet 3). Either a LIVE market with timestamped forecasts, or the "restricted preview" label.
- [ ] **B6 External acceptance** (D10): one non-team operator submits forecasts and completes an invited test trade using only the docs and the Task 15 example. A separate usability check. The two sets of metrics are kept apart.
- [ ] **B7 Publish** (D6, D10): README and site updated to "deployed on Base Sepolia (testnet)" with the true caveats, OpenAPI, client example, feedback entry and demo video.

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
   - GitHub repository setting (the user's action): Issues → "Creation allowed by: Collaborators only".
7. Real Safari and real-device checks for the site; CSP inline styles; site search (from `docs/M4_WEB_SHOWCASE_DELIVERY.md`).
8. Per-mode (LIVE/REPLAY) budget split.
