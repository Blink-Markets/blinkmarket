# M3 internal trader under a mandate

中文摘要：內部 trader 使用自己的小額 EOA，只在自己 forecaster 的機率高於 ask 超過 500 bps 且通過 mandate 限額時，經公開 RFQ 與受限 signer 買入（精確 approve、fillQuote），市場 FINAL 後 redeem；worker 不持有私鑰，風險在 DB 鎖下預留並以 canonical chain 結算。

Task 14 delivers the internal trader slice of M3 (spec 9.3, 12.3). It does not mark the full milestone complete.

The trader is deterministic: no model output reaches it. It reads the platform forecasters' answers of a closed window, prices both sides with the same `askPriceBps` the RFQ uses, and buys only when its own forecaster's probability beats the ask by more than the mandate's threshold. It asks for the quote through `POST /v1/rfqs` with its own API key, verifies the signed envelope itself, and has the restricted signer sign an exact-amount approve and the fill. The worker holds no key; every transaction is an intent the signer checks and signs.

## What was added

| Piece | Where | Behavior |
| --- | --- | --- |
| Schema | `0018_trader.sql` | `trading.mandates`, `trading.risk_reservations` (guarded transitions), the views `trading.trader_snapshots` and `trading.trader_snapshot_windows`, and the worker's grants. |
| Rule | `packages/domain/src/trader-rule.ts` | `traderDecision`, `tradeNotionalMicros`, `mandateAdmission`: integer arithmetic only. |
| Ports | `packages/ports/src/trader.ts` | `TraderStore`, `TraderQuoteApi`, the context and trade records. It re-exports `mandateAdmission` so the adapter applies the one rule under the lock. |
| Store | `packages/adapters/src/trader-store.ts` | PostgreSQL `TraderStore`: context reads, the locked `reserve`, the consistent per-trade facts, intent preparation, redeemable positions, deduplicated audit rows. |
| Application | `packages/application/src/trader.ts` | `createTrader` (`evaluate`), `createTraderHandler` (`trader.evaluate`), `traderStopReason`, `verifyTraderQuote`, `traderIntentId`. |
| Worker | `apps/worker/src/trader.ts`, `config.ts`, `handlers.ts`, `main.ts` | `buildTrader` composes the store, the public API client, the restricted-signer client, the dispatcher and the schedule; `traderConfig`; short registration lines. |

## The rule

`traderDecision({ownProbabilityMillionths, askYesBps, askNoBps, thresholdBps})` compares in millionths, so the threshold is never rounded:

- YES qualifies when `ownP - askYes*100 > threshold*100`; NO when `(1e6 - ownP) - askNo*100 > threshold*100`.
- Both qualify: the larger edge wins, YES on a tie. Neither: no trade.
- **Strictly greater.** Spec 12.3 says the gap must *exceed* the threshold (「超過」), so an edge of exactly 500 bps is no trade; the smallest probability step above it (one millionth, `0.000001`) is a trade, and so is 1 bps above. The task brief's goal line says "≥ 500 bps", but its Rule 1 and its test vector ("edge exactly at the threshold → null") say strict, and the spec is the authority: strict is implemented and tested. Inputs that are not integers in range throw `INVALID_TRADER_INPUT`.

`ownP` is the mandate's linked platform forecaster (`forecaster_role`) in the market's latest closed window, as `probability * 1e6`. The asks are `askPriceBps` of the ensemble sum (`FORECASTER_A + FORECASTER_B`) plus the manifest's `makerSpreadBps`, exactly the RFQ's price. Example: A 0.80, B 0.50 gives sum 1.30, YES ask 0.67 (6700 bps), edge 0.13 above the 0.05 threshold: buy YES.

## Mandate and risk reservations

`trading.mandates` is one row per trading agent (wallet, `forecaster_role`, daily cap 100 bUSD, open cap 500 bUSD, `max_fill_shares` 20, `shares_per_trade` 10, `edge_threshold_bps` 500, `enabled`, `policy_version`). The worker can read it and nothing else: only the database owner sets limits.

`trading.risk_reservations` is the conservative risk one buy occupies. `notional_micros` is the maximum payout, `shares * 1e6`, whatever the price. `intent_id` names the buy (a UUIDv5-shaped hash of mandate, deployment, market and forecast window), so a window is bought at most once.

| State | Meaning |
| --- | --- |
| `HELD` | Reserved, quoting, pending, or INCLUDED but not yet seen by the indexer. |
| `ACCOUNTED` | The indexer's canonical projection shows the quote digest FILLED. |
| `RELEASED` | Definitive failure; final. |

Admission runs in one transaction under a per-mandate lock (a transaction advisory lock keyed by the agent id; the worker holds no `UPDATE` on `mandates`, so the row cannot be the lock). It re-reads the mandate as stored, then admits only when `daily(HELD + ACCOUNTED, today UTC) + notional <= daily cap`, `open(HELD) + notional <= open cap` and `shares <= max_fill_shares`. Otherwise nothing is reserved and one `trader.skipped` audit row (action, buy id, reason) records why; repeating the same skip adds no row. A trigger allows only `HELD -> ACCOUNTED`, `HELD -> RELEASED` and `ACCOUNTED -> HELD`.

## One evaluation (`trader.evaluate`)

Scheduled after each forecast window closes (one job per window, from the 15 second tick), every five minutes, every 15 seconds while a buy is in flight, and at most every 2 seconds after a run that ran out of time. The payload is ignored. **A run is short.** The worker runs one job at a time, so a run has a 5 second budget on the wall clock, counted from its start: it sleeps only while budget remains and starts no new step (RFQ, prepare, dispatch, new buy) after it. A step already begun finishes (the RFQ client gives up after 4 seconds, a dispatch pass is a few RPC calls), so a run can overshoot by one step; the tests drive an injected clock that moves only when the trader sleeps, so they prove the sleep bound, not wall time. Whatever is still pending (an approve or fill not yet in a block, an RFQ whose answer may clear soon (a retryable answer, or none), a market deferred as `DEFERRED`) is carried on by the next run from the database, which can never repeat a step because every intent has one dedupe key. A run does three things in order.

1. **Carry on buys already in flight** (also when the mandate is off), see below.
2. **Redeem** FINAL markets where the wallet still holds shares: one `REDEEM` intent per market and wallet, only on a fresh indexer. A failed redeem is audited once and never repeated.
3. **Decide** for each market, unless the mandate is disabled. Per market it stops, with the reason in the run summary, when: the deployment or manifest has trading off; the indexer is not fresh (no cursor, a gate reason, silent for more than 10 seconds on the database clock, or more than 3 blocks behind its observed head: the RFQ's own rule); trading or the market is paused; the maker pool is gated; the market is not OPEN; close is reached on block time or on the business clock; a quote gate is open; the wallet is not allowed to take; or there is no forecast (none, older than 24 hours, or annotated). Otherwise it applies the rule, reserves, and carries the new buy on.

Carrying a buy on is idempotent and resumable from any point, because every step is read back from the database:

1. Settle against the canonical chain first: the digest FILLED means `ACCOUNTED` (and the fill is tracked to finality); an `ACCOUNTED` buy whose digest is gone (reorg) is `HELD` again. A cursor with a gate reason settles nothing.
2. Release only on a definitive end (spec 12.3 「確定失敗才釋放」). Two kinds.
   - Ends the chain or the signer decided: an approve or fill intent FAILED (a finalized revert, or a refused first signature); the quote's digest cancelled or the maker epoch above the quote's; the cursor's block time at or past `expiresAt` (never the host or database clock).
   - Ends that rest on a buy having spent nothing: an RFQ refusal that the API stored, meaning a 404, or a 409 whose code is not `IDEMPOTENCY_CONFLICT` or `REQUEST_IN_PROGRESS` (`NO_QUOTE`, `PRICE_LIMIT_EXCEEDED`, `STALE_FORECAST` and the like); a refused envelope; a quote priced from a different forecast window than the decision (see below); or, with no quote visible, a market that has closed on block time (no quote outlives the close, and the contract fills only before `expiresAt`). Each goes through `releaseUnspent`: under the mandate lock, read now rather than from the run's snapshot, it refuses unless the reservation is still `HELD` with no approve or fill intent, and, for the RFQ refusal and the closed market (which assume there is no quote), no quote row under the buy's key either. A refusal hands the buy to the normal path (`WAITING:HANDED_OVER`), so a run with a stale view cannot give back a buy that another run has already carried to a quote or a transaction.
   - Nothing else releases. A late or missing answer is not a failure, and neither is any other RFQ answer: a 500 (the API gives every unexpected error a non-retryable 500), a 401 or 403 (the key is not usable), a 409 `IDEMPOTENCY_CONFLICT` or `REQUEST_IN_PROGRESS`, a 429, a 503, no answer at all. The buy stays `HELD` and the same RFQ is asked again under the same key, however old the buy is; a non-retryable odd answer is audited once per buy and code (`trader.rfq_unanswered`). The retry cadence follows the answer: a retryable answer (429, 503, a retryable `REQUEST_IN_PROGRESS`) or no answer (`WAITING:RFQ:<code>`) requests the 2 second resume run, while a non-retryable one (`WAITING:RFQ_NONRETRYABLE:<code>`: a 401 or 403, a 500, `IDEMPOTENCY_CONFLICT`) does not, because it will not clear soon and a 401 never meets the API's rate limiter; those buys wait for the 15 second tick, which re-evaluates every `HELD` buy. If it persists, the paths above end it: the market closes on block time, an intent fails, or the quote expires.
3. If the mandate is on and the market tradable: take the stored signed envelope or request the quote (`Idempotency-Key: trader-<buy id>`, `maxCostMicros` the decided ask's cost; a transient failure keeps the key and retries it), then verify it, including that its forecast snapshot belongs to the window the decision used (a newer window that closed since would price a different trade; the buy is released unspent and the new window is its own buy).
4. Approve exactly the taker cost to the market, drive the intent through the dispatcher until a block holds it with a successful receipt, re-read the live head (a quote with less than 6 seconds of block time left is left to expire), then fill and drive that the same way. A transaction that is merely pending, or INCLUDED with a not-yet-final failed receipt, keeps the risk and is resumed with the same intents.

**Every spending step is re-authorized.** Before the RFQ, before each prepare and before every dispatch the trader re-reads the mandate, the quote gates, the pause flags and the market, and asks the store, under the mandate's lock, whether the reservation is still `HELD` and the mandate still enabled. Release takes the same lock, so a buy that another run (or the operator) gave back is never prepared or dispatched afterwards, and switching the mandate off or opening a gate stops a fill that is already in progress, at its next step. What remains is the instant between the last check and the dispatch call itself. It cannot return risk for a position: once an intent is prepared (under the same lock, and before any dispatch) no release that rests on "nothing was spent" can succeed, and the releases that remain (a failed intent, an expired or cancelled quote) are ones after which no fill can land.

## What the trader checks before it spends

`verifyTraderQuote` re-derives everything and trusts nothing the API says: deployment id; the EIP-712 domain and types against the manifest; the message parses strictly; market and spec hash; the maker is the manifest's maker and the taker is the mandate's wallet; side and quantity; price at most the ask the decision saw; the lifetime and `expiresAt`; the costs recomputed from price and quantity; the digest recomputed with `hashTypedData`; the signature recovered to the maker; the returned calldata equal to the canonical `fillQuote` encoding. The approve and fill payloads are built from the verified message and signature only, never from the API's calldata.

## Runtime configuration

The trader is off unless `WORKER_TRADER_API_KEY` and `WORKER_TRADER_FORECASTER_ROLE` (`FORECASTER_A` or `FORECASTER_B`) are both set; one without the other, or another role, fails startup. It also needs the public API URL (`WORKER_API_URL`) and the whole execution configuration of the keeper and faucet (`BLINK_DEPLOYMENT_ID`, `SIGNER_URL`, `WORKER_SIGNER_CALLER_TOKEN`, `BASE_SEPOLIA_RPC_URL`); without them startup fails with `WORKER_TRADER_CONFIGURATION_INCOMPLETE`. More than one mandate for the role fails startup with `TRADER_MANDATE_AMBIGUOUS`.

Before it can trade, an operator must arrange, all outside this code:

- the signer has a `trader` key (`SIGNER_TRADER_KEY_FILE`), and the worker's token hash in `SIGNER_CALLERS` lists the `trader` role. The mandate's `wallet` must be that key's address; if it is not, the signer refuses the fill with `TAKER_NOT_ALLOWED` and the buy is released.
- an agent holding the `trade:quote` scope whose bound wallet is that same address, with its key in `WORKER_TRADER_API_KEY`;
- the wallet is on the contract's taker allowlist (the admin's `setTakerAllowed`), and holds bUSD and gas;
- a `trading.mandates` row, inserted by the database owner. Placeholders only: `INSERT INTO trading.mandates(agent_id, wallet, forecaster_role, policy_version) VALUES (<agent uuid>, decode('<20-byte wallet hex without 0x>','hex'), '<FORECASTER_A|FORECASTER_B>', '<policy version>')`; the caps default to the spec values. `UPDATE ... SET enabled = false` is the kill switch: it stops every new RFQ, approve and fill (also one in progress, at its next step), while settlement, expiry release and redeem continue.

## Migration and integration adjustments

- Only the new migration `0018_trader.sql` is added.
- The worker reads the platform forecasters' answers only through `trading.trader_snapshots`. The view runs with its owner's rights, shows nothing from a window before its deadline, and applies the RFQ's snapshot rule. The worker has no grant on `forecasts.submissions` or `forecasts.annotations` (an existing Task 7 test asserts that, and the platform forecasters run in the same worker process), and the view is not granted to the API. A first version that granted the answer columns directly failed that test and was replaced.
- `trading.trader_snapshot_windows` maps a snapshot id to its window id (the worker has no grant on `forecasts.snapshots`), so the trader can compare a quote's window with the decision's. It is not granted to the API either.
- The worker also gets `SELECT` on `trading.quote_gates` and `trading.mandates`, `SELECT`/`INSERT` on `trading.risk_reservations` with `UPDATE` on `(state, release_reason, updated_at)` only.
- Intents are created by the worker's existing grants on `signing.*`. The dispatcher is built inside `buildTrader` from the same parts `buildExecution` uses, so `execution.ts` is untouched; both can dispatch the same intent safely (optimistic attempt versions).
- `tx.dispatch` jobs are enqueued for the approve, fill and redeem under the keeper's dedupe key, and the execution tick's existing recovery query already re-enqueues trader intents in SIGNED, SUBMITTED, UNKNOWN or INCLUDED states.

## Differences from the brief

- `risk_reservations` carries extra columns beyond the brief's list (`deployment_id`, `market_id`, `window_id`, `side`, `shares`, `ask_bps`, `own_probability_millionths`, `release_reason`) and range checks. Without them a restarted worker could not continue a buy whose decision had been taken, and the brief's own columns are all present unchanged.
- The envelope checks are implemented locally in `verifyTraderQuote` because Task 15 (the client SDK) is not merged; they can be replaced by the SDK's verifier later.
- "Lock the mandate" is a transaction advisory lock, not a row lock (see above).
- `ACCOUNTED` follows the canonical projection, and reverts to `HELD` on a reorg. `RELEASED` also covers a refused first signature, a terminal RFQ rejection, a refused envelope, a quote of another forecast window and a market that closed with no quote: in each, nothing was or will be sent for the buy. An RFQ that is merely unanswered is never released for being late (an earlier version gave it back after 120 seconds; review showed that could return risk for a position, and it was removed).
- One buy per (mandate, market, window). A window whose buy was released is not retried; the next window may trade.
- No job type or registry change: `trader.evaluate` already existed.

## Verification

Run on 2026-10-15 (first version) and 2026-10-16 (fix round 1, whose numbers are below) in the task worktree against local PostgreSQL 17 and a local Anvil with chain ID 84532. No network, real key, deployment or paid service was used.

- `pnpm check`: exit 0, 524 Node tests, typecheck, contract compilation and package boundaries.
- `pnpm build`: exit 0.
- `pnpm build:services && pnpm test:service-build`: exit 0, 5 bundle tests.
- `pnpm test:anvil`: exit 0, 45 tests (1 new in `tests/anvil/trader.test.ts`): the real API (composed by `tradingServices`, on a loopback port), the real signer over HTTP (maker key for the API's caller, trader key for the worker's caller, both from mode 0600 files), the real dispatcher and indexer, and the worker's own `buildTrader` composition. A trader holding 50 bUSD and no allowance buys 10 YES at 6700 bps from a 0.80 / 0.50 ensemble; the signed approve is decoded from the stored transaction and is exactly 6,700,000 to the market on the token; the fill leaves the on-chain allowance at 0; the indexer then accounts the buy once; the tick schedules the per-window and five-minute evaluations and the two tracking jobs; after the market is proposed and finalized unchallenged the next run redeems through the signer (10 shares pay 10 bUSD, the position is zero), and a later run sends nothing twice.
- `TEST_POSTGRES_ADMIN_URL=... pnpm test:postgres`: exit 0, 35 tests (5 new in `tests/postgres/trader.test.ts`): twelve concurrent reservations from four pools admit exactly the daily cap (two of ten shares) and, in a second round, exactly the open cap (three); three concurrent evaluations over six markets leave exactly two `HELD` reservations and only two RFQ keys; every store query runs under the real `blink_worker` login (parameter typing differs from PGlite); the worker login cannot update a mandate, read `forecasts.submissions` or `forecasts.snapshots`, and the transition guard holds; twelve rounds of a spend (`prepare`) racing a release on one buy are serialized (an intent exists exactly when the spend won the lock, and nothing is authorized after the release).
- New unit and integration tests: `tests/trader-rule.test.ts` (7: vectors at the threshold, one millionth above, NO side, tie to YES, input validation, caps) and `tests/trader.test.ts` (22, over the real RFQ service, signer and store on PGlite with the worker's own role: the buy and its exact payloads, a NO edge and the exact-threshold case, every stop condition one by one and then a buy once all are cleared, daily / open / max-fill limits with deduplicated audit rows, yesterday not counting, a transient RFQ failure retried under the same key, a terminal rejection, an unanswered RFQ older than 120 seconds that is asked again and not released, a closed market with no quote released, the reviewer's interleaving of a slow run and a later run on one buy, a buy released between two steps or while its approve is pending (nothing further is prepared or dispatched), the mandate switched off or a quote gate opened mid-run, a quote priced from another forecast window left unspent, a run that stays within its 5 second budget with pending work deferred and resumed, fifteen tampered envelopes each refused before anything is signed, approve / fill revert, refusal and pending paths, accounting, reorg reopening, block-time-only expiry and the exact expiry boundary, a gated indexer, cancellation and epoch bump, a final fill leaving the working set, the mandate switch, redeem, no / ambiguous mandate and abort, the database grants and the embargo on open windows).
- Mutation checks (temporary, reverted), each makes at least one test fail: removing the mandate lock; an inclusive threshold; the host clock deciding expiry; not checking the taker; an approve one micro too large; filling without waiting for the approve; the daily cap ignoring `ACCOUNTED`; not reopening after a reorg; sending a redeem again; ignoring the business clock for close; ignoring indexer freshness; retrying a released window; settling through a gated indexer; not verifying the signature. Fix round 1, each re-introducing the old behavior: the age-based RFQ release; spending without authorization under the lock; not comparing the quote's window; no time budget; no check before every dispatch; no fresh gates between steps; no release of a closed market without a quote.

## Remaining limits and open items

- **No mandate admin tool.** Mandates are set by SQL as the database owner; there is no `trader:admin` command.
- **Binding the trader's wallet to its agent** needs a signature from the trader key over the API's wallet challenge. The key lives only in the signer, whose policy signs transactions and quotes, not messages, so this is a one-time operator step with the key file (or a database-owner insert as the tests do). No automated or shortcut path was added.
- **The mandate wallet is not machine-checked against the signer's trader address.** A mismatch fails safe (the signer refuses the fill) but wastes an approve and a window.
- **An orphaned approve** (its block reorged away after the approve was INCLUDED) makes the fill revert and costs gas; the buy is then released. A dangling exact allowance of an expired quote is overwritten by the next approve.
- **Open cap after a reorg.** Reopening an `ACCOUNTED` buy to `HELD` is a fact about the chain and cannot be refused, so `HELD` can briefly exceed the open cap until buys settle; new buys are then refused.
- **Finality.** Anvil reports finalized block 0, so FINALIZED and a finalized revert are exercised only through fake RPC in earlier tasks' tests; here a buy leaves the working set once the indexer's finalized block passes its fill, and the dispatcher's finality tracking is the keeper's and faucet's existing path.
- **One trader per deployment.** `trader.evaluate` jobs carry no role and the queue leases jobs by type only, so two worker processes configured with different roles would share the same jobs and each evaluate only the mandate of whichever process leased one. A second mandate needs a per-role job type (or a lease filter on the payload); until then run one trader.
- **Caps live only in the worker (review M8).** The signer signs any trader approve up to its fixed ceiling and any fill whose taker is the trader's key; it does not know mandates, so a buggy or compromised worker is limited by gas caps and the on-chain taker caps, not by the mandate.
- **The embargo view depends on a session-settable clock (review M4).** `trading.trader_snapshots` cuts at `blink.now()`, which honours the session setting `blink.test_clock_offset_seconds`; a `blink_worker` session that sets it could make an open window look closed and read its A/B answers. The worker code never does, `assertProductionClock` checks only the pool's default, and the task 7 isolation is "no grant" for everything except this view.
- **Duplicated composition (review M6).** `buildTrader` repeats the chain reader, dispatcher and signer client that `buildExecution` builds; returning the dispatcher from `buildExecution` would remove it.
- **Unlocked audit dedupe (review M7).** `audit()` outside `reserve` deduplicates with an unlocked `NOT EXISTS`, so two concurrent runs can write the same `trader.quote_refused` or `trader.redeem_failed` row twice. Cosmetic.
- **Intents left PREPARED.** A buy released before its transactions were signed leaves its intents PREPARED; nothing ever asks the signer for them.
- **Not covered:** a live Base Sepolia run, real keys, and a profit claim: the 500 bps rule and 10 shares are a functional test strategy (spec 12.3).
