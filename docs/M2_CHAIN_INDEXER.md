# M2.4 — Canonical chain indexer

> Historical (v0.1): this indexer folded the `BlinkMarket` v0.1 events. P2 Task 5 replaced it with the multi-contract protocol index (registry, jurors, markets, resolution, faucet, anchor and governor), and Tasks 5 and 7 added the read models. The lease, fencing, reorg and rebuild ideas carried over; the 3-block and 10-second RFQ gate became the 30-second timestamp-lag gate. See [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md).

This slice adds the per-deployment indexer that scans the BlinkMarket contract's logs into `chain.events`, folds them into the rebuildable projections of migration 0007, survives reorgs and duplicate delivery, cross-checks the projections against contract reads, and publishes the freshness the RFQ gate needs (spec 14.2, design 04 "Indexer"). It is a second, independently enabled loop in `apps/indexer`; the opt-in creation receipt poller is unchanged. Nothing here signs, sends or reads private keys, and no migration was added (0007 and the existing grants were enough).

## What it does

| Piece | Where | Behavior |
| --- | --- | --- |
| Reducer | `packages/domain/src/chain-reducer.ts` | Pure bigint fold of the 12 event types. It asserts the fill arithmetic (`takerCost + makerCost = q * 1e6`, `takerCost = q * priceBps * 100`), maker balance, one-step epochs, outcome state transitions, redeem payouts (YES `yes*1e6`, NO `no*1e6`, INVALID `(yes+no)*500000`) and, after every event, `escrow = totalPairs * 1e6` for a market that is not FINAL. A rejected event throws `ChainProjectionError("INCONSISTENT_EVENT")` and leaves the projection untouched. `foldEvents` sorts by `(blockNumber, txIndex, logIndex)`. |
| Ports | `packages/ports/src/chain-index.ts` | `ChainLogReader`, `ChainIndexStore`, `IndexCursor`, commit shapes. It re-exports the domain projection types because `adapters` may import only `schemas` and `ports`. |
| Indexer | `packages/application/src/chain-indexer.ts` | `createChainIndexer(...).syncOnce()`, `startChainIndexer(...)` (poll loop with `stop()` and `health()`), `chainIndexHealth`, `rebuildChainProjection`. |
| Store | `packages/adapters/src/chain-index-store.ts` | PostgreSQL implementation: fenced lease, atomic range and reorg commits, projection load/replace, `loadChainDeployment`. |
| Reader | `packages/adapters/src/chain-log-reader.ts` | viem implementation. Logs are decoded with `blinkMarketAbi` into decimal strings and lowercase hex; a removed, pending, foreign-address or undecodable log is an error. Contract reads use EIP-1898 (`blockHash` with `requireCanonical`). The `finalized` tag reads as `null` only when the provider answers "method or params not supported"; any other failure propagates. |
| Process | `apps/indexer/src/main.ts`, `config.ts`, `chain-health.ts` | `CHAIN_INDEXER_ENABLED=true` starts the loop next to the creation poller. |
| Tool | `scripts/rebuild-chain-index.ts`, `pnpm chain:rebuild` | Recomputes projections from canonical events; `--verify` only compares. Also bundled to `dist/tools/rebuild-chain-index.mjs`. |

## Sync algorithm (per `syncOnce`)

1. The first call creates the cursor at `deploymentBlock - 1` (that block's hash and timestamp, plus an empty `maker_state` row). The cursor starts with `synced_at = epoch`, so it is not ready until the first real sync commits. Then the fenced lease is claimed or renewed; every claim raises `lease_token`.
2. Read `head` and `finalized`. A head below the cursor is a lagging provider: nothing is written. If `block(cursor)` no longer has the cursor's hash, the reorg routine runs.
3. `to = min(head, cursor + rangeSize)`. With nothing to read, only `head_number` and `synced_at` are refreshed; an idle poll compares nothing, so while the gate is `PROJECTION_MISMATCH` it writes nothing and leaves the gate in place.
4. The range end is pinned first: the header of `to` is read before anything else of the range. Logs for `(cursor, to]` are then filtered (logs at or below the cursor are skipped, repeats of one `(blockHash, txHash, logIndex)` count once, a log above `to` is an error), and a header is read for every other block that holds events. Every log's block hash must equal the header read for its height in this pass. The cursor header, the pinned end and every event-block header are then read again and must be unchanged; any difference (a reorg, or a branch that flipped away and back, in the middle of the read) commits nothing and the next poll retries.
5. Every range that advances the cursor, with or without events, is compared with contract reads pinned to the end hash: maker free balance and epoch always, plus `totalPairs`, `escrow` and `state` of every market the events name (even when the fold ends up changing nothing), every market the fold changed, and all markets while recovering from a mismatch. The events are first applied to a copy of the stored projection; on a mismatch, or when the events contradict the projection, every canonical event is refolded together with the new ones and compared again. If that still disagrees, `gate_reason = PROJECTION_MISMATCH` and the cursor does not move. This gate is retried on every advancing call and is cleared only by a commit whose cross-check passed in that call.
6. One transaction, fenced by the lease token **and** the cursor version: move the cursor, upsert blocks and events, upsert the changed projection rows (or replace all of them after a refold), append outbox `chain.synced` (`aggregate_id` = deployment id, `event_version` = the new version) and one `market.indexed` per new market (`aggregate_id` = `<deployment>:<marketId>`). Rows written by a sync carry `as_of_block_hash` of the range end. An idle poll publishes no outbox event.
7. **Reorg:** commit `REORG_IN_PROGRESS` first, then walk the stored canonical blocks downward until one matches the provider. An ancestor below the finalized block (or no matching block) sets `FINALIZED_CONFLICT`: no rollback, no automatic recovery, every later call returns without advancing. Otherwise one transaction marks blocks and events above the ancestor `canonical = false` (rows are kept as tombstones), replaces the projections with the fold of the surviving events, moves the cursor to the ancestor and appends `chain.reorged {deploymentId, ancestorNumber, ancestorHash, orphanedFrom}`. The gate lifts when a verified sync reaches the head. A branch that later returns to the canonical chain revives its tombstoned rows instead of duplicating them.

Anvil's `finalized` tag lags the head by 64 blocks (observed: 0 at head 5, 41 at head 105), so short local reorg tests never reach a finalized conflict.

## RFQ gate freshness

`GET /health/chain-index` returns `ChainIndexHealth` (`deploymentId`, `blockNumber`, `headNumber`, `lagBlocks`, `syncedAt`, `ageMs`, `gateReason`, `ready`), 200 only when `lagBlocks <= 3`, `ageMs <= 10000` and there is no gate reason, otherwise 503. Age is measured with the database clock (`blink.now()`), the same clock that writes `synced_at`. A disabled indexer or a failed health query is a 503 with `ready: false`.

## Runtime

| Setting | Default | Meaning |
| --- | ---: | --- |
| `CHAIN_INDEXER_ENABLED` | `false` | Enables the chain indexer; independent of `INDEXER_CREATION_POLLING_ENABLED` |
| `INDEXER_DATABASE_URL` | none | Non-owner login with `blink_indexer` membership (shared with the creation poller) |
| `BASE_SEPOLIA_RPC_URL` | none | Read endpoint; the process refuses chain ID 8453 (`MAINNET_REFUSED`) and any ID other than 84532 |
| `INDEXER_DEPLOYMENT_ID` | none | Row of `markets.deployments`; its `market_address` and `manifest.deploymentBlock` are loaded at startup |
| `INDEXER_CHAIN_POLL_MS` | `1000` | Delay between calls once caught up (a call that made progress is followed immediately by the next) |
| `INDEXER_CHAIN_RANGE` | `500` | Blocks per `eth_getLogs` window, at most 10000 |
| `BLINK_ALLOW_TEST_CLOCK` | unset | `1` lets a local harness start with a `blink.now()` offset; otherwise startup fails with `TEST_CLOCK_FORBIDDEN` |

Startup order: runtime role check (the same non-privileged `blink_indexer` check the creation poller uses), `chain.cursors` installed, `assertProductionClock`, deployment load, chain ID check. The lease lasts 30 seconds and is not configurable by environment.

`pnpm chain:rebuild <deploymentId> [--verify]` needs `INDEXER_DATABASE_URL` for an indexer login. Without `--verify` it takes the cursor lease (it fails with `CHAIN_INDEX_LEASE_HELD` while a running indexer holds it, so stop the indexer first), rewrites only when the stored projection differs, and releases the lease. With `--verify` it reads events and projections in one `REPEATABLE READ` snapshot, writes nothing, prints the differing entries and exits 1 if there are any (this is what the restore drill runs). A missing `chain.maker_state` row counts as a difference (`maker`) even when the fold's maker state is all zeros, and a repair recreates it.

## Verification

Run on 2026-10-14 in the task worktree, PostgreSQL at `127.0.0.1:55405`.

- `pnpm check`: exit 0. TypeScript including the web typecheck, contract compilation, 181 Node tests (129 before this slice, 52 new) and package boundaries.
- `pnpm build`: exit 0.
- `pnpm build:services && pnpm test:service-build`: exit 0, 2 bundle tests pass; `dist/tools/rebuild-chain-index.mjs` is built.
- `pnpm test:anvil`: exit 0, 3 tests. The new ones index a full REPLAY lifecycle (market, pauses, taker allow-list, deposit, YES fill, cancel, withdraw, epoch, proposal, unchallenged finalization, both redeems) and assert every projection equals `getMarket`, `getPosition`, `cumulativeTakerShares`, `takerAllowed`, `makerFreeBalance`, `currentMakerEpoch`, `globalTradingPaused`, `consumed` and `cancelled`; and an `evm_snapshot`/`evm_revert` reorg that tombstones the orphaned fill.
- `TEST_POSTGRES_ADMIN_URL=… pnpm test:postgres`: exit 0, 2 tests. The new test races two indexer pools for one lease for six rounds, checks that only one advances per lease, that a stale holder is rejected by token and by version on every mutating store call, that the outbox has no duplicate versions, and that the rebuild tool repairs a damaged projection. Pool connection errors and teardown failures fail the test (the database is dropped with a plain `DROP DATABASE`, retried only while the closing backends of the ended pools exit). It passed 12 of 12 sequential runs and 30 of 30 runs when five copies ran concurrently against the same server.
- Mutation checks (temporary, reverted): removing log de-duplication, the lease token fence, tombstoning, the lagging-head guard, the mid-read re-check, the finalized-conflict check, the fill arithmetic assertion or the opposite-side update each makes at least one new test fail.
- Review fix round 1: each regression test (pinned range end with the A/B interleaving and the flip-and-back variant, empty-range cross-check, omitted logs, idle poll versus the mismatch gate, touched-but-unchanged markets, missing maker row in `--verify`, atomic outcome handlers) fails against the first implementation and passes now.
- New tests: `tests/chain-reducer.test.ts`, `tests/chain-indexer.test.ts` (fake chain plus PGlite store as `blink_indexer`), `tests/chain-log-reader.test.ts`, `tests/anvil/chain-indexer.test.ts`, `tests/postgres/chain-indexer.test.ts`, and chain additions to `tests/indexer-config.test.ts`.

## Remaining limits

- **Provider support:** the reader assumes `eth_call` accepts an EIP-1898 `blockHash` object with `requireCanonical` (Anvil does). A provider without it makes the contract read fail, so a sync errors and writes nothing; the block-number fallback with header re-checks from design 04 is not implemented. No real Base Sepolia endpoint was contacted.
- **Ancestor granularity:** only blocks with events and the end of each range are stored. A reorg right after a long catch-up can therefore find an ancestor far below the true fork point; if that is below the finalized block the result is a conservative `FINALIZED_CONFLICT`, never a wrong rollback.
- **Manual recovery:** `FINALIZED_CONFLICT` has no tooling beyond `chain:rebuild`; clearing it after an operator has investigated the provider is a manual database action. `PROJECTION_MISMATCH` retries on its own.
- **Idle outbox:** `chain.synced` is written when the cursor advances, not on every idle poll; the cursor's `synced_at` is the freshness signal.
- **Scale:** a refold or reorg loads every canonical event of the deployment and rewrites the projection tables; that is fine for v0.1 volumes. `as_of_block_hash` on a projection row is the cursor block at which the row was last written, not a per-row event block.
- **Not covered here:** quote/reservation reconciliation (Task 9), the RFQ gate's own use of the endpoint, and any chain-index read API (Task 6).
