# M2 public reads and transaction tracking

This slice enables the public read endpoints of spec §10.2 from the chain projections (`chain.*`, migration 0007) and adds `POST /v1/transactions` hints with an indexer-side tracker that independently verifies them. Nothing here signs or sends a transaction, and trading stays disabled: `canTrade` is `false` unless a later task injects `hooks.canTrade`.

中文摘要：公開讀取 API（市場列表／詳情／規格／持倉／結算／交易追蹤）改由鏈上投影資料提供；交易 hash 只是提示，由 indexer 端的追蹤器獨立向鏈上驗證，API 不採信呼叫者的任何狀態。

## What was added

| Piece | Where | Behavior |
| --- | --- | --- |
| Route service | `packages/application/src/market-read.ts`, `packages/adapters/src/market-read-store.ts`, `packages/ports/src/market-read.ts` | `createMarketReadService` claims `GET /v1/markets`, `/v1/markets/:id`, `/v1/markets/:id/spec`, `/v1/markets/:id/resolution`, `/v1/accounts/:address/positions`, `GET /v1/transactions/:txHash` and `POST /v1/transactions`. The API registers it in `markets` and `trading` modes and turns on `publicReadLimit {capacity: 60, refillPerSecond: 1}` there. |
| Transaction table | `0011_tx_tracking.sql` | `chain.transactions`. `blink_api` SELECT/INSERT; `blink_indexer` SELECT and UPDATE of `status, reject_reason, receipt_block_hash, receipt_block_number, market_id, version, updated_at` only; `blink_worker` SELECT. |
| Tracker | `packages/application/src/tx-tracking.ts`, `packages/adapters/src/tx-tracking-store.ts`, `packages/adapters/src/tx-receipt-reader.ts` | `createTxTracker({store, reader, manifest}).trackOnce(limit)`. The indexer runs it every 2 s with a batch of 50 when `INDEXER_TX_TRACKING_ENABLED=true`. It is a separate block from the creation poller and from the chain projection indexer (Task 5). |
| Contract changes | `packages/schemas/src/http.ts`, `core.ts` | `GET /v1/transactions/:txHash` gains `rejectReason: string \| null`. `ErrorCode` gains `INVALID_CURSOR`, `SPEC_UNAVAILABLE`, `TX_ALREADY_TRACKED`. |

## Read behavior

- **List.** Ordered by `(created_block_number DESC, deployment_id, market_id DESC)`. Filters: `deploymentId`, `mode`, `status` (the effective state), `entity`. `limit` defaults to 20, maximum 100. `nextCursor` is the base64url of `{b, d, m, f}` where `f` is the SHA-256 of the normalized filters (for positions it also covers the wallet). A cursor that is malformed, not in canonical encoding, built for other filters, or whose anchor row is not in the filtered set returns 400 `INVALID_CURSOR`. The cursor is an unsigned position over public data, not a credential: a client that edits it to point at another existing market only changes its own view, which it could reach by paging.
- **Entity filter.** `entity` matches `snapshot->>'entityId'` of the approved candidate revision, joined through `markets.approvals.spec_hash = chain.markets.spec_hash` (and the same deployment). A market without an approval is listed but never matches an entity filter.
- **Effective state.** `CLOSED` when the stored state is `OPEN` and `blink.now()` is at or past `close_at`; otherwise the stored state. `paused` is the market flag or the deployment's global pause.
- **Trading permission.** Without `hooks.canTrade`: `canTrade=false`, `reasons` from `TRADING_DISABLED`, `MARKET_CLOSED`, `TRADING_PAUSED`, `INDEXER_LAG`, in that order. `INDEXER_LAG` appears when the cursor is missing, carries a `gate_reason`, or `synced_at` is more than 10 s old on the database clock.
- **Chain cursor.** `{blockNumber, blockHash, finality}` of the deployment cursor. `finality` is `UNKNOWN` when `finalized_number` is null, `FINALIZED` when the market's creation block is at or below it, otherwise `INCLUDED`. With no cursor row the response reports block `0`, the zero hash and `UNKNOWN`, rather than inventing a block.
- **Detail.** Summary plus the parsed `MarketSpec`, `resolution`, `forecastSnapshotId` (hook or `null`) and `costMicros` (hook or `"0"`). The spec is read through `SpecArchive.read`, which verifies the hash; a hash or parse failure returns 503 `SPEC_UNAVAILABLE` (not retryable) and appends an `spec.integrity_failed` audit row. The archive object URI comes from `markets.specs`, never from the event-provided `spec_uri` when an approved spec exists.
- **Spec.** The archived bytes, unmodified, as `application/json` with `ETag: "<specHash>"` and `Cache-Control: public, max-age=31536000, immutable`.
- **Positions.** Rows with `yes_shares + no_shares > 0` (the contract deletes the position on redeem, so redeemed positions have zero shares and are omitted). `payoutMicros` is `null` unless the market is `FINAL`; then YES is `yes * 1e6`, NO is `no * 1e6`, INVALID is `(yes + no) * 500000`. `pendingIntentIds` lists this wallet's `chain.transactions` rows that are `UNKNOWN` with the same `market_id`.
- **Resolution.** Proposed and final fields come from the projection; `proposedAt`, `challengeEndsAt` (proposal plus the market's challenge seconds) and `hardDeadline` are ISO UTC from chain seconds.

## Transaction hints and tracking

`POST /v1/transactions` accepts any valid key whose agent has a wallet binding (403 `WALLET_NOT_VERIFIED` otherwise). It uses the shared idempotency claim (scope `POST /v1/transactions`, payload hash over the key id and the normalized body). The row stores the bound wallet, never a caller-supplied one, and always starts `UNKNOWN`; the strict body cannot carry a status. The same `(deployment, txHash)` from the same agent returns 202 with the existing `trackingId`; from another agent it returns 409 `TX_ALREADY_TRACKED`. An unregistered deployment returns 404.

The tracker re-derives everything from the chain:

| Check | Mismatch result |
| --- | --- |
| Chain id is 84532 (8453 throws `MAINNET_REFUSED`) | the run stops with the error and writes nothing for that row |
| `from` equals the stored wallet | `SENDER_MISMATCH` |
| `to` is BlinkMarket (FILL, REDEEM) or BlinkTestUSD (APPROVE) | `TARGET_MISMATCH` |
| Selector decodes to the action; APPROVE spender is BlinkMarket | `ACTION_MISMATCH` |
| FILL: the EIP-712 digest of the decoded quote (`hashTypedData`, domain `Blink RFQ` / `0.1` / 84532 / BlinkMarket, `quoteTypes`) equals `quote_id` | `QUOTE_MISMATCH` |

A mismatch sets `reject_reason` and the row leaves the tracking set. FILL and REDEEM set `market_id` as soon as the transaction is seen, so a pending hint already appears in `pendingIntentIds`. A canonical successful receipt gives `INCLUDED` (`FINALIZED` at or below the finalized block, when the provider supports that tag), a failed one `REVERTED`. An `INCLUDED` row whose receipt block is no longer canonical becomes `REORGED` and stays tracked; a later canonical receipt makes it `INCLUDED` again. A transaction the node cannot find stays `UNKNOWN`. The tracker never resubmits anything. Updates are version-checked, and every visited row is rewritten so one stuck hash cannot starve later ones.

## Verification

Run on 2026-10-14 in the task worktree (PGlite for database tests).

- `pnpm check`: exit 0 (TypeScript including the web typecheck, contract compilation, 144 Node tests, package boundaries).
- `pnpm build`: exit 0.
- `pnpm build:services && pnpm test:service-build`: exit 0, 2 bundle tests pass. The indexer bundle also fails closed when tracking is enabled and the database is unreachable.
- New tests: `tests/market-read.test.ts` (7), `tests/tx-tracking.test.ts` (7), plus one in `tests/indexer-config.test.ts`. Each successful response shape is parsed with its contract schema at least once; follow-up pages and error envelopes are checked field by field.
- Not run: `pnpm test:postgres` and `pnpm test:anvil` (no PostgreSQL server in this environment; the brief lists no Anvil test for this task). The receipt reader is tested against deterministic RPC fixtures with real ABI-encoded calldata, not a live node.

## Remaining limits

- The tracker needs the Task 5 projection only for `pendingIntentIds` and cursors; it does not read or write positions. Real-PostgreSQL concurrency of the hint insert (two agents racing on one hash) relies on `ON CONFLICT DO NOTHING` plus the unique key and is covered only on PGlite.
- Every spec integrity failure appends one `spec.integrity_failed` audit row, including on unauthenticated GETs; the public read limit bounds the rate per client address.
- `GET /v1/transactions/:txHash` is public and unauthenticated by contract; it exposes status, block and reject code, never the wallet or agent.
- The receipt reader makes several RPC calls per tracked row per tick (transaction, receipt, finalized block, canonical checks). That is acceptable for the local alpha and should be batched before heavy use.
- The position rule "FINAL and payout > 0 and not yet redeemed" is covered by the shares rule only while the projection zeroes shares on `PositionRedeemed`, as the contract does. Task 5 must keep that behavior.
- `hooks.forecastSnapshotId`, `hooks.costMicros` and `hooks.canTrade` are wired by later tasks (7, 9); until then the defaults apply.
- The public read limit stays in-process and keyed by `request.ip` (see `M2_FOUNDATION_SEAMS.md`).
