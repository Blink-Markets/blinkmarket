# P2 off-chain protocol progress

## Task 1 — platform execution retirement (2026-10-24)

The signer workspace, platform dispatcher, keeper, faucet worker, internal trader,
and single-maker quote/pricing service are retired. API modes now stop at
`markets`; preparation, approval, research and forecast work remain for Task 2.
Transaction observation remains in the indexer, with its port types isolated in
`packages/ports/src/tx-tracking.ts`.

Migration `0025_retire_platform_execution.sql` removes the retired storage and
roles without changing historical migrations. It dead-letters queued execution
and quote-reconciliation jobs with `RETIRED_P2`, clearing and fencing old leases.
Health, metrics, alerts, service bundles, container configuration and operational
drills now use the surviving infrastructure. Legacy SDK execution methods refuse
locally with `RETIRED_P2` pending the later client replacement. PostgreSQL tests
run serially because historical migrations create the cluster-wide roles that
0025 drops.

### Verification

- Required retirement tests failed before implementation: 6 passed, 2 failed.
- Focused regression suite: 174 passed, 0 failed.
- The single full `pnpm check` run passed TypeScript and contract checks, then
  reported 536 passing tests and 3 stale RFQ expectations in identity/scaffold
  tests. Those expectations were corrected; the complete affected suites plus
  the required retirement suites passed on rerun: 20 passed, 0 failed.
- Final TypeScript and dependency-boundary checks passed separately. The full
  15-minute command was not repeated after the test-only corrections, following
  the instruction to run full verification once.
- Final `pnpm build:services` and `pnpm test:service-build` passed: four bundle
  checks, no signer or trading-admin output.
- `pnpm build` reached the native Turbopack loader and failed because the host
  lacks GLIBC_2.29. The production Webpack fallback passed, including TypeScript
  checking and all 37 static pages.
- PostgreSQL suites, Docker image smoke, restore drill, and remaining Anvil suites
  were not run locally. Their affected tests/configuration were updated for CI.

The restore drill now checks infrastructure rows, schema, grants and cursor lease
recovery against a quiescent database. The old trading/contract roundtrip depends
on the retired Alpha harness; the replacement protocol harness remains later work.

This completes only the Task 1 implementation scope, not the P2 milestone. Later
tasks still own research/approval removal, protocol-facing APIs/indexing, clients
and documentation. No push, merge, deployment or live transaction was performed.

## Task 2 — research, approval and invitation retirement (2026-10-24)

The platform no longer runs any research or approval role. Retired: market
discovery, the two platform forecasters and the baseline, the model gateway and
budget ledger, candidate preparation and approval, market-creation tracking and
the creation poller, invitation-style identity administration, resolution
drafts and the local replay driver. Agents create markets, forecast and resolve
on their own through the P1 protocol contracts.

What remains: forecast windows and agent submissions (keyed by agent, with no
snapshots or platform agents), per-submission Brier evaluation, the outbox,
retention and alert jobs, and `forecast-admin` (annotations only; Task 10 deletes
it). The API has three modes: `scaffold`, `identity` and `markets`. The
`/v1/admin/*` candidate, budget, resolution and creation-intent routes,
`/v1/candidates*` and `/v1/markets/:id/resolution-reports` are gone. The worker
registry holds only `forecast.schedule`, `evaluation.score`, `alert.deliver`,
`alert.evaluate` and `operations.prune`. `allowlist-fetcher` and `network-policy` stay for P3. `GET /v1/evidence/:id` and
`GET /v1/specs/:specHash` return 501 until Task 8 replaces them with
`/v1/content/:hash`.

Migration `0026_retire_platform_research.sql` is the only schema change. It marks
the retired job types `DEAD` with `RETIRED_P2` (leases cleared and fenced, as in
0025), deletes budget alert episodes, recreates the `analytics.final_forecasts`
view without the platform-agent join, then drops the retired tables child before
parent, with no CASCADE and the deferred candidate/revision constraint dropped
first. Evaluation now scores every agent submission as `AGENT`; the old
`ENSEMBLE` and `BASELINE` rows stay in the append-only table but are ignored by
public metrics. Metrics lose the spend fields; market detail loses the snapshot
and cost fields; the list loses the `entity` filter.

### Verification

- Required tests failed before implementation: `platform runs no research or
  approval roles` and `0026 retires research and approval objects` (2 failed).
  After implementation both pass with the rest of those two files (10 passed).
- `pnpm check`: typecheck (root and web), contract checks, 413 unit tests and
  the boundary check all passed.
- `pnpm build:services` and `pnpm test:service-build` passed (4 bundle checks).
- `node --import tsx --test tests/anvil/*.test.ts`: 34 passed, 0 failed.
- `pnpm build` cannot run on this host (Turbopack needs a newer glibc); the web
  typecheck passed.
- PostgreSQL suites (`tests/postgres/*`), Docker image smoke and the restore
  drill need services this host lacks. Their sources were updated for the new
  schema and typecheck, but they were not executed locally; CI must run them.
- An earlier full unit run exposed 12 stale expectations (API modes, removed
  routes, budget health gate, retired job names). They were corrected and the
  affected suites rerun, then `pnpm check` was run in full and passed.

This completes only the Task 2 scope, not the P2 milestone. No push, merge,
deployment or live transaction was performed.

## Task 5 — multi-contract protocol index, part 1 (2026-10-24)

The indexer now reads the registry, jurors, markets, resolution, faucet, anchor
and governor of a registered protocol generation. Logs retain their emitter and
contract, decode strictly, and are ordered by block and log index. Unknown,
removed, pending or foreign logs fail the batch. Juror/resolution events needed
by Task 7 and non-adoption governor events remain explicitly journaled; this
stage never executes governance.

The pure fold covers registration, roles, obligations, stored credit, templates,
PENDING/OPEN/PROPOSED/DISPUTED/FINAL/CANCELLED markets, fills, positions, per-maker
balances and epochs, digest status, fee pools, redemptions, anchors and successor
adoptions. `tradable` accepts only OPEN markets before their close time.
`postgresProtocolReader` implements the shared reader contract, including the
30-second timestamp-lag gate and refusal of missing, gated or stopped indexes.

Migration 0029 replaces the retired chain projection tables with protocol event
and projection tables. It preserves the cursor, block history, lease tokens,
version fencing and reorg tombstones. Pinned contract-view checks protect each
advancing range; ranges ending before a contract's deployment also advance
correctly. Rebuilds use a consistent snapshot and repair every projection from
the canonical journal. Three temporary protocol read views keep the surviving
public-read, forecast, evaluation and monitoring services working until their
Task 7/10 replacements; their fixtures now write the protocol tables.

The v0.1 market contract, its interface/tests, reducer, ABI, log/store adapters
and deployer are removed. The artifact compiler removes stale v0.1 artifacts;
BlinkTestUSD and its interface remain. Image-smoke deployment now uses the alpha
protocol preset and manifest v2. The API receives an additive ProtocolReader
parameter; Task 6 owns consuming it for identity authorization when merged.

### Verification

- RED: the required three-file command failed with all three new modules absent.
- Final required reducer/indexer/Anvil command: 18 passed, 0 failed.
- Reorg and cursor safety suite: 15 passed, 0 failed, including restoration of
  accounts, roles, credit, templates, market state, balances, positions, fills,
  digests, anchors and successor observations.
- Real BlinkRegistry Foundry traces confirm credit 100 becomes 100, 50, 25 and 0
  after 0, 1, 2.5 and 40 half-lives. Partial-period materialization is covered.
- `pnpm test:contracts`: 237 passed; ProtocolInvariantTest seeds 0x01 and 0x02:
  4 passed per seed, no failures.
- `pnpm test`: 419 passed, 0 failed on the final complete run.
- Root and web TypeScript, contract compilation/EIP-170, dependency boundaries,
  service bundles and all four service-bundle checks pass.
- `pnpm check` was invoked once and stopped at a viem test-fixture inference
  error. After narrowing the fixture ABI types, the constituent gates were run.
  The first complete unit run found one reference to the deleted interface;
  it was changed to IBlinkMarkets.sol, then the full unit suite was rerun.
- PostgreSQL concurrency suites and Docker smoke were updated but were not run
  locally. `pnpm build` cannot run on this host because Turbopack requires a
  newer glibc; web typechecking passed.

### Credit-clock concern

BlinkRegistry can materialize already-decayed-to-zero credit during reportLoss
without emitting CreditLost. A later CreditGained or CreditImported event alone
cannot identify the resulting private updatedAt exactly. A Foundry regression
uses the real registry to demonstrate two such clock histories with different
future creditOf results. The fold refuses this ambiguous case and leaves the
index gated instead of inventing a clock. Continuous indexing through this case
needs a controller decision: reconstruct every silent reporter call (including
Task 7 settlement semantics), or expose sufficient on-chain credit-clock data.
The registry runtime was not changed in this task.

This delivers only the Task 5 slice, with the credit-clock concern above; it does
not complete P2. No push, merge, rebase, deployment or live transaction was made.
