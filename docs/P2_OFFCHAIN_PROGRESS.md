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

### Credit-clock ruling (resolved in Task 5 fix round 1)

`BlinkRegistry.reportLoss` now returns before materialising credit when the
current decayed credit is zero. Foundry verifies that this path writes no storage
and emits nothing, and that both actors in the former ambiguous-clock regression
have equal future credit. The reducer keeps the same partial-period and 32-shift
clock arithmetic as `_materialise`, without refusing valid zero-decayed gains.
The P1 implementation ruling records this contract behavior change.

### Task 5 fix round 1

Pending governor adoptions are checked against `pendingSuccessor` and its effective
time, including first and replacement adoptions in one-block ranges before and
after effectiveness. Timestamp lag over 30 seconds and observation age over
30 seconds close indexer, protocol-reader, public-read and API-health freshness;
existing gates remain in force. `synced_at` records when the head was sampled,
rather than when a slow verification commits.

Each advancing batch checks projection membership against the canonical journal
without RPC and repairs missing rows from that journal. RPC checks cover only the
entities touched by the batch, using at most eight concurrent calls. The rebuild
path audits the full projection by RPC; `pnpm chain:rebuild <deploymentId> [--verify]`
now requires both `INDEXER_DATABASE_URL` and `BASE_SEPOLIA_RPC_URL`. Rebuild reads
remain pinned to the cursor block hash.

API health, monitoring deployment discovery/readability and operator status now
use `markets.protocol_deployments`. Their unit and PostgreSQL fixtures no longer
need a legacy deployment row. No fabricated legacy row was added to image smoke.
The legacy transaction-hint/tracking and historical v0.1 registration readers
remain; the smoke driver does not submit hints and its pending-transaction queue
is empty. The legacy table is retained for a later task.

Verification for fix round 1:

- Test-first RED reproduced the credit storage/clock bug and all five review findings.
  Credit GREEN: 10 reducer tests and both Foundry regressions passed.
- Focused suite: 75 passed initially; the remaining fixture still used the old
  11-second rule. After updating it to 31 seconds, its complete file passed all
  8 tests. The 9 new indexing/freshness regressions passed.
- Required reducer/indexer/Anvil command: 18 passed, 0 failed.
- Foundry: 238 passed; invariant seeds 0x01 and 0x02 each passed all 4 tests.
- The single literal `pnpm check` stopped at private-field access in the new test
  helper. After switching to existing public fake-chain accessors, every check
  constituent passed. The complete constituent pipeline was rerun after a host
  reboot: root/web TypeScript, contract artifacts/EIP-170, 428 unit tests and
  dependency boundaries all passed, with no skipped tests.
- `pnpm build:services && pnpm test:service-build`: passed; all 4 bundle checks passed.
- `git diff --check`: passed. PostgreSQL fixture INSERTs/counts were checked
  statically against migrations 0001–0029; real PostgreSQL and Docker smoke/restore
  were not run. `pnpm build` cannot run on this host's older glibc; web TypeScript passed.
- The journal membership audit still scans/refolds history locally each batch.
  A `shortcut:` comment records when to replace it with an independent inventory.
This is the Task 5 slice only; P2 is not marked complete. No push, merge, rebase,
deployment or live transaction was made.

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

## Task 7 — resolution, juror, credit and fee read models; public read API (2026-10-25)

The indexer now folds `BlinkResolution` and `BlinkJurors` events into seven new
projections, and the API serves them (with markets, accounts, positions and
templates) as public, key-less, paged reads.

- Projections (migration `0031_protocol_resolution.sql`, same key/data shape and
  grants as 0029): `proposals` (by market), `disputes`, `rounds` (`disputeId:round`,
  restarts included), `votes` (`disputeId:round:juror`), `jurors`, `reward_pool`
  and `fees`. Reorgs restore them together with the older projections because they
  are part of `ProtocolProjection`. Folded events: every `BlinkResolution` event
  except `UnchallengedFinalized`, and `Staked`, `UnstakeRequested`,
  `UnstakeWithdrawn`, `Slashed`, `RewardNotified`, `RewardsClaimed`, `VoteLocked`
  and `VoteUnlocked`. `JurorRewarded` and `RewardsForfeited` stay journal-only.
- The fold takes the deployment `Params` (not just the credit half-life):
  round clocks, the finalized-market phase-in of the round credit threshold and
  the fee shares all come from them. `ChainIndexStore.protocolParams` replaces
  `creditHalfLife`. The reducer is split into `protocol-event-args.ts`,
  `protocol-resolution.ts` and `protocol-jurors.ts`.
- A vote's `choice` is `null` until its `VoteRevealed` event, in the projection,
  the reader and the service (defence in depth), on every route and page.
- `FeeBreakdown` is recomputed at `FeesDistributed` with the contract's own
  arithmetic (R32: the treasury takes all rounding dust; the proposer's share is
  paid only if the proposal won; the creator share goes to jurors on `INVALID`; the
  bounty is paid only for an overturned, finalized result dispute, else it goes to
  jurors). When no juror stake exists at the distribution, `BlinkJurors.notifyReward`
  forwards the whole juror allocation to the treasury: `jurors` is then 0 and the
  amount is added to `treasury`, so every figure equals its recipient's balance
  delta. The keeper tip must equal the event's tip, or the fold fails closed. The
  contract and the brief agree on the dust rule: no deviation.
- `JurorState.rewardsOwed` simulates the seven-day reward stream from events alone
  and is resynced at every `RewardNotified`. A `RewardsClaimed` event resets the
  juror to 0 and its checkpoint to the current accumulator (never a subtraction),
  exactly what the contract holds after a claim. Known gap: a juror's own
  zero-value `claimRewards` (and a zero slash) settle the contract's checkpoint
  but emit no event, so `rewardsOwed` can exceed the contract by under 1 micro per
  such silent call until the juror's next claim; the claim always pays the contract
  value. This is the one place where a read model is not exactly the contract.
  Everything else about a juror is checked against the chain.
- Verification against the chain: each batch also `eth_call`s only the touched
  proposals (`proposerOf`, `proposedOutcome`), disputes (`getDispute`, including the
  current round, and `bountyWinner`) and jurors (`slashableStake`, `pendingUnstake`,
  `openVotes`), plus `totalStaked` when juror events occurred. Votes have no getter,
  so they are checked through the round's committed and revealed weights. A
  populated projection with the contract undeployed fails. The full cross-check
  runs only in rebuild.
- Routes, all public GET, paged by `after`/`limit` (at most 100). JSON bodies carry
  `index` (`IndexHealth`), except error bodies. `/v1/markets/:id/spec` returns the
  exact stored bytes, so it carries the health in the headers `Blink-Index-Stale`,
  `Blink-Index-Indexed-Block`, `Blink-Index-Head-Block` and
  `Blink-Index-Lag-Seconds` on 200, 404 and 503 (declared in OpenAPI for all three).
  Success is `Cache-Control: no-cache` (immutable bytes, mutable health); errors are
  `no-store`. Early 400 and 429 refusals carry no health on any route. Routes:
  `/v1/deployment`, `/v1/markets?state=`,
  `/v1/markets/:id` (market, spec parse result, proposal), `/v1/markets/:id/spec`
  (exact bytes, `nosniff`, `Content-Security-Policy: sandbox`, `503
  SPEC_UNAVAILABLE` when the platform holds no intact bytes), `/v1/markets/:id/disputes`,
  `/v1/disputes/:id` (all rounds, a page of votes), `/v1/markets/:id/fees`,
  `/v1/accounts/:address` (roles, credit per role decayed to the request time,
  juror state), `/v1/accounts/:address/positions` (with the redeem payout once the
  market is final) and `/v1/templates`. A market whose spec bytes are invalid or
  missing is still listed, with the parse error or `SPEC_UNAVAILABLE`. A malformed
  cursor answers `400 INVALID_CURSOR`.
- Removed: `GET /v1/markets/:id/resolution` and the v0.1 market, position and
  `deploymentId`/`mode` query shapes (client methods `getResolution` dropped;
  `listMarkets`, `getMarket`, `getMarketSpec` and `getPositions` follow the new
  shapes). `pendingIntentIds` is no longer part of positions. The transaction-hint
  handlers (`POST /v1/transactions`, `GET /v1/transactions/:txHash`) stay in
  `market-read.ts` and `market-read-store.ts`, grouped so Task 9 can cut them out.

### Verification

See `.superpowers/sdd/2026-10-24-p2-offchain-protocol/task-7-report.md`. Not run
locally: `tests/postgres/*` (no PostgreSQL here) and `pnpm build` (Turbopack needs a
newer glibc). This covers only the Task 7 scope, not the P2 milestone.

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

## Task 9 — multi-maker RFQ relay, protocol transaction tracking and the taker example (2026-10-25)

Scope: the RFQ relay, transaction tracking for the protocol generation, the
`@blink/client` surface for the P2 API and the external taker example. Not in scope:
P3 reference agents, deployment.

### What changed

- **RFQ relay** (`packages/application/src/rfq-relay.ts`, `packages/adapters/src/rfq-store.ts`,
  migration `0032_rfq_relay.sql`). `POST /v1/rfqs`, `GET /v1/rfqs`,
  `POST|GET /v1/rfqs/:id/quotes` and the public `GET /v1/makers/:address/stats`. RFQs and
  quotes live in PostgreSQL (`rfq.requests`, `rfq.quotes`, immutable; the API role may only
  SELECT and INSERT), so every API instance sees the same state. An RFQ stays open 30
  seconds (relay clock, unix seconds), a taker holds at most 5 open RFQs and an RFQ holds at
  most 20 quotes, one per maker; both caps are enforced under advisory locks.
- **Quote checks, in the order the relay applies them.** The caller needs `rfq:write` and the
  MAKER role; the RFQ must be open; taker, market, side and quantity equal the RFQ's; the
  spec hash equals the indexed market's; the quote names the caller as maker and is signed
  (ECDSA for a maker without code, ERC-1271 for a contract wallet, the same rule as
  `BlinkMarkets.fillQuote`; ERC-6492 wrappers and high-s signatures are refused);
  `0 < priceBps < 10000`; lifetime at most 60 seconds; expiry after now and not after the
  market closes; the maker's current epoch; the digest is UNUSED; the maker's free balance
  covers `quantity x 1_000_000 - takerCost`. Every refusal happens before anything is
  stored, and a signature check that cannot run answers 503 `SIGNATURE_CHECK_UNAVAILABLE`.
  Writes answer 503 `INDEX_STALE` while the index lags. The quote JSON and signature are
  returned byte for byte, only to the RFQ's taker, cheapest first. Maker stats are
  informational and gate nothing.
- **Transaction tracking.** `POST /v1/transactions {txHash}` (any key) and
  `GET /v1/transactions/:txHash` now track the protocol generation: the tracker checks that
  the sender is the key's wallet and the target is a contract of the current generation, the
  faucet or the anchor, and records the function name decoded from the protocol ABI. A hint
  is idempotent per hash for the same key (same `trackingId`) and 409 `TX_ALREADY_TRACKED`
  for another key. Statuses are unchanged (UNKNOWN, INCLUDED, FINALIZED, REVERTED,
  REORGED). Existing v0.1 hint rows are deleted by the migration (the old quote and action
  columns are gone); the hint path in `market-read` was removed.
- **`@blink/client`.** `verifySignedQuote(quote, signature, ctx)` is async and returns
  `{digest, takerCost, fee, maxCost}`; it builds the "Blink RFQ" 0.2 domain from the trusted
  deployment, checks the quote against the RFQ and the market, refuses non-canonical
  signatures and verifies through the node (`verifyTypedData`), so contract wallets work.
  `approvalFor(quote, feeBps)` is the fee-inclusive allowance. New methods: RFQ relay,
  maker stats, `trackTransaction`, auth, deployment/markets/spec/disputes/fees/accounts/
  positions/templates reads, content upload and suggestions. The retired v0.1 methods
  (`requestQuote`, `getQuote`, `claimFaucet`, `getResolution`) are gone.
- **`examples/agent/run.ts`.** The taker-only flow described in `examples/agent/README.md`.

### ERC-6492

Quotes keep strict parity with `BlinkMarkets.fillQuote`, which rejects ERC-6492 wrappers: a
wrapped quote cannot fill on chain, so the relay and `verifySignedQuote` refuse it. The
global "off-chain checks accept ERC-6492" rule applies to signatures that are only ever
checked off chain (wallet proofs, forecasts), not to quotes.

### Fix round 1

- The example agent no longer treats an uncertain fill as a failed one. After a lost answer
  or a receipt timeout it keeps the hash (if any) and requests no replacement RFQ until a
  receipt arrives, `consumed(digest)` shows the fill, or chain time has passed the quote's
  expiry and the digest is then still unused. Covered by
  `tests/anvil/client-agent-uncertain-fill.test.ts` (a fill reported lost that lands just
  before expiry; a send that never reaches the node).
- `POST /v1/transactions` is refused with 503 `INDEX_STALE` while the index lags, before
  anything is stored.
- A quote is checked a second time after the signature check (clock, RFQ openness, quote
  expiry, market tradability, index health, epoch, digest, balance), and the store
  re-checks that the RFQ is still open under the per-RFQ quote lock.
- `examples/agent/run.ts` imports `@blink/client`; the repository root `tsconfig.json`
  maps that name to `packages/client/src/index.ts` for `tsc` and `tsx`.

### Fix round 2

- Task 7 merged. `postgresRfqStore` takes the relay's clock and reads it after the per-RFQ
  lock is held; `addQuote` returns CLOSED (409 `RFQ_CLOSED`) when the RFQ expired by then,
  so a close that races the insert cannot store a quote. The insert no longer takes a
  pre-sampled `receivedAt`.
- The test-local read shim is gone. `tests/helpers/rfq-stack.ts` wires the real
  `createMarketReadService` (with a content store and the registered manifest) and both
  client-agent Anvil suites talk to `stack.apiUrl`: the unchanged example reaches FINAL and
  redeems through the real `/v1/deployment`, `/v1/markets` and `/v1/markets/:id`.

### Task 7 integration

Task 7 is merged into this branch. The client reads the real shapes of `read-api.ts`:
`getDeployment()` returns `{deployment, index}`, `listMarkets()` pages of `{market, spec}`,
`getMarket({marketId})` `{market, spec, proposal, index}`; `getMarketSpec`, disputes, fees,
accounts, positions and templates use the same contracts. The `market-read` service keeps only
`GET /v1/transactions/:txHash` besides the read routes; its hint path and unused identity
dependency are gone, and `POST /v1/transactions` belongs to the tx-tracking service.

### Verification

See `.superpowers/sdd/2026-10-24-p2-offchain-protocol/task-9-report.md`. Not run locally:
`tests/postgres/*` (no PostgreSQL here), including the new
`tests/postgres/rfq-relay.test.ts`; `pnpm build` (Turbopack needs a newer glibc). This
covers only the Task 9 scope, not the P2 milestone.

## Task 10: signed forecasts, window roots, automatic contamination and consensus

Scope: slice of P2, not the milestone.

- **Signed forecasts.** `POST /v1/markets/:id/forecasts` takes `{horizon, scheduledAt,
  probabilityBps, contentHash, signature}` (`forecast:write` and the FORECASTER role). The service
  builds the EIP-712 `Forecast` struct itself (domain `Blink Forecast` v1, chain 84532,
  `verifyingContract` = the manifest's `shared.anchor`; forecaster = the key's wallet, `markets` =
  the generation's BlinkMarkets, market = the route, window = horizon + scheduledAt), so a signature
  for another window, market, forecaster or deployment fails with 400 `INVALID_FORECAST_SIGNATURE`.
  `SignatureVerifier.verifyTypedData` checks it (EOA, ERC-1271, ERC-6492); the checked block is
  stored as `verified_block`. Admission is by the database clock under the window row lock, one per
  forecaster per window; role, market, window and index health are looked at again after the
  (unbounded) signature check, and nothing is stored on any refusal. An identical retry returns the
  stored `{digest, leaf}`. Submission requires an `Idempotency-Key` header (the service itself keys on the
  digest); withdrawal defines none.
- **Windows and roots.** The `forecast.schedule` job (every 30 s) opens windows only for OPEN markets
  that are `tradable(market, deadline)` and then closes windows past their deadline: the worker
  stores `merkle_root` / `root_at` (set once; a window with no standing answer gets `root_at` and a
  null root). The platform never anchors and never signs; `GET /v1/forecast-windows/:id` returns
  `{root, leaves, anchor}` with `anchor` from `ProtocolReader.anchor(root)`, and `/proof?leaf=`
  returns the sibling path. `forecastLeaf`, `merkleRoot`, `merkleProof` live in
  `packages/domain/src/forecast-merkle.ts` (own Keccak-256 in `keccak.ts`: the domain package may
  not import viem). `contracts/test/protocol/ForecastMerkle.t.sol` verifies every proof with
  OpenZeppelin `MerkleProof.verify` and pins the root `0x7afdf524...bdab40`, which
  `tests/forecast-merkle.test.ts` reproduces in TypeScript.
- **Schedule.** Worker env `FORECAST_PRE_CLOSE_LEAD_SECONDS` (3600) and `FORECAST_WINDOW_OPEN_SECONDS`
  (1800), validated at startup (positive integers, open <= lead). DAILY windows are unchanged.
  `snapshotPriceBase` is gone. The worker uses the same `ProtocolReader` as the API
  (`staleProtocolReader` now lives in adapters and is shared; without `BLINK_DEPLOYMENT_ID` the
  forecast jobs find no market).
- **Sealing.** Before a window's deadline the answers route returns only the caller's own answer
  (anonymous: none), the window route shows no root or leaves, the proof route answers 409
  `WINDOW_SEALED`, and the consensus route lists closed windows only.
- **Withdrawal.** Annotation, not deletion. It needs `forecast:write`, a fresh index, the wallet's
  current FORECASTER role, and the same API key that submitted the answer (a second key of the same
  wallet finds nothing). By controller ruling it is allowed only before the window deadline: a
  withdrawal after the deadline would let a forecaster drop answers after seeing later information
  or the outcome, which would game Brier scoring and Forecaster credit, and the window root commits
  to the deadline snapshot. The removed admin path was a platform action and no longer exists. A
  withdrawn answer stays listed but leaves the root, the consensus and the scores (scored as missing).
- **Contamination** is computed from `ProtocolReader.proposal(marketId).proposedAt <= deadline`;
  there is no annotation path left. `blink_forecast_admin`, `forecast-admin` (adapter, CLI, build
  entry, `forecast:admin` script) are deleted.
- **Scoring and consensus.** At FINAL with a YES/NO outcome (market state, replay flag and outcome
  from the reader) `evaluation.score` writes `v2` entries: AGENT per eligible answer (per wallet)
  and one CONSENSUS per window; INVALID has no Brier. `weight = n < 5 ? 0 : max(0, 0.25 - meanBrier)`
  (kept as an exact fraction from the exact Brier sum, never a rounded decimal; only the final probability
  is rounded, half up) from the latest 50 scored LIVE, uncontaminated, non-missing AGENT entries; consensus weights only
  count scores recorded by the window's deadline. New routes: `/v1/markets/:id/consensus`,
  `/v1/forecasters`, `/v1/forecasters/:address`; `/v1/metrics` adds `consensusBrier` and still
  separates LIVE and REPLAY.
- **Migration 0033** (only): new submission and window columns, v1 rows untouched (v2 scorer rule and
  unique indexes beside them), `analytics.closed_forecasts` replaces `final_forecasts`, grants for the
  API (annotations INSERT, withdrawals only) and worker (root UPDATE, address-only SELECT on submissions,
  digests only through `forecasts.closed_digests`, which lists a window's answers after its deadline: with the
  zero content hash a digest reveals the probability, so the worker never reads one of an open window),
  drops `blink_forecast_admin`, `evidence.records`, `evidence.sources` and the `evidence` schema (no
  CASCADE). A row-level trigger on `forecasts.windows` allows only the one-time root set.
- **Client.** `@blink/client` gains submit, withdraw, window, proof, consensus, forecasters and
  metrics methods plus `forecastTypedData`, `forecastDigest` and `forecastLeaf`.

### Verification

See `.superpowers/sdd/2026-10-24-p2-offchain-protocol/task-10-report.md`. Not run locally:
`tests/postgres/*` (no PostgreSQL here), including the rewritten `tests/postgres/forecasts.test.ts`;
`pnpm build` (Turbopack needs a newer glibc).
