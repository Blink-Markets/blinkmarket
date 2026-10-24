# M2 RFQ, quotes and collateral reservations

This slice turns on `trading` mode: `POST /v1/rfqs` prices a quote deterministically from the platform ensemble, refuses to quote on stale or gated state, reserves the maker's collateral under a row lock, has the restricted signer sign the EIP-712 quote, and answers idempotently. `GET /v1/quotes/:quoteId` reports a quote's state from canonical chain state. A worker reconciles every reservation against the indexer's cursor, including after a reorg. Nothing here sends a transaction: the taker approves and fills with their own wallet, and the maker key never leaves the signer process.

## What was added

| Piece | Where | Behavior |
| --- | --- | --- |
| Schema | `0012_trading.sql` | Schema `trading`: `maker_pools`, `quote_gates`, `quotes`, `collateral_reservations`, append-only `reservation_events`; group role `blink_trading_admin`. |
| Pricing | `packages/domain/src/pricing.ts` | `askPriceBps` (`clamp(snapshotPriceBase + spread, 1, 9999)`), `quoteCosts` (`taker = q*price*100`, `maker = q*1e6 - taker`), `quoteValidity` (`validAfter` is the head block time, 30 seconds or the close, at least 5 seconds). |
| Ports | `packages/ports/src/trading.ts` | `ChainSnapshotReader` (replaces the old draft `ChainReader` in `index.ts`), `TradingStore`/`TradingTransaction`, `ReservationReader`. |
| RFQ service | `packages/application/src/rfq.ts` | `createRfqService` (`POST /v1/rfqs`, `GET /v1/quotes/:quoteId`), `createTradingReadiness` (`config()` for `/v1/config`, `canTrade` for market reads), `indexerStatus` (the lag rule). |
| Reconciliation | `packages/application/src/quote-reconcile.ts` | `createQuoteReconciler(store).reconcileOnce(deploymentId)`, the pure `decideReservation`, and the `quote.reconcile` job handler (payload `{deploymentId}`). |
| Signer check | `packages/application/src/signer.ts` | `createReservationQuoteCheck(reader)` is the signer's `quoteCheck`: a quote is signed only while its row waits for a signature and a `HELD` reservation of exactly its maker cost backs it (`RESERVATION_MISSING` otherwise). `apps/signer` wires it and refuses to start without migration 0012. |
| Adapters | `packages/adapters/src/trading-store.ts`, `chain-snapshot-reader.ts`, `trading-admin.ts` | PostgreSQL store and the signer's read-only reservation reader; EIP-1898 contract reads pinned to the head hash with `requireCanonical`; the `trading:admin` implementation. |
| API wiring | `apps/api/src/trading.ts`, `main.ts` | In `trading` mode the API registers the RFQ service, passes `readiness.canTrade` to the market read service and `readiness.config` to `buildApi`. It refuses an RPC on chain 8453 (`MAINNET_REFUSED`) or any chain but 84532. |
| Worker wiring | `apps/worker/src/handlers.ts`, `main.ts` | `quote.reconcile` is registered; outbox `chain.synced` and `chain.reorged` map to it; a 5 second timer enqueues it for every deployment that still holds reservations or a gated pool. |
| Outbox | `packages/adapters/src/outbox-dispatcher.ts` | A mapped job spec may set `coalesce: true` to keep its own dedupe key instead of `outbox:<id>:<type>`. |
| Tool | `scripts/trading-admin.ts`, `pnpm trading:admin` | `close-gate` and `reopen-gate` with `--deployment --market --reason --note`; also bundled to `dist/tools/trading-admin.mjs`. |

## `POST /v1/rfqs`

1. Authentication (`trade:quote`), the agent's wallet binding (`taker` is the binding; 403 `WALLET_NOT_VERIFIED`), and the per-key limiter (capacity 5, 2 per second, 429 `RATE_LIMITED`) run in a short transaction. The ensemble snapshot is read next, on its own connection.
2. **Transaction A**, in lock order: claim the idempotency key; then deployment (409 `DEPLOYMENT_MISMATCH`, 503 `SERVICE_NOT_READY` with `details.reason = TRADING_DISABLED`, 404 for a missing market); freshness; the chain reads; pricing; then the `maker_pools` row lock (`FOR UPDATE`, created if missing); then the re-checks under the lock; then the intent, sign request, quote (`SIGN_REQUESTED`), `HELD` reservation, a `reservation_events` row and the pool version bump.
3. Freshness uses one rule. The indexer cursor must have no `gate_reason` and `synced_at` within 10 seconds on the database clock (`indexerStaleSql`, the same expression the market read service uses for `INDEXER_LAG`), and may trail the RPC head by at most 3 blocks. An RPC head below the cursor, an unreachable RPC, or a block that left the canonical chain between the head read and a contract read is 503 `CHAIN_UNAVAILABLE`. A gated pool (`OVERCOMMITTED`) is 503 `SERVICE_NOT_READY`.
4. Chain reads are one `eth_call` set pinned to the head hash: `getMarket`, `globalTradingPaused`, `makerFreeBalance`, `currentMakerEpoch`, `takerAllowed(taker)`, `cumulativeTakerShares(market, taker)`. Rejections: 409 `TRADING_PAUSED`; 409 `MARKET_CLOSED` (not `OPEN`, or head time at or past the close); 409 `NO_QUOTE` with `details.reason` `TAKER_NOT_ALLOWED`, `CAP_EXCEEDED`, an open gate reason, `TOO_CLOSE_TO_CLOSE` or `OUTSTANDING_QUOTE_LIMIT` (five outstanding quotes per taker, counted on the cursor's block time); 409 `STALE_FORECAST` (no eligible ensemble); 409 `PRICE_LIMIT_EXCEEDED` (`details: {priceBps, takerCostMicros}` as strings); 409 `INSUFFICIENT_MAKER_BALANCE`.
5. `available = makerFree@head - sum(HELD, RECONCILE_REQUIRED) - sum(ACCOUNTED above the head)`. The last term is an addition to the brief: a fill that the indexer accounted at a block above the head this request read the balance at is not in that balance yet, so reconciliation running between the head read and the lock must not make the maker look richer.
6. **Business rejections are terminal and stored under the key.** Transient 503s (`INDEXER_LAG`, `CHAIN_UNAVAILABLE`, `SERVICE_NOT_READY`) roll back with the claim, so the same key can be retried once the cause is gone.
7. Signing happens after Transaction A has committed, with no connection held. `SIGNED`: Transaction B locks the quote, builds the envelope (`SignedQuoteResponse`: digest as `quoteId`, `message` with decimal strings and side `"0"`/`"1"`, `calldata` from the shared encoder, `chainCursor` of the head the quote was priced at), marks it `SIGNED` and finishes the key with 200. `REJECTED`: the quote is `SIGN_REJECTED`, the reservation `RELEASED`, and the key ends with 409 `NO_QUOTE` (`reason: SIGNER_REJECTED`, `signerCode`). `UNKNOWN` (timeout, lost answer, or a SIGNED answer without a matching signature): the quote becomes `SIGN_UNKNOWN`, the reservation stays `HELD`, the key stays in progress and the response is 503 `SERVICE_NOT_READY` (`Retry-After: 1`).
8. **Resume.** The same key with a quote in `SIGN_UNKNOWN` asks the signer about the same sign request (the signer is idempotent) and continues as above; no quote, nonce or reservation is ever created twice. A `SIGN_REQUESTED` quote whose database `updated_at` is older than the signer call timeout (5 seconds) follows the same resume path, recovering a crash before the signer call or a failed Transaction B. A newer `SIGN_REQUESTED` quote is 409 `REQUEST_IN_PROGRESS`. On BUSY, the committed payload hash is checked before either resuming or finishing the key; a different payload is always 409 `IDEMPOTENCY_CONFLICT`. A quote that expired on block time while its signing was unknown ends the key with 409 `NO_QUOTE` (`QUOTE_EXPIRED`).

**Lock order.** RFQ admission: idempotency claim, then the pool row, then inserts. Reconciliation: pool row, then reservation rows, then the quote row. A signer rejection takes the reservation before the quote, and a successful signing touches only the quote row, so none of them can wait on another in a cycle (`tests/postgres/rfq.test.ts` races them on real connections). Transaction A reads the chain before it takes the pool lock, and the signer is called after Transaction A has committed, so the pool lock is never held across an RPC or signing call.

## `GET /v1/quotes/:quoteId`

Visible to any key of the quote's agent and to admin keys; everything else is 404. The stored envelope is returned with a status computed from canonical state, never extended: `CONSUMED` when `chain.quote_digests` has the digest `FILLED`; `CANCELLED` for a `CANCELLED` digest or a maker epoch above the quote's; `EXPIRED` when the cursor's block time is at or past `expiresAt`; otherwise `SIGNED`. `chainCursor` is the indexer cursor. A quote that never received a signature has no envelope and is 404 (the response contract requires a signature), so `SIGN_UNKNOWN` is never returned by GET. Signing uncertainty is surfaced by POST as 503 `SERVICE_NOT_READY` with `details.reason = SIGN_UNKNOWN`; retry POST with the same Idempotency-Key to resolve it.

## Reconciliation

`quote.reconcile` runs `reconcileOnce(deploymentId)` in one transaction under the pool lock. With the cursor gated (`gate_reason`) it does nothing: a projection under repair is not evidence.

1. **Reopen.** Only `ACCOUNTED`/`RELEASED` reservations above the cursor's finalized height (all heights when finality is unknown) are checked. A reservation whose recorded block hash is no longer a canonical `chain.blocks` row goes back to `RECONCILE_REQUIRED` (its quote to `SIGNED`, or `SIGN_UNKNOWN` if it never got a signature).
2. **Conclude** each `HELD`/`RECONCILE_REQUIRED` reservation against the cursor C: digest `FILLED` at or below C is `ACCOUNTED` at the fill's block and the quote `CONSUMED`; a `CANCELLED` digest or a maker epoch above the quote's is `RELEASED` and the quote `CANCELLED`; C's block time at or past `expiresAt` is `RELEASED` and the quote `EXPIRED`. A local clock past the expiry changes nothing. Every change appends a `reservation_events` row.
3. **Gate.** If the held and reopened amounts exceed the maker's free balance at C the pool is gated `OVERCOMMITTED` (no new quotes); a later pass clears it.

Until a reorg has been reconciled, new RFQs are refused (503 `SERVICE_NOT_READY`, `details.reason = RECONCILE_REQUIRED`) as soon as the first settled reservation with an orphaned block is seen under the pool lock, so the quote gate does not depend on the worker being fast.

Triggers: outbox `chain.synced` and `chain.reorged`, coalesced to one job per deployment and 2 second bucket that starts when the bucket ends (so it sees every block of that bucket), plus the 5 second backstop timer.

## Readiness

`/v1/config` in `trading` mode reports stage `m2-trading`, the `PublicDeployment` allow-list of the manifest, and `tradingEnabled = manifest.tradingEnabled && deployment enabled && indexer fresh && pool not gated`. Market reads use the same gates plus the market's own: `canTrade` reasons are `TRADING_DISABLED`, `INDEXER_LAG`, `SERVICE_NOT_READY`, `MARKET_CLOSED`, `TRADING_PAUSED`, an open quote gate reason, and `NO_FORECAST`. These read the indexer's last observed head from `chain.cursors` instead of calling the RPC.

## Runtime

`BLINK_API_MODE=trading` needs `BLINK_DEPLOYMENT_ID`, `SIGNER_URL`, `SIGNER_CALLER_TOKEN` (its SHA-256 listed in the signer's `SIGNER_CALLERS` with role `maker`) and `BASE_SEPOLIA_RPC_URL` (each RPC call is bounded to 3 seconds, below the database's idle-in-transaction timeout, because Transaction A reads the chain while it is open). The signer process refuses to start without the `trading` schema. `pnpm trading:admin close-gate|reopen-gate --deployment <id> --market <id> --reason OUTCOME_KNOWN|ANNOUNCEMENT_EARLY|OPERATOR_PAUSE|SPEC_INTEGRITY --note <text>` needs `TRADING_ADMIN_DATABASE_URL` with a non-privileged login in `blink_trading_admin`.

## Differences from the brief

- `trading.quotes` has two extra columns, `operator_id` and `idempotency_key` (unique together), so a retry finds its own quote; the three tables that reference deployments carry a foreign key to `markets.deployments`; `quote_gates.note` must be non-empty.
- Column-level `UPDATE` grants instead of whole-table `UPDATE` for the API and worker (progress columns only; `UPDATE` on some column is still what lets `FOR UPDATE` lock the pool row).
- `available` also subtracts `ACCOUNTED` reservations above the head the balance was read at (see above).
- Only 409/404 rejections are stored as terminal answers; 503s are retryable and not stored.
- Reorg detection is by the canonical flag of the block hash each settled reservation recorded, not by an `ancestorNumber` carried in the job: `reconcileOnce(deploymentId)` has only the deployment, and the check also repairs a lost `chain.reorged` event.
- The reservation check sits in `signer.ts` as `createReservationQuoteCheck`; `createRfqService` takes one extra dependency, `encodeCall` (application code cannot import the adapter ABI), the same way `createSignerService` does.
- The 5 second backstop is a dedicated timer in `apps/worker/src/main.ts`, because the worker's existing schedule tick is 30 seconds. Event coalescing needed `OutboxJobSpec.coalesce` because `dispatchOutbox` always replaced a mapped job's dedupe key.
- `trading-admin.ts` is an adapter file like `forecast-admin.ts`; `market-read-store.ts` now exports `indexerStaleSql`, the one definition of the 10 second age rule, and `apps/web/content/docs/architecture.md` names `ChainSnapshotReader` where the public ports table listed the removed draft `ChainReader`.

## Follow-up fix round 1

M1–M5 are addressed: signed-only GET documentation, payload conflicts under advisory-lock contention, recovery of stale SIGN_REQUESTED quotes, finality-bounded reorg scans, and a dedicated two-connection RFQ pool. M6–M12 remain parked. Migration 0012 is unchanged and no migration was added.

The dedicated pool is the smaller safe change: it preserves the admission transaction and collateral lock ordering while preventing slow chain RPC from exhausting the pool used by other API routes. RFQ authentication and snapshot reads use that pool too; readiness stays on the general pool.

Follow-up verification (2026-10-15): `pnpm check` passes all 498 tests plus contracts, types and package boundaries; `pnpm build:services && pnpm test:service-build` passes all 5 bundle tests; `pnpm test:anvil` passes 44 tests; the PostgreSQL suite on the dedicated local server passes all 33 tests with none skipped. The ordinary `pnpm build` is blocked by existing Google Fonts downloads under the restricted-network constraint; the full build passes with temporary `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` and installed font bytes served over loopback (all 36 static pages). This validates compilation and source exports, not production font downloads or appearance. No tracked font configuration or generated artifacts changed.

## Verification (original Task 9)

Run on 2026-10-15 in the task worktree against local PostgreSQL 17 and a local Anvil with chain ID 84532.

- `pnpm check`: exit 0, 484 Node tests, package boundaries pass.
- `pnpm build`: exit 0.
- `pnpm build:services && pnpm test:service-build`: exit 0, 5 bundle tests; `dist/tools/trading-admin.mjs` is built.
- `pnpm test:anvil`: exit 0, 40 tests (3 new in `tests/anvil/rfq.test.ts`): a funded maker, an ensemble from two platform forecasters in a closed window, the RFQ over the real API (composed by `tradingServices`) and signer (key from a mode 0600 file, over HTTP), the taker verifies the signature and the contract's own `hashQuote`, approves exactly the cost and fills with the returned calldata, the indexer syncs, reconciliation accounts the fill and `GET /v1/quotes/:id` says `CONSUMED` with matching positions; block-time expiry and an epoch bump release; an `evm_snapshot`/`evm_revert` reorg reopens the accounted reservation, closes the quote gate until reconciled, and the same fill later counts once.
- `TEST_POSTGRES_ADMIN_URL=... pnpm test:postgres`: exit 0, 28 tests (3 new in `tests/postgres/rfq.test.ts`, run four more times with the same result): six concurrent RFQs from two API instances for collateral that fits three admit exactly three (three rounds) and two takers racing for the last slot get one 200 and one `INSUFFICIENT_MAKER_BALANCE`; four concurrent retries of one key leave one quote, reservation and artifact; reconciliation, quoting and signer rejections release the same reservations concurrently without deadlock (real `blink_api`, `blink_signer` and `blink_worker` logins).
- New unit tests: `tests/pricing.test.ts` (6), `tests/rfq.test.ts` (24), `tests/quote-reconcile.test.ts` (12, including a real indexer on a scripted fork), `tests/trading-ops.test.ts` (6: admin tool, least privilege, event coalescing, backstop, handler).
- Mutation checks (temporary, reverted), each makes at least one test fail: removing the pool `FOR UPDATE`, the ACCOUNTED-above-head term, the reconcile-required gate, the reorg reopen step, the resume path, the storing of terminal rejections, the signer's amount comparison; an off-by-one at the expiry and a local clock deciding expiry.

## Remaining limits and open items

- **RFQ admission still holds its own connection and idempotency advisory lock across bounded RPC reads.** A separate pool capped at 2 connections isolates this wait from the general API pool (10 connections); readiness and market reads use the general pool. The signer call holds no database connection. Both pools close on normal shutdown or startup failure. This adds at most two database connections per trading API instance.
- **Single-instance limiter** (ruling 6): the per-key limiter is in process; a shared limiter is needed before a second API instance.
- **`GET /v1/quotes/:id` for unsigned quotes** is 404; `SIGN_UNKNOWN` is never returned because the response contract needs a signature.
- **Historical health checkpoint:** at this RFQ slice, `/v1/health` still reported not ready; `/v1/config` and market `canTrade` carried the trading decision. Task 16a subsequently added real trading-mode health/readiness and admin execution metrics; see [M5_HEALTH_METRICS.md](M5_HEALTH_METRICS.md). Earlier API modes still report not-ready.
- **Market read `forecastSnapshotId`/`costMicros` hooks** are not wired (not requested).
- **Provider support** (from Task 5): EIP-1898 `eth_call` with `requireCanonical` is assumed for the RFQ's chain reads too; no real Base Sepolia endpoint was contacted.
- **Snapshot read per request**: the ensemble is read before admission, also for replays, because it needs its own connection.
- **Worker mapping merge**: `chain.synced`/`chain.reorged` mappings are added next to any existing ones; another task assigning those keys after this block would replace them.
- **Outside this slice**: maker withdrawal handling (stop quoting, drain outstanding quotes) beyond the `OVERCOMMITTED` gate. The internal trader is now delivered separately in [M3_INTERNAL_TRADER.md](M3_INTERNAL_TRADER.md), including public RFQ integration and its remaining mandate/runtime limits.
