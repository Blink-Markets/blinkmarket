# Data Model Design

This is the data model after P2, derived from migrations 0001–0034 (there is no 0021). P2 added migrations 0025–0034 and dropped the v0.1 tables for approval, candidates, budgets, signing, trading reservations, the trader, keeper, faucet and resolution reports; the dropped tables are listed at the end for history. Migrations are forward-only, and no applied file was edited. See [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md) for the migration list.

## Schemas and tables

| Schema | Tables | Main columns and constraints |
| --- | --- | --- |
| identity | operators, agents, api_keys | agent.operator_id FK; key_hash unique, the self-serve function issues only `forecast:write`, `rfq:write`, `content:write` and `suggestion:claim` (the check still allows the legacy scopes so already-issued rows stay valid; 0028 revoked every invite key); expires_at, revoked_at; no plaintext key. Created on first self-serve issue |
| identity | wallet_challenges, wallet_bindings | challenge: address, `action` (issue or revoke), `target_key_id`, `client_ip`, `attempts`, expires_at, consumed_at; binding verified by signature. `blink_api` may not INSERT bindings or update `consumed_at`; the `SECURITY DEFINER` functions `identity.issue_self_serve_key` and `identity.revoke_self_serve_key` do |
| content | objects | keccak256 hash, media type, size, uploader address; append-only; the bytes live in the object store |
| suggestions | items, claims, spec_links | public human suggestions; one claim per creator; spec links record the spec hash and suggestion id. Append-only. Status is derived at read time |
| rfq | requests, quotes | request taker/market/side/quantity/expiry; quote payload, signature bytes and digest stored exactly as received, one per maker per RFQ. Immutable; `blink_api` SELECT and INSERT only |
| forecasts | windows | UNIQUE(deployment, market, horizon_type, scheduled_at); open_at, deadline, `merkle_root`, `root_at`. A row-level trigger allows only the one-time root set |
| forecasts | submissions | signed forecast: forecaster address, probability, content hash, signature, digest (unique), `verified_block`; UNIQUE(window, forecaster). Append-only |
| forecasts | annotations | withdrawals only; a withdrawn answer stays listed |
| forecasts | closed_digests (view) | a window's digests, listed only after its deadline; the worker reads digests through it |
| analytics | score_entries | v1 rows untouched; v2 rows are `AGENT` per eligible answer and one `CONSENSUS` per window; UNIQUE indexes per evaluation version |
| analytics | closed_forecasts (view) | forecasts of closed windows for analytics |
| protocol | events | the journal of decoded protocol logs (emitter, contract, block hash, log index) with a `canonical` flag that a reorg clears |
| protocol | accounts, account_roles, credit, templates, markets, makers, positions, quote_digests, fills, anchors, successors | projections of the registry, markets and anchor, rebuilt from the journal |
| protocol | proposals, disputes, rounds, votes, jurors, reward_pool, fees | projections of resolution, juror and fee events (0031); a vote's choice is null until revealed |
| protocol | market_reads, position_reads, maker_reads (views) | read views over the projections |
| chain | blocks, cursors | block hash, parent hash, number, canonical flag; the deployment cursor with a fenced lease (`lease_token`, version) |
| chain | transactions | transactions an agent reported: sender, target, function name decoded from the protocol ABI, status UNKNOWN / INCLUDED / FINALIZED / REVERTED / REORGED |
| markets | protocol_deployments | the verified manifest v2 of a generation; immutable (trigger); `blink_deployment_admin` writes |
| operations | jobs, outbox | dedupe_key, type, attempt, next_run_at, lease_until, lease_owner, last_error; the worker registry holds only `forecast.schedule`, `evaluation.score`, `alert.deliver`, `alert.evaluate` and `operations.prune` |
| operations | idempotency_records, audit_log, alert_episodes | UNIQUE(operator, endpoint, key) with payload_hash; append-only audit; one alert episode per condition |
| markets | deployments, deployment_checks | v0.1 deployment registry, retained because migrations are append-only (`alpha-2` is a v0.1 record). The v2 record is `protocol_deployments` |

Runtime roles in the migrations: `blink_api`, `blink_worker`, `blink_indexer` and `blink_deployment_admin`, plus the group roles. The retired roles `blink_identity_admin`, `blink_evidence_admin` and `blink_forecast_admin` were dropped by 0028, 0030 and 0033.

## Constraints that matter

- A protocol event is identified by deployment, block hash and log index. The block hash lets an orphaned transaction be included again in another block. The canonical projection uses canonical events only, and an orphaned event is never treated as permanently consumed.
- All chain data carries the deployment id. A `marketId` is meaningful only inside one generation.
- UInt columns use the `blink.uint256` domain: NUMERIC plus a CHECK that the value is an integer in range. This avoids NUMERIC(78,0) rounding a fraction first.
- All business times are TIMESTAMPTZ and stored in UTC. A chain timestamp uses NUMERIC decimal seconds separately.
- Quotes, forecasts, content and suggestions are append-only. The service role is not granted UPDATE or DELETE on them. A withdrawal or annotation is an additional row.
- A forecaster has at most one submission per window, enforced by a unique index and, for admission, by the window row lock and the database clock.
- Challenge and quote limits are enforced under advisory locks or row locks (at most 5 open RFQs per taker, 20 quotes per RFQ, 5 active keys per address).
- The chain canonical flag and projections can be modified and rebuilt; the journal, audit and ledgers cannot.

## Atomic transactions

1. Key issue: lock the challenge row and the address advisory lock, re-read the clock after every wait, create the operator, agent and binding if needed, insert the key and consume the challenge, in one function.
2. Quote: lock the RFQ, re-check that it is still open and unexpired against the relay clock, then insert the quote.
3. Forecast: lock the window row, admit by the database clock, insert the signed submission.
4. Indexing: deployment lease → canonical block, events, projections and cursor in the same transaction; a rebuild reads at a consistent snapshot.
5. Idempotency: insert the scope key and payload hash → on a unique conflict return the original response, and 409 if the payload differs.

SKIP LOCKED is used only for claiming jobs. A handler does not hold a long DB transaction while doing external IO.

## Recovery

Daily backup plus the object store. Restore the dump into an empty database, then run `restore:prepare`, which releases the dumped cursor lease. The indexer replays from the deployment block. The local `pg_dump` and restore drill is `pnpm drill:restore` ([Restore drill](M5_RESTORE_DRILL.md)); a hosted rehearsal has not been done because nothing is deployed.

## History: v0.1 tables dropped by P2

Candidates and revisions, evidence and sources, approvals and creation intents and active slots, the market spec table, question and daily budgets and cost entries, platform runs, forecast snapshots and pending answers, model runs, signing requests and nonces, trading reservations and mandates, trader state, keeper schedules, faucet claims and resolution reports. They are described in the v0.1 delivery records (`docs/M2_*.md`, `docs/M3_*.md`) and [Architecture Diagrams](ARCHITECTURE_GUIDE.md), all marked historical.
