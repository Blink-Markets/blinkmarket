# M5 health and execution metrics — Task 16a

> Partly historical: health and the admin execution metrics described here assumed the v0.1 `trading` API mode, the signer and the budget gates, which no longer exist. The API's modes are `scaffold`, `identity` and `markets`, and no key can carry the `admin` scope any more. See [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md).

## Delivered scope

- `GET /v1/health` returns exactly `{status, tradingEnabled, reasons}` publicly,
  with HTTP 200 for ready and 503 otherwise. An authenticated admin bearer key
  adds `details`: queue counts, chain cursor freshness, signer readiness,
  daily/question budget gates, and maker pool/reconciliation gates.
  A supplied invalid or non-admin key gets the normal 401/403 error envelope.
  Responses are `Cache-Control: no-store`; exceptions become a fixed readiness
  reason, never database URLs, tokens or exception text.
- Trading-mode API composition connects the database reader and a bounded
  three-second request to the signer's `/health/ready`. No signer bearer token
  is sent to this read. `/health/ready` on the API uses the same public readiness
  decision. Earlier API modes and scaffold remain not ready.
- `GET /v1/admin/metrics` requires admin scope. The shared schema generates the
  OpenAPI contract and web API reference. Metrics include RFQ creation-to-sign
  and transaction submission-to-receipt-observation p50/p95 in milliseconds,
  sample counts, quote/attempt/job status counts, persisted error-code counts,
  and exact decimal-string gas spend/reservations by role and UTC day.
- `docs/ACCEPTANCE_MATRIX.md` maps all C01–C15 and S01–S12 to test files and
  commands, separating automated local evidence from public Alpha manual/deployment evidence. The subsequently integrated client and harness coverage is linked there.

## Readiness and metric semantics

Database reads use repeatable-read transactions. Cursor freshness uses the shared
ten-second database-clock staleness expression and a maximum three-block lag,
with any chain gate closing readiness. An orphaned settled reservation or an
explicit RECONCILE_REQUIRED reservation closes readiness before quoting resumes.
An exhausted or explicitly closed current daily research budget closes overall
readiness; individual question gates are counted for admin diagnostics. Health
is deployment-level availability, not a promise that a particular market/taker
passes every RFQ condition. Per-market pause, forecast age, allowlist and quote
gates remain enforced by the existing RFQ and market-read services.

Latency percentiles use PostgreSQL `percentile_cont`. Empty samples yield null
percentiles. Unsigned quotes and transaction attempts without both timestamps,
negative clock intervals and orphaned attempts do not contribute. Counts are
current persisted rows, not a history of every HTTP request; errors group
`signer:`, `job:` and `transaction:` codes. Metrics cover all deployments and all
recorded time. Gas is read from the authoritative role/day ledger.

Migration `0019_observability.sql` adds a stable `included_at` timestamp, set by
a trigger on receipt observation on the business clock (`blink.now()`, as for
`submitted_at`, so latency stays correct under a test-clock offset), preserved on
finalization and cleared on reorg. Receipt observation measures when the service
saw inclusion, not the block's timestamp. Old receipts are deliberately not backfilled from mutable
`updated_at`. The API gains column-only reads of attempt status/timestamps and
read access to the gas ledger; it still cannot read raw signed transactions or
attempt transaction hashes. Existing migrations are unchanged. Number 0018 is
now delivered by the [internal trader](M3_INTERNAL_TRADER.md) task.

## Verification

Verified locally on 2026-10-15:

- `pnpm check`: passed, 500 Node tests, both TypeScript checks, contract
  compilation and package boundary checks.
- `pnpm test:contracts`: passed, 24 tests including fuzz and invariants.
- `TEST_POSTGRES_ADMIN_URL=<local test URL> pnpm test:postgres`: passed,
  31 tests including real-role observability grants and percentile calculations.
- `pnpm test:anvil`: passed, 44 tests on local chain ID 84532.
- `pnpm build:services && pnpm test:service-build`: passed, 5 bundle tests.
- `pnpm build`: the first run was blocked by Google Fonts access and passed with
  temporary offline font fixtures as described below; the ordinary run passed
  in the fix round.
- Acceptance matrix validation: all 27 required cases appear exactly once and
  all referenced existing test files existed; the Alpha harness was pending at that checkpoint and is now integrated (see [Local Alpha](M5_LOCAL_ALPHA.md)).
- `git diff --check`: passed.

HTTP/PostgreSQL/Anvil tests and Turbopack used local-loopback sandbox escalation.
The first full check found the new metrics contract missing from the architecture
route registry; the registry was corrected, the targeted five tests passed and
the complete check then passed.
The ordinary web build needs external Google Fonts downloads, which this task
does not authorize. An additional full build with temporary CSS fixtures serving
installed local font bytes verifies Turbopack source exports and prerendering;
it does not verify production font downloads or appearance.

## Remaining work

Task 16b owns `scripts/local-alpha.ts`, `tests/alpha`, `pnpm alpha:local`, CI
integration and `docs/M5_LOCAL_ALPHA.md`; those are now delivered separately. This health/metrics slice did not verify the harness; see its delivery record for results and limits. Real deployment, LIVE events, external-user acceptance, alert operations,
backups and demo publication remain the manual work in the acceptance matrix.

## Final review fix B — 2026-10-16

Both `/v1/health` and `/health/ready` now consume the same per-IP public-read
bucket as other public reads. The health service shares one single-flight
snapshot across both routes for two seconds, including failed reads; signer
reachability has its own two-second single-flight cache. Diagnostics still
require an authenticated admin, and authorization is checked on every supplied
key before accessing the snapshot. Readiness can lag dependency failure by the
cache interval (plus dependency response time); responses retain `no-store`.

Health queue counts cover only QUEUED, LEASED and DEAD, including zero counts.
Each count has its own literal state predicate so PostgreSQL can use the
`jobs_due`, `jobs_lease` and new `jobs_dead` partial indexes. Migration
`0020_runtime_health_hardening.sql` adds the missing DEAD index and removes
PUBLIC EXECUTE from every function in the application schemas. Explicit
`blink.now()` grants remain for the four runtime groups and trading admin;
existing trigger execution needs no direct function grant. Admin metrics retain
their historical status counts.

The API (including markets mode), research-only worker, creation poller and
transaction tracker now check the production business clock at startup. API,
worker, signer and indexer readiness paths re-check it on each request. Existing
explicit local test-clock opt-ins remain unchanged. All four runtime guards use
one predicate requiring a plain authenticated login with only its service group,
no extra memberships, no database ownership and no CREATE on application
schemas; owner sessions using SET ROLE are refused.

Verification: `pnpm check` passed (598 tests); `pnpm test:postgres` passed (50);
`pnpm test:anvil` passed (50); `pnpm build:services && pnpm test:service-build`
passed (5). A final `pnpm typecheck` and `git diff --check` also passed.
The ordinary web build could not fetch Geist, Geist Mono and Kalam from Google
Fonts. This slice does not claim deployment or completion of the remaining
milestone work.
