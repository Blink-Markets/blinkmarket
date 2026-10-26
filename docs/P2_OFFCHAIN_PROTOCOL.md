# P2 off-chain protocol delivery

P2 rewrote the off-chain side so that the platform keeps only infrastructure. After P2 the platform:
- runs an API, an indexer and a worker;
- holds no private key and signs nothing;
- plays no market role: it does not approve, create, quote, forecast, trade, propose, challenge, arbitrate, keep or fund;
- relays and stores only what agents sign or upload, and cannot forge or alter any of it.

This stage involves no deployment, no signing with a real key and no broadcast to a public network. Everything was verified on a local Anvil (chain ID 84532), in local PostgreSQL 17.6 and in CI. The `alpha-2` deployment record and manifest are kept as history; they are not the target deployment.

The design is [the approved autonomous market design](superpowers/specs/2026-10-23-autonomous-market-design.md). The per-task record, with rulings, deviations and review fixes, is [P2 progress](P2_OFFCHAIN_PROGRESS.md). The contracts are in [P1](P1_PROTOCOL_CONTRACTS.md).

This is a slice of the roadmap, not the whole vision. P3 (reference agents, agent docs, the autonomous drill) and P4 (website, video) are not done. The final whole-branch review of P2 is still pending.

## What the platform runs now

| Process | Responsibility | Does not do |
| --- | --- | --- |
| API (`apps/api`, modes `scaffold`, `identity`, `markets`) | Self-serve wallet identity, public reads of the indexed protocol, RFQ and quote relay, transaction tracking, content upload, human suggestions, signed forecast submission and windows | Approval, admin actions, quote pricing, any signature |
| Indexer (`apps/indexer`) | Reads the registry, jurors, markets, resolution, faucet, anchor and governor of a registered generation; reorg handling; projections and read models for credit and fee share | Executing governance |
| Worker (`apps/worker`) | `forecast.schedule`, `evaluation.score`, `alert.deliver`, `alert.evaluate`, `operations.prune` | Discovery, forecasting, baseline, trading, keeping and faucet jobs |
| Web (`apps/web`) | Documentation site and read-only samples | Trading, positions, administration |

`apps/signer` and its container image no longer exist. `assertNoRoleKeys` makes the API, worker and indexer refuse to start when their environment holds a private key, a mnemonic, a key file or a bare 32-byte hex value (see [platform keys](#platform-keys-cannot-exist)).

## What was removed

This is the design's §6 checklist, with the files. Migrations were only added, never edited; the `alpha-2` manifest is byte-identical.

| §6 item | Removed (Task) | Replaced by |
| --- | --- | --- |
| Contracts: the v0.1 `maker`, `admin`, `resultProposer`, `challenger` and `arbiter` roles, the pause switches and `arbitrate`; the fixed bUSD minter | `contracts/src/BlinkMarket.sol`, `contracts/src/interfaces/IBlinkMarket.sol` and the v0.1 Foundry tests `BlinkMarket.t.sol`, `Adversarial.t.sol`, `Invariant.t.sol`, `TestBase.sol`, plus the v0.1 reducer, ABI, log and store adapters and deployer (5) | The P1 protocol contracts in `contracts/src/protocol/`. `BlinkTestUSD` stays, and `BlinkFaucet` is its immutable minter |
| Market approval flow | `application/{approval,approval-preflight,preparation,creation-tracker,creation-poller}.ts`, `adapters/{approval-store,preparation-store,creation-tracker-store,creation-tracking-schedule,creation-receipt-reader,creation-calldata}.ts`, the matching ports, `domain/approval.ts`, `schemas/{preparation,creation-status}.ts`, `scripts/reconcile-creation.ts` (2) | Agents create markets on chain through `BlinkMarkets` |
| Platform agents | `application/{discovery,platform-forecaster,budgeted-model,evidence-fetch,keeper,faucet,trader,resolution}.ts`, `apps/worker/src/{execution,trader}.ts`, the matching stores, the fixture model gateway and the model budget ledger, `domain/{trader-rule,keeper,prompts,costs}.ts`, `fixtures/replay/models/`, `scripts/{local-replay,resolution-draft}.ts` (1, 2) | Independent agents; the faucet is on chain |
| Signer and dispatcher | `apps/signer`, `infra/Dockerfile.signer`, `application/{signer,tx-dispatcher,execution}.ts`, `adapters/{signer-client,signing-calldata,signing-rpc,signing-store,gas-oracle,key-file,execution-chain-reader}.ts`, `domain/signing-policy.ts`, `ports/signing.ts`, the platform nonce management and the signing runtime role (migration `0025`) (1) | Nothing: the platform has no business that needs a signature |
| Invite-only identity | `scripts/identity-admin.ts`; migration `0028` revokes every active invite key and drops `blink_identity_admin` (6) | Self-serve wallet identity |
| Single-maker pricing and reservations | `application/{rfq,quote-reconcile}.ts`, `domain/pricing.ts`, `adapters/{trading-store,trading-admin}.ts`, `apps/api/src/trading.ts`, `scripts/trading-admin.ts` (1) | The multi-maker RFQ relay |
| Evidence and forecast administration | `adapters/{evidence-admin,spec-archive,forecast-admin}.ts`, `scripts/{evidence-admin,forecast-admin}.ts`; migrations `0030` and `0033` drop `blink_evidence_admin` and `blink_forecast_admin` (8, 10) | Hash-addressed content and signed forecasts |
| v0.1 documentation | Fixed roles, manual approval and team-operated disclosures are marked historical in the v0.1 delivery docs and the web role pages | This document, [P2 progress](P2_OFFCHAIN_PROGRESS.md) and the notices below |

Migrations added by P2:

| Migration | Change |
| --- | --- |
| `0025_retire_platform_execution` | Dead-letters queued execution and quote-reconciliation jobs (`RETIRED_P2`), removes the retired storage and roles |
| `0026_retire_platform_research` | Marks retired job types `DEAD`, drops the research, budget, candidate and creation tables, recreates `analytics.final_forecasts` without the platform-agent join |
| `0027_protocol_deployments` | `markets.protocol_deployments`: an immutable record of a verified manifest v2 |
| `0028_self_serve_identity` | Wallet challenges for issue and revoke, the `SECURITY DEFINER` issue and revoke functions, drops `blink_identity_admin` |
| `0029_protocol_index` | Protocol event and projection tables, replacing the retired chain projections |
| `0030_content_and_suggestions` | `content` and `suggestions` schemas, drops `markets.specs` and `blink_evidence_admin` |
| `0031_protocol_resolution` | Proposal, dispute, round, vote, juror, reward-pool and fee projections |
| `0032_rfq_relay` | `rfq.requests` and `rfq.quotes`, immutable |
| `0033_signed_forecasts` | Signed submissions, window roots, `analytics.closed_forecasts`, drops `blink_forecast_admin` and the `evidence` schema |
| `0034_fees_undistributed_alert` | Widens the alert family list for `fees_undistributed` |

## Self-serve identity

An identity is a wallet address. It proves control with a signature and receives an API key, with no invitation and no operator console.

1. `POST /v1/auth/wallet-challenges` (public) takes `{ address, action: "issue" | "revoke", keyId? }` and returns `{ challengeId, message, expiresAt }`. The challenge lives 300 seconds.
2. The wallet signs `message`. The check goes through the `SignatureVerifier`, so EOAs, ERC-1271 contract wallets and ERC-6492 signatures all work. A node failure answers `503 SIGNATURE_CHECK_UNAVAILABLE`.
3. `POST /v1/auth/wallet-verifications` (public) takes `{ challengeId, signature }`. `issue` needs a fresh index (`503 INDEX_STALE`) and a registered account (`403 NOT_REGISTERED`), and returns `{ apiKey, keyId, expiresAt }`. `revoke` needs neither, and revokes the key only if the signing address owns it.

A key lasts 30 days, an address holds at most 5 active keys (`409 KEY_LIMIT_REACHED`), and the scopes are exactly `forecast:write`, `rfq:write`, `content:write` and `suggestion:claim`. A challenge is single use. Challenge and verification attempts are bounded per client IP and per address (sliding windows, `429 RATE_LIMITED`). The `SECURITY DEFINER` functions lock the challenge row, so concurrent verifications issue one key, and they re-read the clock after every lock wait.

Writes that act for an identity also need the matching role in the indexed current generation, checked at request time. Reads are public.

## RFQ relay rules

The relay stores and returns maker-signed quote fields and signature bytes unchanged, and it never prices a quote (`packages/application/src/rfq-relay.ts`, migration `0032`).

- `POST /v1/rfqs` needs `rfq:write` and the TAKER role. An RFQ stays open 30 seconds, a taker holds at most 5 open RFQs, and an RFQ holds at most 20 quotes, one per maker.
- `GET /v1/rfqs` and `POST /v1/rfqs/:id/quotes` need `rfq:write` and the MAKER role.
- A quote is accepted only if, in this order: the RFQ is open; taker, market, side and quantity equal the RFQ's; the spec hash equals the indexed market's; the quote names the caller as maker and is signed (ECDSA for a maker without code, ERC-1271 for a contract wallet, the same rule as `BlinkMarkets.fillQuote`); `0 < priceBps < 10000`; the lifetime is at most 60 seconds; expiry is after now and not after the market closes; the epoch is the maker's current one; the digest is UNUSED; the maker's free balance covers `quantity x 1_000_000 - takerCost`.
- After the signature check the relay checks again (clock, RFQ openness, quote expiry, market tradability, index health, epoch, digest, balance), and the store re-checks under the per-RFQ lock that the RFQ is still open.
- Every refusal happens before anything is stored. Writes answer `503 INDEX_STALE` while the index lags more than 30 seconds.
- Quotes go only to the RFQ's taker, cheapest first. The relay may refuse to relay (censorship); it cannot forge or modify a quote.
- ERC-6492 wrappers and high-s signatures are refused for quotes, because `BlinkMarkets.fillQuote` rejects them: a wrapped quote could never fill.
- `@blink/client` `verifySignedQuote` is how the taker checks a quote itself. `approvalFor(quote, feeBps)` gives the fee-inclusive allowance.
- `POST /v1/transactions` and `GET /v1/transactions/:txHash` track a transaction for the protocol generation: the sender must be the key's wallet and the target a contract of the current generation, the faucet or the anchor. Statuses are UNKNOWN, INCLUDED, FINALIZED, REVERTED and REORGED.

### Maker-stats decision

Maker credit is an off-chain informational read model only. `GET /v1/makers/:address/stats` (public) counts `quotesRelayed`, `quotesFilled` and `quotesCancelledBeforeExpiry`. It has no effect on funds or limits and gates nothing. It is not computed on chain, because quotes that bypass the relay are invisible to it, so no wash-resistant signal exists (see [P1](P1_PROTOCOL_CONTRACTS.md)).

## Content store and suggestions

`POST /v1/content` stores raw bytes (at most 1 MiB; `application/json`, `text/plain`, `text/csv`, `text/html` or `application/pdf`) at their keccak256, through the local object store, and records them in `content.objects`. It needs `content:write` and a registered address. `GET /v1/content/:hash` is public and returns the exact bytes with the stored media type, an immutable cache, `nosniff` and `Content-Security-Policy: sandbox` (`Content-Disposition: attachment` for HTML). Bytes whose hash no longer matches are never served. Market specs are read the same way: `/v1/markets/:id/spec` returns the exact stored bytes.

The platform storage is a convenience, not a source of trust: anyone can mirror the bytes by hash.

**Archived-bytes rule (class A).** The content store provides storage. Jurors treat a proposal whose `evidenceHash` bytes cannot be fetched from any mirror as unsupported. The P3 agent docs state this rule.

Human suggestions need no identity:
- `POST /v1/suggestions` takes text of 20 to 2000 characters and up to five https `sourceUrls` (never fetched). Limits are 5 per hour per client IP and 500 per day overall.
- Status is derived at read time: `MARKET_CREATED` if a linked spec hash has a market in the index, else `CLAIMED` if a claim exists, else `OPEN`.
- `POST /v1/suggestions/:id/claims` needs `suggestion:claim` and the CREATOR role. There is one claim per creator and no exclusivity.
- A suggestion creates no on-chain right and earns no fee share.

## Signed forecasts, roots and anchoring

- `POST /v1/markets/:id/forecasts` takes `{ horizon, scheduledAt, probabilityBps, contentHash, signature }` with `forecast:write` and the FORECASTER role. The service builds the EIP-712 `Forecast` struct itself (domain `Blink Forecast` v1, chain 84532, `verifyingContract` = the manifest's `shared.anchor`), so a signature for another window, market, forecaster or deployment fails with `400 INVALID_FORECAST_SIGNATURE`. EOA, ERC-1271 and ERC-6492 signatures are accepted, and the checked block is stored as `verified_block`.
- Admission uses the database clock under the window row lock, one per forecaster per window. Nothing is stored on any refusal. An identical retry returns the stored `{ digest, leaf }`.
- The `forecast.schedule` job opens windows only for OPEN, tradable markets and closes them after their deadline. The worker then stores the window's Merkle root, once (a database trigger allows only the one-time set). A window with no standing answer gets no root.
- `forecastLeaf`, `merkleRoot` and `merkleProof` live in `packages/domain/src/forecast-merkle.ts`. `contracts/test/protocol/ForecastMerkle.t.sol` verifies every proof with OpenZeppelin `MerkleProof.verify`, and `tests/forecast-merkle.test.ts` reproduces the pinned root in TypeScript.
- **The platform never anchors and never signs.** `GET /v1/forecast-windows/:id` returns `{ root, leaves, anchor }` with `anchor` read from the index. Any agent may call `BlinkAnchor.anchor(root)`; a forecaster may anchor its own single leaf.
- **Sealing.** Before a window's deadline the answers route returns only the caller's own answer, the window route shows no root or leaves, and the proof route answers `409 WINDOW_SEALED`.
- **Withdrawal** is an annotation, allowed only before the window deadline, by the key that submitted the answer. A withdrawn answer stays listed but leaves the root, the consensus and the scores.
- **Contamination** is computed from the indexed proposal: a window is contaminated if `proposedAt <= deadline`. There is no annotation path.

### Consensus formula

At FINAL with a YES or NO outcome, `evaluation.score` writes `v2` entries: one `AGENT` entry per eligible answer and one `CONSENSUS` entry per window. `INVALID` has no Brier score and is counted separately. `LIVE` and `REPLAY` stay separate.

```
weight = n < 5 ? 0 : max(0, 0.25 - meanBrier)
```

- `n` and `meanBrier` come from the forecaster's latest 50 scored, LIVE, uncontaminated, non-missing `AGENT` entries. Only scores recorded by the window's deadline count.
- The weight is kept as an exact fraction from the exact Brier sum, never a rounded decimal. Only the final probability is rounded, half up. The forecaster routes return `weightNumerator` and `weightDenominator` in lowest terms, and `sort=weight` compares by BigInt cross-multiplication.
- With no weight at all, the plain mean is used.
- Routes: `/v1/markets/:id/consensus`, `/v1/forecasters`, `/v1/forecasters/:address`, and `/v1/metrics` (adds `consensusBrier`).

Forecaster credit, consensus and maker stats are read models. They affect no rule about funds.

## Public read model

All reads are public, paged by `after`/`limit` (at most 100) and carry the index health, except raw-bytes routes (spec, content), which carry it in `Blink-Index-*` headers on the spec route. Votes show `choice: null` until revealed.

| Area | Routes |
| --- | --- |
| Deployment and templates | `/v1/deployment`, `/v1/templates` |
| Markets | `/v1/markets?state=`, `/v1/markets/:id`, `/v1/markets/:id/spec`, `/v1/markets/:id/fees` |
| Resolution | `/v1/markets/:id/disputes`, `/v1/disputes/:id` |
| Accounts | `/v1/accounts/:address` (roles, credit decayed to the request time, juror state), `/v1/accounts/:address/positions` |
| Forecasts | `/v1/markets/:id/forecast-windows`, `/v1/markets/:id/forecasts`, `/v1/forecast-windows/:id` and `/proof`, `/v1/markets/:id/consensus`, `/v1/forecasters`, `/v1/forecasters/:address`, `/v1/metrics` |
| Relay | `/v1/makers/:address/stats` |

The index is stale when the indexed block's timestamp trails the chain head by more than `INDEX_STALE_SECONDS = 30`. Every identity-acting write then fails with `503 INDEX_STALE`, but nothing on the contracts is affected. The reference for every operation is the generated [API reference](https://blink-markets.github.io/blinkmarket/docs/api/).

## Deploy tooling (local only, nothing deployed)

- `pnpm contracts:deploy -- --params alpha|base-sepolia --treasury <address> --deployment-id <id> [--shared-from] [--previous-registry] [--deployer] [--out] [--allow-dirty] [--broadcast]` plans eight transactions (the four shared contracts, then registry, jurors, markets, resolution, each with its predicted CREATE address and nonce). The default is a dry run that needs `--deployer` and no key; the key is read only under `--broadcast`. Chain 8453 is refused (`MAINNET_REFUSED`). It writes a manifest v2 after verifying it.
- `pnpm manifest:validate`, `pnpm manifest:verify` and `pnpm deployment:register` handle manifest v2 (`parseProtocolDeployment`; the v0.1 `alpha-2` manifest answers `HISTORICAL_V1_MANIFEST`). Verification checks the ABI and runtime hashes, immutables, params, cross-links, minters and governor settings at one head block. Registration writes the immutable `markets.protocol_deployments` row.
- A new generation can reuse the shared contracts (`--shared-from`) and imports the previous registry read-only (`--previous-registry`).
- The operator tool is not a running process. No platform process holds a deployer or role key.

Tested on a local Anvil only: `tests/anvil/protocol-deploy.test.ts`. A deployment to Base Sepolia needs a decision and approval that this stage does not have.

## Platform keys cannot exist

`assertNoRoleKeys(env)` (`packages/runtime/src/index.ts`) throws `PLATFORM_ROLE_KEY_FORBIDDEN` for any variable whose name matches `/PRIVATE_KEY|MNEMONIC|KEY_FILE|SEED/i` or whose value is a bare `0x` plus 64 hex digits. The error names the variable, never the value. `apiConfig`, `workerConfig`, `indexerConfig` and `chainIndexerConfig` call it first. `pnpm deploy:preflight` applies it to the whole service env file. `tests/platform-keys.test.ts` also scans the compose files and Dockerfiles, and `scripts/images-smoke.ts` checks each started container's environment and mounts.

The local alpha (`pnpm alpha:local`) spawns the real API, indexer and worker with an explicit environment and asserts that no actor key appears in their configured or, on Linux, live (`/proc/<pid>/environ`) environment.

## ERC-8004

Not adopted in P2 (design §5.1, an implementer decision). The identity is the `BlinkRegistry` address. ERC-8004 (the identity and reputation registries of Trustless Agents) is to be evaluated in a later generation, and if adopted it must add no privileged role.

## Wallet neutrality

- An identity can be an EOA or a contract wallet that supports ERC-1271 (for example a Coinbase smart account). On-chain fills (`BlinkMarkets`, P2 Task 13) and every off-chain signature check (wallet proof, quote relay, forecasts) accept both. Off-chain checks also accept ERC-6492, except quotes (see above).
- The platform never creates, funds or custodies a wallet for an agent.
- Off-chain checks go through `SignatureVerifier` (`viemSignatureVerifier`). It reads the head block and verifies at that block, and an address with no code must give a canonical 65-byte, low-s signature. No source under `apps/` or `packages/*/src` calls `recoverMessageAddress` or `recoverTypedDataAddress` directly.
- Coinbase `awal` 2.12.1 has no contract calls and no typed-data signing, so it serves only for funding and transfers. P3 verifies CDP SDK wallets.

## Known limitations

One line each, with where it is enforced or documented. "Progress" is [P2 progress](P2_OFFCHAIN_PROGRESS.md).

Signatures and wallets
- A contract wallet's ERC-1271 answer can change after a check; the platform records the block it checked at (`verified_block` for forecasts). Progress, Task 10; P1 limitations.
- ERC-6492 wrapped signatures are accepted for wallet proofs and forecasts but refused for quotes, because `fillQuote` rejects them. Progress, Task 9.

Identity and rate limits
- A lost issue response leaves an unrevocable key that counts toward the five until it expires. Progress, Task 6.
- The hourly and daily ceilings (wallet challenges, verifications, suggestions) and the public read limit are in process, so they assume one API instance. Progress, Tasks 6 and 8.
- The legacy `admin` scope is not an `ApiScope` and nothing can issue it. The admin read routes (`/v1/admin/*`) and `pnpm ops:status` still ask for it, so they cannot be used. Progress, Task 6.

Index and read models
- `JurorState.rewardsOwed` is derived from events. A juror's own zero-value `claimRewards` or zero slash settles the contract's checkpoint without an event, so it can exceed the contract by under 1 micro per such call until the next claim; a claim always pays the contract value. Progress, Task 7.
- The journal membership audit refolds history locally on every advancing batch; its cost on a production-sized database is not measured. A `shortcut:` comment names the replacement (an independent inventory). Progress, Task 5.
- The v0.1 `markets.deployments` table is retained (migrations are append-only), beside `markets.protocol_deployments`. Progress, Task 5.
- Old `ENSEMBLE` and `BASELINE` evaluation rows stay in the append-only table and are ignored by public metrics. Progress, Task 2.

Content and suggestions
- The content store is a local object directory (`local-object:<specHash>`); an S3-compatible adapter is not implemented. `SPEC_PUBLIC_ORIGIN` is required in `markets` mode. Progress, Task 8; README.

Relay
- The relay is polling: makers poll `GET /v1/rfqs` and takers poll the quotes. Push delivery (SSE or WebSocket) is open (design §12). Progress, Task 9.
- The platform can refuse to relay (censorship), but cannot forge or modify a quote. Settlement on the contracts is unaffected.

Forecasts
- The platform's API database role can read sealed answers before the deadline. It cannot forge or alter them, because they are signed, append-only and committed by anchored roots. Sealing is a guarantee between agents, not against the platform operator. Progress, Task 10.
- Withdrawal is allowed only before the window deadline (controller ruling), so a forecaster cannot drop an answer after seeing later information. Progress, Task 10.
- A window root is anchored on chain only if an agent anchors it. Progress, Task 10.

Local alpha and tooling
- The alpha protocol windows are 60 seconds, so the scenario runs in real time (about five and a half minutes). No clock offset is used: the API and worker refuse `blink.test_clock_offset_seconds`. Progress, Task 11.
- The worker's health listener is fixed at port 3002, so the harness refuses to start when it is taken (`ALPHA_WORKER_PORT_IN_USE`). Progress, Task 11.
- The live-environment key check reads `/proc/<pid>/environ` and therefore runs on Linux only. Progress, Task 11.
- `assertNoRoleKeys` is a name and shape rule. No legitimate configuration value is a bare 32-byte hex string today, and none can be passed through the environment. Progress, Task 11.
- A deployment on chain 31337 fails, because every constructor reverts `WrongChain` off 84532, so local nodes must use chain ID 84532. Task 4 report (`.superpowers/sdd/2026-10-24-p2-offchain-protocol/task-4-report.md`).
- Verification compares code to the artifact template with differences allowed only inside 32-byte zero runs (immutables), backed by the runtime hash and cross-link reads. Task 4 report.
- The restore drill checks infrastructure rows, schema, grants and cursor lease recovery of a real `pg_dump` and restore against a quiescent database. The old trading and contract round trip was retired with the v0.1 alpha harness and has no replacement. Progress, Task 1.
- `pnpm build` and `pnpm build:pages` (Turbopack) cannot run on the development host, because they need a newer glibc than RHEL 8's 2.28. They run in CI only. The real-PostgreSQL suites do run locally, in a Docker `postgres:17.6` container, the same image as CI.

Documentation
- The web role pages (`apps/web/content/docs/`) still describe the v0.1 roles. They carry a notice and are rewritten in P3 (agent docs) and P4 (website). Until then they must not be read as current role guidance.
- The website home page (`apps/web/app/page.tsx`) still lists v0.1 pillars (a private signer, platform research); the website is a P4 item. Progress, Task 12.
- The P2 deployment runbook is not written: [Deployment runbook](DEPLOYMENT_RUNBOOK.md) is the v0.1 procedure and is marked historical.

## Verification

Measured on 2026-10-26 on the Task 12 branch, which is main `4b52d12` (the merge of Task 11) plus documentation only: the new and edited docs, the web notices (Markdown and one page's text) and one docs test. No source, contract or migration changed, so the code suites below ran on the same code as `4b52d12`. Host: Linux (RHEL 8), Node 22, PostgreSQL 17.6 in the Docker container `blink-test-pg` (the CI image), Foundry 1.7.1 through `scripts/foundry.mjs`. Counts are what each runner printed.

| Command | Result |
| --- | --- |
| `pnpm check` | 560 of 560 unit tests pass, 0 fail, 0 skipped, after the last edit (12 min 9 s); root and web typecheck, contract checks and the package-boundary check pass. A run before the new notice test was added printed 559 of 559 |
| `pnpm test:postgres` | 36 of 36 tests pass, 0 fail, 0 skipped (79 s, run serially) |
| `pnpm drill:restore:test` | 1 of 1 test pass (74 s): real `pg_dump` and restore |
| `pnpm test:anvil` | 40 of 40 tests pass, 0 fail, 0 skipped (92 s) |
| `node scripts/foundry.mjs forge test --root contracts` | 17 suites, 240 of 240 tests pass, 0 failed, 0 skipped |
| `pnpm alpha:local` | 1 of 1 test pass: the test took 322.3 s, the whole command (contract check, harness start-up, scenario, cleanup) 373 s |
| `pnpm test:images` | 12 of 12 tests pass, 0 fail, 0 skipped (154 s) |

Not run on this host: `pnpm build` and `pnpm build:pages` (Turbopack needs a newer glibc than RHEL 8's 2.28; they run in CI), `pnpm test:contracts:seeds`, `pnpm build:services` and `pnpm test:service-build`, and the browser tests. The real-PostgreSQL suites do run locally.

The forge count differs from the 255 recorded for Task 13 in [P1](P1_PROTOCOL_CONTRACTS.md) because Task 5 deleted the v0.1 contract suites (24 tests in P1's count) and later tasks added tests (for example `Anchor`, `ForecastMerkle` and the credit-clock regressions). The 240 here is the current total.

The local alpha asserts against the API and the chain: FINAL with fees equal to the `FeesDistributed` event and to their breakdown, the redeemed payout equal to `PositionRedeemed`, the anchor visible, the suggestion `MARKET_CREATED`, an index rebuild with no differences, and a key-free environment for every platform process.

Tasks 1 to 11 and 13 were each independently reviewed before merging (review records in `.superpowers/sdd/2026-10-24-p2-offchain-protocol/`). The final whole-branch review of P2 is still pending.


## Implementation rulings

| Ruling | Decision |
| --- | --- |
| Credit clock (Task 5) | `BlinkRegistry.reportLoss` returns before materialising credit when decayed credit is zero. The reducer keeps the same partial-period and 32-shift clock arithmetic as `_materialise`. Recorded in [P1](P1_PROTOCOL_CONTRACTS.md) |
| R7 | `parseMarketSpec` returns `{ ok, spec, bytes }`; callers hash the bytes, because `schemas` may not import viem |
| R8 | The v0.1 manifest schema lives in `deployment-v1.ts` until its last caller is retired |
| Withdrawal (Task 10) | Allowed only before the window deadline; the removed admin path was a platform action |
| `rewardsOwed` (Task 7) | Stays event-derived (rebuild from events is the rule); the silent self-claim gap is documented |
| Sealing (Task 10) | The API role keeps its read of open-window rows (needed for a forecaster's own answers and duplicate checks); DB-level sealing covers the worker. The operator-read limitation is documented |
| Time (Task 11) | Real time. No clock is shifted; chain waits are conditions on the chain head |
| Quotes and ERC-6492 (Task 9) | Strict parity with `BlinkMarkets.fillQuote`: wrapped signatures are refused |
