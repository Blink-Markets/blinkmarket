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
`GET /v1/specs/:specHash` returned 501 until Task 8 replaced them with
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

## Task 6 — self-serve wallet identity (2026-10-24)

An identity is now a wallet address. It proves control with a signature and
receives an API key, with no invitation and no operator console.

- `POST /v1/auth/wallet-challenges` (public) takes `{ address, action: "issue" |
  "revoke", keyId? }` and returns `{ challengeId, message, expiresAt }`. The TTL
  is 300 s. The limits are 30 per hour per trusted client IP, and, per
  (client IP, address) pair, 10 per hour and at most 5 pending challenges. They
  are keyed by pair because asking for a challenge needs no proof of control: an
  address-only key would let anyone lock a victim out of issue and revoke. The
  IP allowance is charged first and stops the request, so a refused request
  spends no address token. The
  message keeps the v1 text, adds `Action:`, and carries a `Key ID:` line only for
  revoke. The `Agent ID:` line is gone because no agent exists yet.
- `POST /v1/auth/wallet-verifications` (public) takes `{ challengeId, signature }`.
  The check goes through the `SignatureVerifier`, so EOAs, ERC-1271 contract
  wallets and ERC-6492 signatures all work; an RPC failure answers `503
  SIGNATURE_CHECK_UNAVAILABLE`. `issue` also needs a fresh index (`503
  INDEX_STALE`, including when the reader errors) and a registered account (`403
  NOT_REGISTERED`). It creates the operator, agent and wallet binding on first use
  and returns `{ apiKey, keyId, expiresAt }`: 30 days, at most 5 active keys per
  address (`409 KEY_LIMIT_REACHED`), scopes `forecast:write`, `rfq:write`,
  `content:write`, `suggestion:claim`. `revoke` needs neither registration nor a
  fresh index and revokes the key only if the signing address owns it.
- A challenge is single use (`409 WALLET_CHALLENGE_USED`) and expires
  (`409 WALLET_CHALLENGE_EXPIRED`). It is consumed only when a key is issued or
  revoked, so a refusal for index or registration reasons leaves it usable.
- `ApiScope` is exactly the four scopes above. `authenticateIdentity` returns
  `{ keyId, agentId, address, scopes }` plus the internal `operatorId` that the
  forecast and idempotency code still keys on. The legacy `admin` scope is not an
  `ApiScope`; only the operator-status and health checks (deleted by a later task)
  still ask for it, and nothing can issue it any more.
- `identity-crypto` no longer recovers addresses; no source under `apps/` or
  `packages/*/src` calls `recoverMessageAddress` or `recoverTypedDataAddress`.
  `apps/api/src/main.ts` wires `rpcSignatureVerifier(BASE_SEPOLIA_RPC_URL)` and a
  reader parameter (`protocolReaderFor`). Until Task 5 plugs in the real reader it
  reports a stale index, so no key is issued; without an RPC URL every signature
  check is unavailable.

Migration `0028_self_serve_identity.sql` adds the `SECURITY DEFINER` functions
`identity.issue_self_serve_key` and `identity.revoke_self_serve_key` (EXECUTE for
`blink_api` only, fixed search path). They lock the challenge row, so concurrent
verifications issue one key, and they hardcode the lifetime, scopes and key limit.
It makes challenge `key_id` and `agent_id` nullable and adds `action` and
`target_key_id`, widens the scope check for the three new scopes, revokes every
active invite key (`revoked_at = now()`), takes INSERT on `wallet_bindings` and
UPDATE of `consumed_at` away from `blink_api`, and drops `blink_identity_admin`
after revoking its grants.

### Verification

- RED: `node --import tsx --test tests/identity.test.ts` against the unchanged
  sources failed 19 of 20 tests (the first with `401 !== 201`: the challenge
  endpoint still demanded a key). The tests were written after the implementation
  and the sources were stashed to capture this run.
- GREEN: the same command passes 20 of 20.
- `node --import tsx --test tests/anvil/wallet-identity.test.ts`: a real
  `MockErc1271Wallet` proof through `viemSignatureVerifier` and the endpoints
  passes; a stranger's signature is refused.
- `pnpm check` (run once): typecheck and contract checks passed; the unit run had
  452 passing and 7 failing tests, all from one stale fixture (the direct
  `bindWallet` insert in `tests/helpers/database.ts` lacked the new NOT NULL
  `action` column). After the fix the affected suites passed, and a full
  `pnpm test` then passed 459 of 459. Typecheck (root and web) and the boundary
  check were rerun and passed.
- `pnpm build:services` and `pnpm test:service-build`: 4 passed.
- Not run locally: `tests/postgres/*` (no PostgreSQL on this host). Task 6 rewrote
  `tests/postgres/identity.test.ts` (eight concurrent verifications of one
  challenge issue exactly one key; a five-way race for the last key slots; a new
  address racing three keys gets one agent; `blink_api` cannot INSERT into
  `identity.api_keys`) and edited `runtime-roles` and `runtime-functions` for the
  dropped role. CI must run them.
- `pnpm build` cannot run on this host (Turbopack needs a newer glibc).

Fix round 1 (review): verification is now bounded before the signature check, by
60 attempts per hour per client IP and 5 attempts per challenge (`attempts`
column, then `429 RATE_LIMITED`). Both SQL functions read the clock again after
every blocking lock (challenge row, address advisory lock, revoked key row), so a
lock wait cannot extend the 300 s challenge. The generated contract and
`@blink/client` no longer claim an `Idempotency-Key` for the two wallet
endpoints. The lock-wait expiry test is in `tests/postgres/identity.test.ts` and
has not run here (no PostgreSQL).

Fix round 2 (re-review): the address allowance and the pending cap are keyed by
(client IP, address) and charged only after the IP allowance passes (migration
column `client_ip`). A refused issue or revoke now throws inside the transaction,
so nothing it wrote can commit, and the issue function reads the clock before its
first write, so it never returns a refusal after writing. The PostgreSQL lock-wait
tests run with connection and statement limits, observe the blocked backend and
its blocker through `pg_blocking_pids`, and retry a setup that was too slow
instead of counting it.

Known limits: a lost issue response leaves an
unrevocable key that counts toward the five until it expires; the in-process
buckets assume one API instance.

This completes only the Task 6 scope, not the P2 milestone. No push, merge,
deployment or live transaction was performed.

## Task 8 — content store and human suggestions (2026-10-25)

`POST /v1/content` stores raw bytes (at most 1 MiB; `application/json`, `text/plain`,
`text/csv`, `text/html` or `application/pdf`) at their keccak256 through
`fileObjectStore`, and records `content.objects`. It needs the `content:write`
scope and an address that the indexed `ProtocolReader` reports registered; a stale
or failing index answers `503 INDEX_STALE`, as in Task 6 (the check is now shared
as `readFreshIndex` / `requireRegisteredAddress`). Storing the same bytes again
returns the first record. Bytes that parse as `MarketSpecV02` with an existing
`suggestionId` are linked in `suggestions.spec_links`. `GET /v1/content/:hash` is
public: exact bytes, stored media type, immutable cache, `nosniff`,
`Content-Security-Policy: sandbox`, and `Content-Disposition: attachment` for
HTML. Bytes whose hash no longer matches are never served (`503`).

`POST /v1/suggestions` is public (text 20-2000 characters, up to five https
`sourceUrls`, never fetched; 8 KiB body cap). Limits: 5 per hour per client IP and
500 per day overall, in process, charged before the body is read. The list and
detail routes derive the status at read time: `MARKET_CREATED` if a linked spec hash
has a market in the index, else `CLAIMED` if a claim exists, else `OPEN`.
`POST /v1/suggestions/:id/claims` needs `suggestion:claim` and the CREATOR role
(checked in the fresh index); one claim per creator, no exclusivity.

Migration `0030_content_and_suggestions.sql` adds the `content` and `suggestions`
schemas (append-only, `blink_api` SELECT/INSERT), drops `markets.specs` and the
`blink_evidence_admin` role. `evidence.sources` and `evidence.records` stay,
because `forecasts` still validates evidence ids against them until Task 10 moves
forecasts to content hashes. Removed: `spec-archive.ts`, `evidence-admin.ts`,
`scripts/evidence-admin.ts`, the `evidence:admin` script, `getEvidence` in the
client. Market spec reads now use the platform archive at
`local-object:<specHash>`, the bytes `POST /v1/content` stored. `SPEC_PUBLIC_ORIGIN`
is now required in `markets` mode.

Task 5 check: `ws/p2-t5:0029_protocol_index.sql` references none of `evidence.*`,
`markets.specs` or `blink_evidence_admin`. It only references
`markets.protocol_deployments`, which 0030 does not touch.

### Verification

See `.superpowers/sdd/2026-10-24-p2-offchain-protocol/task-8-report.md`. Not run
locally: `tests/postgres/*` (no PostgreSQL here), including the new
`tests/postgres/content-suggestions.test.ts`; `pnpm build` (Turbopack needs a newer
glibc). This covers only the Task 8 scope, not the P2 milestone.

### Task 8 fix round 1

The hourly and daily ceilings (wallet challenges 30/h per IP and 10/h per
(IP, address), verifications 60/h per IP, suggestions 5/h per IP and 500/day
overall) are now a sliding-window log in `apps/api/src/rate-limit.ts`
(`createWindowLimiter`): at most N accepted events in any trailing window, refused
requests are not counted, and `Retry-After` is the time until the oldest counted
event leaves the window. The token bucket remains only for the public read limit,
which is a rate with a burst (60 at 1 per second), not an N-per-window ceiling.
Every `/v1/content/*` response now carries `nosniff` and `Content-Security-Policy:
sandbox`, errors included; errors keep `Cache-Control: no-store`.
