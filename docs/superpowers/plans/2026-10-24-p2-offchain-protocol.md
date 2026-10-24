# P2 Off-chain Protocol Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the off-chain monolith into pure infrastructure on top of the P1 protocol contracts. Remove every platform-operated role, then add local generation deploy tooling, a multi-contract indexer with protocol read models, self-serve wallet identity, a content store, human suggestions, an RFQ relay, and signed, anchored forecasts with credit-weighted consensus.

**Architecture:** Remove first, then build. Wave A deletes the v0.1 platform roles (signer, dispatcher, keeper, faucet and trader workers, discovery, platform forecasters, approval, creation tracking) and retires their database objects with forward migrations. That leaves the API, worker and indexer as infrastructure. Wave B fixes the data contract: the protocol ABI module, the `BlinkAnchor` contract, `Params` presets, manifest v2, the protocol read-model types and the `ProtocolReader` port with a fake. Later waves implement against those types, so parallel tasks share names without sharing code. The last wave proves infrastructure-only operation locally and documents it.

**Tech Stack:** TypeScript on Node 22 and pnpm 11. Fastify API, zod schemas, viem, PostgreSQL migrations (PGlite in unit tests), and a Next.js static web app. Solidity 0.8.30 for `BlinkAnchor`. Foundry and Anvil via `scripts/foundry.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-23-autonomous-market-design.md` (approved 2026-10-23). This plan is the P2 row of §11 and delivers §2.1 item 3 plus the read models behind item 4. It also prepares item 2, which P3 runs. The P1 contract surface and its known limits are in `docs/P1_PROTOCOL_CONTRACTS.md`.

## Global Constraints

- **No platform keys** ("The platform holds no private key for any market role", §2.1.3; Signer "Removed", §5.10):
  - No platform process (api, worker, indexer, web) reads, stores or is configured with a private key, mnemonic or key file.
  - No platform process signs or broadcasts a transaction. `scripts/deploy-contracts.ts` is an operator tool, not a running process; it keeps its explicit `--broadcast` guard.
- **No forged quotes** ("The platform may refuse to relay (censorship), but cannot forge or modify a quote", §5.5): the relay stores and returns maker-signed quote fields and signature bytes unchanged. The API never prices a quote.
- **Migrations** ("applied migrations must not be modified, only added", §6):
  - Never edit or delete a file in `packages/adapters/migrations/`.
  - New files use the numbers assigned per task below. 0021 stays absent; the runner does not require contiguous numbers.
  - Every `DROP` names its objects. Never `CASCADE`. Revoke grants before dropping roles.
  - No production database exists (the API was never deployed), so retired tables are dropped, not archived.
- **History** ("the `alpha-2` deployment record and manifest are kept as history", §6): keep `deployments/base-sepolia/alpha-2.manifest.json` byte-identical. v0.1 delivery docs only gain a one-line historical notice.
- **Off-chain credit** ("Off-chain credit: … only affects off-chain uses … does not affect any rule about funds", §5.7): forecaster credit, consensus and maker stats are read models only.
- **Human suggestions** (§5.4): "No registered identity is needed; rate limits and basic validation guard against spam"; "A suggestion by itself creates no on-chain right"; "The suggester gets no fee share".
- **REPLAY** (§5.11): "REPLAY becomes a deployment-level flag … REPLAY statistics stay permanently separate from LIVE".
- **P1 values, verbatim:**
  - `Role` CREATOR=0, MAKER=1, TAKER=2, FORECASTER=3, PROPOSER=4, CHALLENGER=5, JUROR=6
  - `QuestionClass` A_COMPUTABLE=0, B_VERIFIABLE=1, C_JUDGMENT=2
  - `MarketState` PENDING=0, OPEN=1, PROPOSED=2, DISPUTED=3, FINAL=4, CANCELLED=5
  - `Outcome` YES=0, NO=1, INVALID=2
  - `DisputeKind` CREATION=0, RESULT=1
  - `UNIT = 1_000_000`
  - RFQ EIP-712 domain `"Blink RFQ"`, `"0.2"`, chainId 84532, `verifyingContract` = the generation's `BlinkMarkets`
  - Quote type `Quote(uint256 marketId,bytes32 specHash,address maker,address taker,uint8 side,uint64 quantity,uint16 priceBps,uint64 validAfter,uint64 expiresAt,uint256 nonce,uint256 epoch)`
  - Taker pays `takerCost + floor(takerCost × feeBps / 10000)`
- **Access:** reads are public. A write that acts for an identity needs an API key issued by wallet proof, plus the matching role in the indexed current generation, checked at request time.
- **Wallets** (§5.1 Wallet neutrality, approved 2026-10-24):
  - "An identity can be an EOA, or a contract wallet that supports ERC-1271". On-chain fills and every off-chain signature check (wallet proof, quote relay, forecasts) accept both, and off-chain checks also accept ERC-6492.
  - "The platform does not create, fund or custody wallets for agents".
  - Off-chain checks go through the Task 3 `SignatureVerifier`. No source under `apps/` or `packages/*/src` calls `recoverMessageAddress` or `recoverTypedDataAddress` directly; test fakes may.
- **Index freshness:** the index is stale when the indexed block's timestamp trails the chain head by more than `INDEX_STALE_SECONDS = 30`. Every identity-acting write then fails with `503 INDEX_STALE`.
- **Boundaries and build:**
  - The package boundaries in `scripts/check-boundaries.mjs` hold, and shared package exports name real `.ts` files.
  - When `schemas`, `domain` or `client` changes, also run `pnpm build` (AGENTS.md).
  - When `apps/*` or `scripts/build-services.mjs` changes, also run `pnpm test:service-build`.
- **No deployment:** no paid service, no real-key signing, no broadcast to a public network (U1, AGENTS.md). Use Anvil only.
- **Verification gates:**
  - Each task updates the `tests/postgres` and `tests/anvil` suites its change touches.
  - This host has no PostgreSQL, so real-PostgreSQL suites run in CI on push; a red CI run on `main` blocks the next wave. `tests/anvil` suites run locally.
- **Commits:** authored by the repo-local Brian Huang identity, ending with the Claude or Codex trailer; push after each merged task (AGENTS.md).

## Review Focus

1. **A reorg removes a registration, role join or fill.** The projections roll back, and the API stops treating that address as registered or role-holding. Pinned by Task 5 `test_reorgRevokesRegistrationEligibility`.
2. **The taker approves too little because the fee is forgotten.** SDK verification and the approval amount include the fee. Pinned by Task 9 `verifySignedQuote requires fee-inclusive maxCost`.
3. **The indexer lags.** Key issuance, RFQ requests and quote posts fail closed with `INDEX_STALE`. Pinned by Task 6 `issue refuses when index is stale` and Task 9 `relay refuses when index is stale`.
4. **A market is created but stays PENDING or is CANCELLED.** It never gets forecast windows or RFQs; only OPEN markets before `closeAt` do. Pinned by Task 5 `status of PENDING and CANCELLED markets is not tradable`, Task 9 `rfq refuses non-OPEN market` and Task 10 `scheduler skips PENDING and CANCELLED`.
5. **A forecast is replayed or forged.** A signature for another forecaster, market or window, or one received after the deadline, is rejected, and sealed answers stay hidden until the deadline. Pinned by Task 10 `rejects forecast signed for another window` and `sealed until deadline`.

---

## Waves and ownership

| Wave | Tasks | Notes |
| --- | --- | --- |
| A | T1 → T2, with T13 in parallel | T1 and T2 are sequential: both unwire `apps/api`, `apps/worker` and the package barrels. T13 touches only `contracts/` and the P1 doc. |
| B | T3 | The data contract every later task imports. Starts after T13 merges, because its ABI and Anvil tests read the contract build output. |
| C | T4 ∥ T6 | Deploy tooling and identity share no files. |
| D | T5 ∥ T8 | The indexer and the content store. Both append to `apps/api/src/routes.ts` and `packages/schemas/src/http.ts`; the controller resolves those append conflicts. |
| E | T7 ∥ T9 | Resolution read models and the RFQ relay. Same append rule. |
| F | T10 | Forecasts. Needs anchors (T5), proposals (T7) and content (T8). |
| G | T11 → T12 | Integration, then docs. |

Migration numbers are fixed per task so that parallel tasks never collide: T1 `0025`, T2 `0026`, T4 `0027`, T6 `0028`, T5 `0029`, T8 `0030`, T7 `0031`, T9 `0032`, T10 `0033`; T13 needs none. A task that ends up needing no migration leaves its number unused.

## File Structure

| Area | Files | Responsibility |
| --- | --- | --- |
| Protocol data contract | `packages/adapters/src/protocol-abi.ts`; `packages/schemas/src/{protocol.ts,protocol-params.ts,market-spec.ts,deployment.ts}`; `packages/ports/src/protocol-read.ts`; `tests/helpers/protocol-reader.ts` | ABI per contract, read-model types, Params presets, MarketSpec v0.2, manifest v2, the reader port and its in-memory fake |
| Anchor contract | `contracts/src/protocol/BlinkAnchor.sol`; `contracts/test/protocol/Anchor.t.sol` | Permissionless first-seen timestamp for a 32-byte root |
| Contract wallets | `contracts/src/protocol/BlinkMarkets.sol`; `contracts/test/protocol/{MockErc1271Wallet.sol,ContractWalletMaker.t.sol}` | ERC-1271 maker signatures on chain |
| Signature checks | `packages/ports/src/signature.ts`; `packages/adapters/src/signature-verifier.ts`; `tests/helpers/signature-verifier.ts` | One EOA, ERC-1271 and ERC-6492 check shared by identity, relay and forecasts |
| Deploy | `packages/adapters/src/{protocol-deployer.ts,deployment-verifier.ts,deployment-registry.ts}`; `scripts/{deploy-contracts,verify-deployment,validate-manifest,register-deployment}.ts` | Plan and deploy shared contracts plus a generation; write, verify and register manifest v2 |
| Indexer | `packages/adapters/src/{protocol-log-reader.ts,protocol-index-store.ts}`; `packages/domain/src/protocol-reducer.ts`; `packages/application/src/chain-indexer.ts`; `apps/indexer/src/*` | Multi-contract canonical ingestion, reorg handling, projections, the `ProtocolReader` implementation |
| Identity | `packages/application/src/identity.ts`; `packages/adapters/src/{identity-store,identity-crypto}.ts`; `packages/schemas/src/identity.ts` | Public wallet challenge, key issuance and revocation |
| Content and suggestions | `packages/application/src/{content.ts,suggestions.ts}`; `packages/adapters/src/{content-store.ts,suggestion-store.ts}` | Hash-addressed uploads and the public suggestion queue |
| Resolution reads | `packages/domain/src/protocol-reducer.ts` (extended); `packages/application/src/market-read.ts` | Proposals, disputes, rounds, votes, juror stake, credit and fee read models; the public read routes |
| RFQ relay | `packages/application/src/rfq-relay.ts`; `packages/adapters/src/rfq-store.ts`; `packages/client/src/*`; `examples/agent/*` | RFQ forwarding, quote validation, maker stats, tx tracking, the SDK and the taker example |
| Forecasts | `packages/application/src/{forecasts.ts,evaluation.ts}`; `packages/domain/src/{forecast-merkle.ts,consensus.ts}`; `packages/adapters/src/{forecast-store.ts,evaluation-store.ts}` | Signed submissions, window Merkle roots, automatic contamination, Brier, consensus |
| Integration | `scripts/local-alpha.ts`; `tests/alpha/*`; `scripts/deploy-preflight.ts`; `infra/*`; `.github/workflows/ci.yml` | Infrastructure-only local alpha, platform-key absence checks, images and CI |
| Docs | `docs/P2_OFFCHAIN_PROTOCOL.md`; `docs/ROADMAP.md`; `CONTEXT.md`; README files; current docs | Delivery record and current guidance |

### Shared types (Task 3 creates them; later tasks import, never redefine)

`packages/schemas/src/protocol.ts` (zod plus inferred types). Times are unix seconds as `number`; uint256 values are decimal `string`; addresses are lowercase `0x` hex.

```ts
export const RoleName = z.enum(["CREATOR","MAKER","TAKER","FORECASTER","PROPOSER","CHALLENGER","JUROR"]); // index = P1 enum value
export const MarketStateName = z.enum(["PENDING","OPEN","PROPOSED","DISPUTED","FINAL","CANCELLED"]);
export const OutcomeName = z.enum(["YES","NO","INVALID"]);
export const ClassName = z.enum(["A","B","C"]);
export const IndexHealth = z.object({ headBlock: z.number(), indexedBlock: z.number(), lagSeconds: z.number(), stale: z.boolean() });
export const ProtocolAccount = z.object({ address: Address, registered: z.boolean(),
  roles: z.record(RoleName, z.object({ stakeMicros: Uint, active: z.boolean(), exitRequestedAt: z.number().nullable(), openObligations: z.number() })),
  credit: z.record(RoleName, z.object({ value: z.number(), updatedAt: z.number() })) }); // stored value; decay applied by creditAt()
export const ProtocolMarket = z.object({ marketId: Uint, creator: Address, class: ClassName, state: MarketStateName,
  templateId: Hash, specHash: Hash, specUri: z.string(), replay: z.boolean(), openAt: z.number(), closeAt: z.number(),
  proposalDeadline: z.number(), hardDeadline: z.number(), maxPairs: Uint, mintedPairs: Uint, escrowMicros: Uint,
  feePoolMicros: Uint, finalOutcome: OutcomeName.nullable(), feesDistributed: z.boolean(), creationChallenged: z.boolean() });
export const MakerState = z.object({ address: Address, freeMicros: Uint, epoch: Uint });
export const DigestStatus = z.enum(["UNUSED","CONSUMED","CANCELLED"]);
export const Anchor = z.object({ root: Hash, by: Address, anchoredAt: z.number() });
// Task 7 appends: ProtocolProposal, ProtocolDispute, ProtocolRound, ProtocolVote, JurorState, FeeBreakdown
```

`packages/ports/src/protocol-read.ts`:

```ts
export interface ProtocolReader {
  health(): Promise<IndexHealth>;
  account(address: Address): Promise<ProtocolAccount | null>;
  hasRole(address: Address, role: RoleName): Promise<boolean>; // mirrors BlinkRegistry.hasRole exactly
  creditAt(address: Address, role: RoleName, at: number): Promise<number>; // mirrors BlinkRegistry.creditOf decay exactly
  market(id: string): Promise<ProtocolMarket | null>;
  marketBySpecHash(specHash: Hash): Promise<ProtocolMarket | null>;
  markets(q: { states?: MarketStateName[]; after?: string; limit: number }): Promise<{ items: ProtocolMarket[]; next: string | null }>;
  maker(address: Address): Promise<MakerState>;
  digest(digest: Hash): Promise<DigestStatus>;
  anchor(root: Hash): Promise<Anchor | null>;
  // Task 7 appends: proposal(marketId), disputes(marketId), dispute(id), rounds(disputeId), votes(disputeId, round), juror(address), fees(marketId)
}
```

`tests/helpers/protocol-reader.ts` exports `fakeProtocolReader(state: Partial<FakeProtocolState>): ProtocolReader & { set(...) }`, which is in memory and has a settable `health`. Tests in T6, T8, T9 and T10 use it before the real store exists.

`packages/ports/src/signature.ts`:

```ts
export type SignatureCheck = { valid: boolean; blockNumber: bigint }; // the block the check ran at
export interface SignatureVerifier {
  verifyMessage(input: { address: Address; message: string; signature: Hex }): Promise<SignatureCheck>;
  verifyTypedData(input: { address: Address; typedData: TypedDataDefinition; signature: Hex }): Promise<SignatureCheck>;
}
export class SignatureCheckUnavailable extends Error {} // RPC failure; callers answer 503 SIGNATURE_CHECK_UNAVAILABLE
```

`tests/helpers/signature-verifier.ts` exports `fakeSignatureVerifier(opts?: { contractWallets?: Record<Address, Address> }): SignatureVerifier & { setUnavailable(on: boolean): void }`.
- For an EOA, it recovers locally.
- For a listed contract wallet, it accepts that wallet's owner's signature.
- With `setUnavailable(true)`, it throws `SignatureCheckUnavailable`.

---

### Task 1: Retire the platform signing and execution stack

Removes everything that signs, sends or prices on the platform's behalf. Spec §5.10, §6 "Signer and dispatcher", "Single-maker pricing", "Platform agents" (keeper, faucet, trader).

**Files:**
- Delete:
  - `apps/signer/**` and `infra/Dockerfile.signer`
  - `packages/application/src/{signer,tx-dispatcher,keeper,execution,faucet,trader,quote-reconcile,rfq}.ts`
  - `packages/domain/src/{signing-policy,keeper,trader-rule,pricing}.ts`
  - `packages/ports/src/{execution,trader,trading}.ts`
  - `packages/adapters/src/{signer-client,signing-store,signing-rpc,signing-calldata,key-file,gas-oracle,keeper-store,execution-chain-reader,faucet-store,trader-store,trading-admin,trading-store}.ts`
  - `apps/worker/src/{execution,trader}.ts`, `apps/api/src/trading.ts`, `scripts/trading-admin.ts`
  - `scripts/local-alpha.ts` and `tests/alpha/local-alpha.test.ts` (Task 11 rewrites them)
  - their tests:
    - `tests/{signer,signer-config,signer-server,signing-policy,tx-dispatcher,keeper,keeper-decisions,execution-config,worker-execution-clock,faucet,faucet-worker,trader,trader-rule,pricing,quote-reconcile,trading-ops,rfq}.test.ts`
    - `tests/postgres/{signing,signer-process,trader,faucet,rfq}.test.ts`
    - `tests/anvil/{signer-dispatch,trader,rfq,keeper-faucet}.test.ts`
    - `tests/helpers/{signer-fixture,faucet,trader,trading}.ts`
- Move: the transaction-observation types (`TrackedTransaction`, `TxReceiptReader` and the related types `tx-tracking.ts` imports) from `packages/ports/src/signing.ts` to a new `packages/ports/src/tx-tracking.ts`. Then delete `signing.ts`. `packages/domain/src/execution.ts` keeps only the finality types that tracking uses.
- Modify:
  - Unwire every deleted module: `packages/*/src/index.ts`, `apps/api/src/{main,server,config,routes}.ts`, `apps/worker/src/{main,config,registry,handlers}.ts`, `packages/schemas/src/http.ts` (drop `POST /v1/faucet/claims`, `POST /v1/rfqs`, `GET /v1/quotes/:quoteId`)
  - Drop the `trading` API mode, and drop the worker and API `SIGNER_*` / `WORKER_*_KEY` config keys listed in `.env.example`
  - `packages/application/src/{health,alert-evaluate,operator-status}.ts` with their adapters `health-reader`, `alert-evaluate-store` and `operator-status-store` (drop signer, maker-pool, keeper and gas prerequisites)
  - `scripts/{build-services.mjs,deploy-preflight.ts,restore-prepare.ts,restore-drill.ts,images-smoke.ts}`
  - `infra/compose.alpha.yaml` (drop the signer service, key volumes and key env), `package.json` (drop `trading:admin` and `alpha:local`), `.github/workflows/ci.yml` (drop the alpha:local step)
  - tests that only lose signer cases: `tests/{service-build,images}.test.mjs`, `tests/{api-config,api-route-services,worker-runtime,health,alert-evaluate,operator-status,ops-status,job-registry}.test.ts`
- Create: `packages/adapters/migrations/0025_retire_platform_execution.sql`.

**Interfaces:**
- Produces:
  - `packages/ports/src/tx-tracking.ts`, exporting the moved types under unchanged names
  - a worker whose job registry holds only outbox, retention, alerts and the research/forecast jobs Task 2 still owns
  - no `apps/signer`
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/architecture.test.ts`, add `platform has no signer workspace`: `apps/signer` does not exist; no `package.json` in `apps/*` or `packages/*` names `@blink/signer`; and no file under `apps/` or `packages/*/src` imports a deleted module path (scan the import specifiers for `signer`, `signing-`, `tx-dispatcher`, `keeper`, `faucet`, `trader`, `quote-reconcile`, `trading-store`).
  - In `tests/database.test.ts`, add `0025 retires platform execution objects`: after migrating PGlite there are no tables in schemas `signing` or `faucet`; none of `trading.{quotes,maker_pools,quote_gates,collateral_reservations,reservation_events,mandates,risk_reservations}` exist; and roles `blink_signer` and `blink_trading_admin` do not exist.
- [ ] **Step 2: Run** `node --import tsx --test tests/architecture.test.ts tests/database.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Move the types first, then delete.
  - Write `0025` in FK order:
    1. revoke the grants
    2. drop the triggers and functions: `signing.restrict_api_intents`, `signing.restrict_sign_requests`, `signing.observe_inclusion`, `trading.guard_risk_reservation`, and the append-only triggers on the dropped tables
    3. drop the indexes from 0022 (`sign_requests_rejected_recent`) and 0024 (`jobs_active_intent`, `jobs_active_claim`)
    4. drop the tables, child before parent
    5. drop the schemas `signing` and `faucet`, and drop `trading` only if it is empty
    6. drop the roles
  - Retire leftover queued `tx.dispatch`, `keeper.*`, `faucet.*` and `trader.*` jobs with `UPDATE operations.jobs SET state='DEAD', last_error='RETIRED_P2'` where the type is in that list. The worker must not lease them.
- [ ] **Step 4: Run** `pnpm check && pnpm build:services && pnpm test:service-build`. Expected: PASS, and the bundles list no signer.
- [ ] **Step 5: Commit** `refactor: retire the platform signer, dispatcher, keeper, faucet, trader and quote service`.

### Task 2: Retire platform research, manual creation and invitations

Spec §6 "Market approval flow", "Platform agents" (discovery, platform-forecaster, baseline), "Invite-only identity" (operator management).

**Files:**
- Delete:
  - `packages/application/src/{discovery,platform-forecaster,budgeted-model,approval,approval-preflight,creation-tracker,creation-poller,evidence-fetch}.ts`
  - `packages/domain/src/{approval,costs,prompts}.ts`
  - `packages/ports/src/{approval,creation-tracker,budgets,evidence-fetch}.ts`. Keep `FetchError`, `checkFetchUrl` and `isPublicAddress` by re-exporting them from `packages/domain/src/network-policy.ts`.
  - `packages/adapters/src/{approval-store,creation-tracker-store,creation-tracking-schedule,creation-receipt-reader,creation-calldata,discovery-store,platform-run-store,budget-ledger,fixture-model-gateway,model-fixtures,identity-admin,resolution-draft,evidence-fetch-store}.ts`
  - `packages/schemas/src/{creation-status,preparation}.ts`
  - `scripts/{identity-admin,reconcile-creation,resolution-draft,local-replay}.ts` and `fixtures/replay/models/**`. `local-replay.ts` imports the deleted creation reader, so it goes here, not in Task 5.
  - the matching tests:
    - `tests/{approval-policy,creation-receipt,creation-poller,discovery,platform-forecaster,budgeted-model,budget-ledger,model-fixtures,preparation,evidence-fetch}.test.ts`
    - `tests/postgres/research-workers.test.ts`
    - `tests/helpers/{creation-rpc,research}.ts`
- Keep: `packages/adapters/src/allowlist-fetcher.ts`, `packages/domain/src/network-policy.ts` and their tests (spec §7). They are unused by the platform until P3 reuses them.
- Modify:
  - `packages/application/src/{forecasts,evaluation,resolution,operator-status}.ts`; delete `packages/application/src/preparation.ts`. Forecasts keep agent submissions and windows. Evaluation drops ENSEMBLE and BASELINE and keeps per-submission Brier. Resolution drops report triage, suggestions and alerts; it keeps nothing route-facing, because Task 7 owns resolution reads.
  - `apps/worker/src/{research,main,config,handlers,registry}.ts`. The worker keeps the forecast window scheduler, evaluation, outbox, retention and alerts.
  - `apps/indexer/src/{main,config}.ts` (drop the creation poller and its `INDEXER_*` poll keys)
  - `apps/api/src/{main,server,config,routes}.ts` and `packages/schemas/src/http.ts`. Drop the `/v1/admin/*` candidate, budget, resolution and creation-intent routes; `/v1/candidates*`; and `/v1/markets/:id/resolution-reports`. Drop the `preparation` and `approval` modes.
  - `packages/domain/src/{index,modules}.ts` and the `packages/domain/src/*/README.md` of removed modules
  - `package.json` (drop `identity:admin`, `creation:reconcile`, `resolution:draft`, `replay`), `.github/workflows/ci.yml` (drop the `pnpm replay` step) and the `scripts/build-services.mjs` tool list
- Create: `packages/adapters/migrations/0026_retire_platform_research.sql`.

**Interfaces:**
- Produces: forecast submission and window services keyed by agent, with no snapshots and no platform agents; an API with modes `scaffold`, `identity` and `markets`.
- Consumes: the Task 1 state.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/architecture.test.ts`, add `platform runs no research or approval roles`. No source file under `apps/` or `packages/*/src` names `FORECASTER_A`, `FORECASTER_B`, `BASELINE`, `discovery`, `approval` or `creation-poller`. The worker job registry contains no type starting with `discovery.`, `research.forecast`, `candidate.` or `market.deploy`.
  - In `tests/database.test.ts`, add `0026 retires research and approval objects`. These no longer exist:
    - the `discovery` and `budgets` schemas
    - `markets.{approvals,creation_intents,active_slots}`
    - `chain.{creation_projections,creation_observations,creation_tracking_schedule}`
    - `forecasts.{platform_agents,snapshots,model_runs,pending_answers}`
    - `resolution.{report_events,suggestions,alerts_sent,reports}`
    - `evidence.fetch_attempts`
- [ ] **Step 2: Run** the same two test files. Expected: FAIL.
- [ ] **Step 3: Implement** in the order of the inventory's removal dependencies:
  1. unwire the routes, jobs and barrels
  2. delete the modules
  3. write `0026`, dropping child before parent, with the deferred candidate↔revision FK dropped first
  - In 0026, mark retired job types `DEAD` the same way 0025 does.
- [ ] **Step 4: Run** `pnpm check && pnpm build:services && pnpm test:service-build`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: retire platform discovery, forecasters, baseline, approval and creation tracking`.

### Task 13: Contract-wallet maker signatures in BlinkMarkets

Spec §5.1 Wallet neutrality. This amends a P1 contract. Generation 1 is not deployed yet, so the change is free now; after deployment it would need a new generation. It runs in parallel with Tasks 1 and 2, which share no files with it, and Task 3 starts after it merges.

**Files:**
- Modify:
  - `contracts/src/protocol/BlinkMarkets.sol`: only the signature check in `fillQuote`
  - `docs/P1_PROTOCOL_CONTRACTS.md`: the fill rules, `## Known limitations` and `## Implementation rulings`, which gets a row citing §5.1 Wallet neutrality
- Create: `contracts/test/protocol/MockErc1271Wallet.sol`, `contracts/test/protocol/ContractWalletMaker.t.sol`.

**Interfaces:**
- Produces:
  - **The new check.** `fillQuote` accepts the maker signature when `SignatureChecker.isValidSignatureNowCalldata(q.maker, digest, signature)` is true (OpenZeppelin 5.6.1); otherwise it reverts `InvalidSignature()` as before.
    - A maker without code keeps the exact ECDSA rules: 65 bytes, low-s.
    - A maker with code is asked through ERC-1271 `isValidSignature(digest, signature)` by staticcall.
    - Nothing else changes: no other check, event, error, ABI item or storage layout. Replay protection stays keyed by digest.
  - **`MockErc1271Wallet(address owner)`:**
    - `isValidSignature(bytes32 hash, bytes signature) returns (bytes4)` returns `0x1626ba7e` when `ECDSA.recover(hash, signature) == owner`, else `0xffffffff`.
    - `setMode(uint8)` is owner-only and switches it to returning `0xffffffff` (mode 1) or reverting (mode 2).
    - `execute(address target, uint256 value, bytes data) returns (bytes)` is owner-only, so the wallet can act like an agent: claim from the faucet, register, join MAKER, approve, deposit, cancel and bump its epoch.
    - Task 3's Anvil test and Task 11's harness deploy it from the Foundry build output.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests** in `ContractWalletMaker.t.sol`, on `ProtocolBase`:
  - `test_contractWalletMakerQuoteFills`: the wallet claims, registers, joins MAKER and deposits through `execute`. Its owner signs the quote digest, and a taker fills. Positions, `makerFree`, the fee pool and the `QuoteFilled` args equal the EOA-maker case with the same quote.
  - `test_contractWalletWrongSignerReverts`: a signature from another key reverts `InvalidSignature`.
  - `test_contractWalletRejectingReverts` (mode 1) and `test_contractWalletRevertingReverts` (mode 2): both revert `InvalidSignature`.
  - `test_contractWalletCancelAndEpoch`: the wallet cancels one quote and bumps its epoch through `execute`. Filling those quotes reverts `QuoteAlreadyCancelled` and `EpochMismatch` respectively.
  - `test_eoaHighSStillRejected`: the s-flipped form of a valid EOA signature reverts `InvalidSignature`.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-contract ContractWalletMaker`. Expected: FAIL, because the wallet maker's fill reverts `InvalidSignature`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check:contracts && pnpm test:contracts && pnpm test:contracts:seeds && node --import tsx --test tests/protocol-artifacts.test.ts`. Expected: PASS, with all existing contract tests unchanged.
- [ ] **Step 5: Commit** `feat(contracts): accept ERC-1271 maker signatures in fillQuote`.

### Task 3: Protocol data contract

Fixes every shared name later tasks use. Spec §5.0 (presets), §5.10 (anchor), §5.11, §7 (EIP-712 quote kept).

**Files:**
- Create:
  - `contracts/src/protocol/BlinkAnchor.sol` and `contracts/test/protocol/Anchor.t.sol`
  - `packages/adapters/src/protocol-abi.ts` and `tests/protocol-abi.test.ts`
  - `packages/schemas/src/{protocol,protocol-params,market-spec}.ts`
  - `packages/ports/src/protocol-read.ts`, `tests/helpers/protocol-reader.ts`
  - `packages/ports/src/signature.ts`, `packages/adapters/src/signature-verifier.ts`, `tests/helpers/signature-verifier.ts`, `tests/anvil/signature-verifier.test.ts`
  - `tests/{protocol-params,market-spec,deployment-manifest}.test.ts`
- Modify:
  - Rewrite `packages/schemas/src/deployment.ts` as manifest v2, and remove the v1 schema.
  - Export the new modules from the package barrels. Do not export `protocol-abi.ts` to `client` or `web`.

**Interfaces:**
- Produces:
  - **`BlinkAnchor`:** no constructor args. Chain id 84532, else `WrongChain()`.
    - `function anchor(bytes32 root) external`: reverts `ZeroRoot()` for 0 and `AlreadyAnchored()` if seen. Otherwise sets `anchoredAt[root] = uint64(block.timestamp)` and emits `Anchored(bytes32 indexed root, address indexed by, uint64 at)`.
    - `mapping(bytes32 => uint64) public anchoredAt`.
  - **`protocolAbi`:** `{ registry, jurors, markets, resolution, faucet, token, governor, anchor, priceSource }`, each a viem `Abi` built with `parseAbi`. It holds every event, agent write, view and custom error from the inventory list in `docs/P1_PROTOCOL_CONTRACTS.md`. The token ABI covers ERC20 + `delegate`/`getVotes`. The governor ABI covers `propose`, `castVote`, `execute`, `state`, `successor`, `pendingSuccessor`, `successorEffectiveAt` and `SuccessorAdopted`.
  - **`ProtocolParams`** (zod, every `Params` field in declaration order; uint256 as string) and two presets:
    - `presets.baseSepolia`: `ProtocolBase.defaultParams()` exactly, but with `replayAllowed: false`.
    - `presets.alpha`: `baseSepolia` with only these changes:
      - `roleExitCooldown: 60`, `jurorUnstakeCooldown: 120`
      - `creationWindow: [60,60,60]`, `firstUseExtraWindow: 30`
      - `resultChallengeWindow: [60,60,60]`, `minResultChallengeWindow: [30,30,30]`, `challengeWindowStepSeconds: 1`
      - `commitSeconds: 30`, `revealSeconds: 30`, `appealSeconds: 30`
      - `replayAllowed: true`
  - **Governance and price defaults:**
    - `governorDefaults = { votingDelay: 86400, votingPeriod: 259200, proposalThreshold: "10000000000000000000", quorumFraction: 4, adoptionDelay: 172800 }`
    - `TEST_TOKEN_PRICE_MICROS = 1_000_000`
  - **`MarketSpecV02`** (zod):
    - required: `schema: "blink.market-spec/0.2"`, `title` (1–200 chars), `question` (1–2000), `class: "A"|"B"|"C"`, `resolution: { yes: string(1–2000), no: string(1–2000), invalid?: string(≤2000) }`, `sources: https URL[] (≤10)`
    - optional: `computation: { templateId: Hash, parserHash: Hash, extraction: string(≤2000) }` (required when class is A), `suggestionId: uuid`
    - `parseMarketSpec(bytes: Uint8Array): { ok: true, spec } | { ok: false, reason }`. It never re-serializes.
  - **`ProtocolDeployment`** (manifest v2):
    - `schema: "blink.deployment/2"`, `deploymentId`, `chainId: 84532`, `deployer`, `treasury`
    - `shared: { faucet, busd, token, priceSource, governor, anchor }`
    - `generation: { index: number, registry, jurors, markets, resolution, previousRegistry: Address | null }`
    - `params: ProtocolParams`, `governor: typeof governorDefaults`, `tokenPriceMicros`
    - `contracts: Record<name, { address, abiHash, runtimeHash, deployTx, block }>`
    - `startBlock: number`, `releaseCommit: string`
  - The shared types and the `ProtocolReader` port above, and `fakeProtocolReader`.
  - The `SignatureVerifier` port above, `fakeSignatureVerifier`, and `viemSignatureVerifier(publicClient): SignatureVerifier`.
    - It reads the latest block number, then calls viem `publicClient.verifyMessage` / `verifyTypedData` at that block, which covers EOA, ERC-1271 and ERC-6492.
    - It returns `{ valid, blockNumber }`.
    - For an address without code, it also requires a 65-byte, low-s signature with v ∈ {27,28}, matching OpenZeppelin `ECDSA.tryRecover`, so off-chain and on-chain answers agree.
    - An RPC error becomes `SignatureCheckUnavailable`.

- [ ] **Step 1: Write the failing tests.**
  - `Anchor.t.sol`: `test_anchorRecordsFirstTime` (timestamp and event), `test_reanchorReverts`, `test_zeroRootReverts`, `test_wrongChainReverts`.
  - `tests/protocol-abi.test.ts`: for every contract, each `protocolAbi` event, function and error matches the compiled `contracts/artifacts/<Name>.json` item by signature (name, input types, indexed flags, outputs). Every event the artifact declares under `contracts/src/protocol` is present.
  - `tests/protocol-params.test.ts`:
    - `baseSepolia equals ProtocolBase defaults except replayAllowed`: values copied from `ProtocolBase.defaultParams()`, compared field by field.
    - `alpha differs from baseSepolia only in time fields and replayAllowed`: the key set of the diff equals the list above, so thresholds stay identical (§2.1.2).
    - `alpha satisfies the R39 arbitration budget`: `hardDeadline − proposalDeadline > resultChallengeWindow + maxRounds × (commit+reveal+appeal)` holds for some deadline gap ≤ 600 s.
  - `tests/market-spec.test.ts`: a valid B spec parses; a class A spec without `computation` fails; bytes with a BOM or invalid UTF-8 fail; `suggestionId` round-trips; the parse result keeps the input bytes' keccak256.
  - `tests/deployment-manifest.test.ts`: a v2 fixture parses; the `alpha-2.manifest.json` file fails with reason `HISTORICAL_V1_MANIFEST`; duplicate addresses across slots fail.
  - `tests/anvil/signature-verifier.test.ts`, on Anvil with Task 13's `MockErc1271Wallet` deployed:
    - `EOA personal_sign and typed data valid`
    - `EOA high-s signature rejected`
    - `ERC-1271 wallet accepts its owner's typed data`
    - `ERC-1271 wallet rejects another key`
    - `ERC-6492 signature for an undeployed account valid`, using viem's 6492 test wrapping around a factory deploy of the mock
    - `RPC failure throws SignatureCheckUnavailable`
- [ ] **Step 2: Run** `pnpm check:contracts && pnpm test:contracts && node --import tsx --test tests/protocol-abi.test.ts tests/protocol-params.test.ts tests/market-spec.test.ts tests/deployment-manifest.test.ts tests/anvil/signature-verifier.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files. Callers of the v1 `requireDeployment` stay compiled against a v1-only local alias inside `market-read` until Tasks 5 and 7 replace them. Do not delete `packages/schemas/src/core.ts` v0.1 types yet.
- [ ] **Step 4: Run** the step 2 command, `node --import tsx --test tests/protocol-artifacts.test.ts` (the privileged-name scan now includes `BlinkAnchor`), and `pnpm check && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fix the P2 protocol data contract: ABI, anchor, params presets, MarketSpec 0.2, manifest v2, reader port`.

### Task 4: Generation deploy tooling (local only)

Spec §5.1 Generation, §5.9. This task never broadcasts to a public network.

**Files:**
- Create: `packages/adapters/src/protocol-deployer.ts`, `packages/adapters/migrations/0027_protocol_deployments.sql`, `tests/anvil/protocol-deploy.test.ts`.
- Delete: `packages/adapters/src/contract-deployer.ts`, `tests/anvil/deploy-contracts.test.ts`.
- Modify:
  - `packages/adapters/src/{deployment-verifier,deployment-registry}.ts`
  - `scripts/{deploy-contracts,verify-deployment,validate-manifest,register-deployment}.ts`
  - `deployments/base-sepolia/{manifest.template.json,env.example}` (rewritten to v2)
  - `tests/{deployment,deployment-record}.test.ts`

**Interfaces:**
- Consumes: Task 3 `ProtocolParams`, `presets`, `governorDefaults`, `ProtocolDeployment` and `protocolAbi`, plus the artifacts from `pnpm check:contracts`.
- Produces:
  - `planProtocolDeployment(input: { deployer: Address; nonce: number; params: ProtocolParams; treasury: Address; previousRegistry?: Address; shared?: ProtocolDeployment["shared"] }): DeploymentPlan`. Pure. It lists each transaction with its predicted address and a constructor-args hash.
  - `deployProtocol(wallet, publicClient, plan): Promise<ProtocolDeployment>`
    - Without `shared`, it deploys `BlinkFaucet`, `FixedPriceSource(TEST_TOKEN_PRICE_MICROS)`, `BlinkGovernor(token, …governorDefaults)` and `BlinkAnchor`, in that order.
    - It then re-reads the nonce, predicts four CREATE addresses and deploys `BlinkRegistry(params, a)`, `BlinkJurors(a)`, `BlinkMarkets(a)` and `BlinkResolution(a)`.
    - If the nonce moved since prediction, it aborts with `NONCE_DRIFT` before the first generation transaction. It sends no retries. A partial failure reports the addresses already deployed.
  - `verifyProtocolDeployment(publicClient, manifest): Promise<VerificationReport>`. It checks code hashes against the artifacts, `registry.params()` equality, `addresses()` cross-links on all four contracts, faucet `busd()`/`token()` and the token minters, the governor token, and the anchor code.
  - `registerProtocolDeployment(db, manifest, report)` and `loadProtocolDeployment(db, deploymentId): Promise<ProtocolDeployment>`. Table `markets.protocol_deployments(deployment_id PK, manifest jsonb, verified_at)` comes from migration 0027, with SELECT granted to `blink_api`, `blink_worker` and `blink_indexer`.
  - The CLI: `pnpm contracts:deploy -- --params alpha|base-sepolia --treasury <addr> --deployment-id <id> [--shared-from <manifest>] [--previous-registry <addr>] [--out <path>] [--broadcast]`.
    - The default is a dry run without a key, which prints the plan.
    - `--broadcast` reads `DEPLOYER_PRIVATE_KEY`, refuses any chain id other than 31337 (Anvil) or 84532, and refuses an existing `--out`.

- [ ] **Step 1: Write the failing tests** in `tests/anvil/protocol-deploy.test.ts`. Use a fresh Anvil started at chain id 84532 and the Anvil test key.
  - `dry run plans without a key`
  - `deploys shared contracts and generation 1 with alpha params`: verification is clean, `registry.params()` equals `presets.alpha`, `nonce drift` aborts.
  - `deploys generation 2 reusing shared contracts`: `previousRegistry` equals gen 1's registry, the shared addresses are unchanged, and the gen 2 manifest has `generation.index 2`.
  - `register and load round-trip`
- [ ] **Step 2: Run** `pnpm check:contracts && node --import tsx --test tests/anvil/protocol-deploy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: plan, deploy, verify and register a protocol generation locally`.

### Task 5: Multi-contract protocol indexer, part 1: identity, markets and trading

Spec §5.10 Indexer, §7 (reorg, canonical cursor). Replaces the v0.1 single-contract indexer and deletes the v0.1 market contract.

**Files:**
- Create:
  - `packages/adapters/src/{protocol-log-reader,protocol-index-store}.ts`
  - `packages/domain/src/protocol-reducer.ts`
  - `packages/adapters/migrations/0029_protocol_index.sql`
  - `tests/{protocol-reducer,protocol-indexer}.test.ts`, `tests/anvil/protocol-indexer.test.ts`
- Modify:
  - `packages/application/src/chain-indexer.ts` (generalize the reader and store types; keep the lease, cursor-fencing, canonical-ancestry, tombstone and stale-refusal logic)
  - `apps/indexer/src/{main,config}.ts`, `scripts/rebuild-chain-index.ts`
  - `apps/api/src/main.ts`, to wire `postgresProtocolReader` as the `ProtocolReader` dependency
  - `package.json`: `test:contracts:seeds` runs only `ProtocolInvariantTest`
  - `tests/{chain-indexer,chain-index-migration,chain-snapshot-guard}.test.ts`, `tests/postgres/chain-indexer.test.ts`, `tests/helpers/{fake-chain,anvil}.ts`
- Delete:
  - `packages/domain/src/chain-reducer.ts`
  - `packages/adapters/src/{blink-abi,chain-log-reader,chain-snapshot-reader,chain-index-store}.ts`
  - `contracts/src/BlinkMarket.sol`, `contracts/src/interfaces/IBlinkMarket.sol`
  - `contracts/test/{BlinkMarket.t.sol,Adversarial.t.sol,Invariant.t.sol,TestBase.sol}`
  - `tests/{blink-abi,chain-log-reader,chain-reducer,m0}.test.ts`, `tests/anvil/chain-indexer.test.ts`
  - Keep `contracts/src/BlinkTestUSD.sol` and its interface, because the faucet deploys it.

**Interfaces:**
- Consumes: Task 3 `protocolAbi`, shared types and `ProtocolReader`; Task 4 `loadProtocolDeployment` and `deployProtocol` (used in tests).
- Produces:
  - `protocolLogReader(publicClient, deployment): ChainLogReader`. Its `getLogs` covers the four generation addresses plus `faucet`, `anchor` and `governor` over a block range. Each decoded event carries `{ contract: "REGISTRY"|"JURORS"|"MARKETS"|"RESOLUTION"|"FAUCET"|"ANCHOR"|"GOVERNOR", emitter, name, args, blockNumber, blockHash, txHash, logIndex }`.
  - `applyProtocolEvent(projection, event): ProtocolProjection`, a pure fold:
    - accounts, roles, obligations and credit (the stored value plus `updatedAt`, from `CreditGained`/`Lost`/`Imported`)
    - templates; markets with every state transition (`MarketCreated` PENDING, `MarketOpened`, `CreationChallenged`, `CreationResolved` CANCELLED or OPEN, `MarketProposed`, `MarketDisputed`, `MarketFinalized`)
    - fills (`QuoteFilled`) and positions; per-maker free balance and epoch
    - digest status; the fee pool (accrued from `QuoteFilled` fee args, zeroed by `FeesDistributed`); redemptions
    - anchors (`Anchored`)
    - The fold only records the governor's `SuccessorAdopted`.
  - `foldProtocolEvents(events): ProtocolProjection`, using deterministic `(blockNumber, logIndex)` order.
  - `tradable(market: ProtocolMarket, at: number): boolean`, exported from `protocol-reducer.ts`: true only when `state === "OPEN"` and `at < closeAt`. Tasks 9 and 10 import it.
  - `postgresProtocolReader(db, deploymentId): ProtocolReader`, implementing every method Task 3 declares.
  - Migration 0029 creates `protocol.events` (key `(deployment_id, block_hash, log_index)`, emitter, contract, name, args jsonb, canonical) and the projection tables `protocol.{accounts,account_roles,credit,templates,markets,positions,makers,quote_digests,fills,anchors}`. It drops `chain.{events,markets,positions,quote_digests,maker_state,takers}` and keeps `chain.cursors`, `chain.blocks` and the lease objects.
  - `hasRole` mirrors `BlinkRegistry.hasRole`. `creditAt` ports `creditOf` decay exactly: the same shift/half-life arithmetic, with integer results.

- [ ] **Step 1: Write the failing tests.**
  - `tests/protocol-reducer.test.ts`:
    - `normal lifecycle projection`: register → join roles → template → create → open → two makers fill → propose → finalize → distribute → redeem. The final market state, positions, per-maker free balances, fee pool 0 and escrow 0 equal hand-computed values.
    - `status of PENDING and CANCELLED markets is not tradable`: a `tradable(market, now)` helper is true only for OPEN with `now < closeAt`.
    - `digest consumed and cancelled`
    - `maker epoch is per maker`
    - `credit decay vectors`: `creditAt` for value 100 at elapsed 0, 1 half-life, 2.5 half-lives and 40 half-lives equals the registry formula's outputs, copied from a Foundry run of `creditOf`.
  - `tests/protocol-indexer.test.ts` (fake chain): `test_reorgRevokesRegistrationEligibility`. A `Registered` + `RoleJoined(TAKER)` block is indexed, then reorged out. Afterwards `hasRole(taker)` is false and `account()` is null. A fill reorged out restores the maker's free balance.
  - `tests/anvil/protocol-indexer.test.ts`:
    - deploy the alpha generation with `deployProtocol`, drive the normal lifecycle with Anvil test wallets, index it, and check that every projection equals a contract view: `getMarket`, `getPosition`, `makerFree`, `makerEpoch`, `consumed`, `feePool`, `hasRole`, `creditOf` (at the block timestamp).
    - `rebuild equals incremental`
- [ ] **Step 2: Run** `node --import tsx --test tests/protocol-reducer.test.ts tests/protocol-indexer.test.ts tests/anvil/protocol-indexer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Do not silently skip an event the ABI declares: an undecodable log from a generation address fails the batch (fail closed, as v0.1 did).
- [ ] **Step 4: Run** the step 2 command, `pnpm test:contracts && pnpm test:contracts:seeds && pnpm check`, and (CI) `tests/postgres/chain-indexer.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: index the protocol generation across contracts with reorg-safe projections`.

### Task 6: Self-serve wallet identity

Spec §5.1 "API access becomes self-service: an identity proves control of its wallet with a signature and automatically receives an API key, replacing the invite-only scheme". An identity is a wallet address. `identity.operators` survives only as an internal one-to-one container, created with the agent, so existing foreign keys keep working; no person manages it.

**Files:**
- Modify:
  - `packages/application/src/identity.ts`, `packages/ports/src/identity.ts`, `packages/adapters/src/{identity-store,identity-crypto,runtime-role}.ts`, `packages/schemas/src/{identity,http}.ts`
  - `apps/api/src/{routes,server,config}.ts`
  - `tests/identity.test.ts`, `tests/postgres/{identity,runtime-roles,runtime-functions}.test.ts`
- Create: `packages/adapters/migrations/0028_self_serve_identity.sql`.

**Interfaces:**
- Consumes: `ProtocolReader.health()` and `ProtocolReader.account()`, from the Task 3 fake until Task 5 wires the real store; Task 3 `SignatureVerifier`, with `viemSignatureVerifier` wired in `apps/api/src/main.ts`.
- Produces:
  - `POST /v1/auth/wallet-challenges`: public, no key. Body `{ address, action: "issue" | "revoke", keyId?: uuid }`.
    - Returns `{ challengeId, message, expiresAt }`. The TTL is 300 s, with at most 5 pending challenges per address.
    - Rate limits: 30 per hour per client IP (trusted-proxy aware, `apps/api/src/rate-limit.ts`) and 10 per hour per address.
    - The message format is the existing one, with `Action: issue|revoke` added and the key ID line only for revoke. The origin is `WALLET_BINDING_ORIGIN`.
  - `POST /v1/auth/wallet-verifications`: body `{ challengeId, signature }`.
    - Signature checking uses `SignatureVerifier.verifyMessage` (Task 3), so EOAs and ERC-1271 contract wallets both work. `identity-crypto`'s `verifyMessage` delegates to it or is removed. `SignatureCheckUnavailable` returns `503 SIGNATURE_CHECK_UNAVAILABLE`.
    - It consumes the challenge once.
    - For `issue`, it requires `health().stale === false` (else `503 INDEX_STALE`) and `account(address)?.registered` (else `403 NOT_REGISTERED`).
    - It creates the agent, operator and wallet binding on first use and issues a key: lifetime 30 days, at most 5 active keys per address, scopes `["forecast:write","rfq:write","content:write","suggestion:claim"]`. It returns `{ apiKey, keyId, expiresAt }`; the secret is shown once.
    - For `revoke`, it revokes `keyId` if the address owns it.
  - `ApiScope` becomes exactly `forecast:write`, `rfq:write`, `content:write`, `suggestion:claim`.
  - `authenticateIdentity` returns `{ keyId, agentId, address, scopes }`.
  - Migration 0028:
    - adds the `SECURITY DEFINER` functions `identity.issue_self_serve_key(...)` and `identity.revoke_self_serve_key(...)`, granted EXECUTE to `blink_api` only
    - deletes still-active invite keys by revoking them (`revoked_at = now()`)
    - drops `blink_identity_admin` after revoking its grants

- [ ] **Step 1: Write the failing tests** in `tests/identity.test.ts`, using the PGlite and fake reader:
  - `challenge needs no key`
  - `issue requires on-chain registration` (unregistered → 403 NOT_REGISTERED)
  - `issue refuses when index is stale` (503)
  - `challenge is single use` (a second verification returns 409)
  - `expired challenge rejected`
  - `signature from another address rejected`
  - `contract wallet proof accepted`: the owner signs for a fake ERC-1271 wallet that is registered
  - `signature check outage fails closed` (503 SIGNATURE_CHECK_UNAVAILABLE, no key issued)
  - `sixth active key refused`
  - `revoke only own key`
  - `same address keeps one agent across keys`
  - `rate limit per address`
  - In `tests/postgres/identity.test.ts`: concurrent verifications of one challenge issue exactly one key, and `blink_api` cannot INSERT into `identity.api_keys` directly.
- [ ] **Step 2: Run** `node --import tsx --test tests/identity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: self-serve API keys by wallet proof for registered identities`.

### Task 7: Resolution, juror, credit and fee read models; public read API

Spec §2.1.4 "Fees are distributed by parameters and credit changes with outcomes, and both can be recomputed independently from on-chain events and match the contract state", §5.10 Indexer.

**Files:**
- Modify:
  - `packages/domain/src/protocol-reducer.ts` (resolution and jurors events)
  - `packages/adapters/src/protocol-index-store.ts`
  - `packages/schemas/src/protocol.ts` (append types), `packages/ports/src/protocol-read.ts` (append methods)
  - `packages/application/src/market-read.ts` (rewrite on `ProtocolReader`)
  - `packages/adapters/src/market-read-store.ts` (delete if fully replaced)
  - `apps/api/src/routes.ts`, `packages/schemas/src/http.ts`
  - `tests/{market-read,protocol-reducer}.test.ts`, `tests/anvil/protocol-indexer.test.ts`
- Create: `packages/adapters/migrations/0031_protocol_resolution.sql`.
- Delete: the v0.1 market, quote and spec types in `packages/schemas/src/core.ts`, once nothing imports them.

**Interfaces:**
- Consumes: Task 5 store and reducer.
- Produces:
  - **Types:**
    - `ProtocolProposal { marketId, proposer, outcome, bondMicros, challengeEnd, evidenceHash, evidenceUri, proposedAt }`. `challengeEnd` comes from the `Proposed` event args.
    - `ProtocolDispute { disputeId, marketId, kind, ground, challenger, evidenceHash, currentRound, appealRound, settled, timedOut, finalChoice }`
    - `ProtocolRound { disputeId, round, level, snapshotAt, commitEnd, revealEnd, appealEnd, committedWeight, revealedWeight: [yes,no], committers, revealers, leadingChoice, restarted, settled, creditThreshold }`
    - `ProtocolVote { disputeId, round, juror, weight, revealed, choice, settled, slashed, reward }`. The choice is null until revealed.
    - `JurorState { address, staked, pendingUnstake, unstakeReadyAt, openVotes, rewardsOwed }`
    - `FeeBreakdown { marketId, poolMicros, treasury, creator, resolution, keeperTip, keeper, jurors, bounty, bountyWinner }`. It is recomputed from `Params` and the final outcome. Its total must equal `FeesDistributed.amount`, `keeperTip` must equal the event's `keeperTip`, and each share must equal its recipient's balance delta.
  - **Reader methods:** `proposal`, `disputes`, `dispute`, `rounds`, `votes`, `juror` and `fees`, with the shapes above.
  - **Public routes**, all GET, no key, paged with `after`/`limit` (≤100):
    - `/v1/deployment` (the current manifest v2)
    - `/v1/markets?state=`, `/v1/markets/:id` (the market plus the spec bytes' `parseMarketSpec` result plus the proposal), `/v1/markets/:id/spec` (raw bytes)
    - `/v1/markets/:id/disputes`, `/v1/disputes/:id` (with rounds; votes show `choice` only once revealed)
    - `/v1/markets/:id/fees`
    - `/v1/accounts/:address` (roles, credit per role at the request time via `creditAt`, juror state), `/v1/accounts/:address/positions`
    - `/v1/templates`
  - Every response carries `index: IndexHealth`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/protocol-reducer.test.ts`:
    - `dispute with appeal projection`: rounds, restarts, votes and the final choice
    - `fee breakdown recomputes FeesDistributed`: the R32 cases are (a) proposal won, (b) proposal lost so the resolution share goes to jurors, (c) INVALID so the creator share goes to jurors, (d) bounty paid. Dust goes to the treasury.
    - `juror unstake and rewards`
  - `tests/anvil/protocol-indexer.test.ts`:
    - `credit read model equals registry.creditOf` for every actor and role after the dispute lifecycle
    - `fees read model equals balance deltas`
    - `rounds and votes equal getDispute and events`
  - `tests/market-read.test.ts`: `market with invalid spec bytes still listed with parse error`, `votes sealed until reveal`, `pagination stable`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 tests and `pnpm check && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: read models for proposals, disputes, votes, jurors, credit and fees with public read routes`.

### Task 8: Content store and human suggestions

Spec §5.4, §5.10 ("Evidence and spec bytes are addressed by content hash, and anyone can mirror them"), §5.3 (A class archived bytes).

**Files:**
- Create:
  - `packages/application/src/{content,suggestions}.ts`, `packages/adapters/src/{content-store,suggestion-store}.ts`
  - `packages/adapters/migrations/0030_content_and_suggestions.sql`
  - `tests/{content,suggestions}.test.ts`
- Modify: `apps/api/src/{routes,server,config}.ts`, `packages/schemas/src/http.ts`, `packages/adapters/src/file-object-store.ts` (reuse as is if it fits).
- Delete:
  - `packages/adapters/src/{spec-archive,evidence-admin}.ts`, `scripts/evidence-admin.ts`, `packages/application/src/preparation.ts` (if anything is left of it)
  - routes `GET /v1/specs/:specHash` and `GET /v1/evidence/:id`, which `/v1/content/:hash` replaces
  - the `evidence:admin` script
  - In 0030, drop the `evidence` schema tables, `markets.specs` (unless `markets.protocol_deployments` references it) and the `blink_evidence_admin` role.

**Interfaces:**
- Consumes: Task 6 auth; `ProtocolReader.account`, `hasRole` and `marketBySpecHash`; Task 3 `parseMarketSpec`.
- Produces:
  - `POST /v1/content`
    - Requires `content:write` and a registered address. The body is raw bytes, at most 1 MiB, with `Content-Type` in `application/json`, `text/plain`, `text/csv`, `text/html` or `application/pdf`.
    - It stores the bytes at `keccak256(bytes)`; storing the same bytes again is idempotent.
    - It returns `{ hash, size, mediaType, uri: SPEC_PUBLIC_ORIGIN + "/v1/content/" + hash }`.
    - If the bytes parse as `MarketSpecV02` with a `suggestionId` that exists, it records the link `(specHash, suggestionId)`.
  - `GET /v1/content/:hash`: public. It returns the exact bytes with the stored media type, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, plus `Content-Disposition: attachment` for `text/html`.
  - `POST /v1/suggestions`
    - Public, no key. Body `{ text: string(20–2000), sourceUrls?: https URL[] (≤5, never fetched) }`.
    - Limits: 5 per hour per client IP and 500 per day globally, else `429`. The body cap is 8 KiB.
    - Returns `{ id }`.
  - `GET /v1/suggestions?status=OPEN|CLAIMED|MARKET_CREATED`, `GET /v1/suggestions/:id`. The status is derived at read time: `MARKET_CREATED` if any linked spec hash has a market, else `CLAIMED` if any claim exists, else `OPEN`.
  - `POST /v1/suggestions/:id/claims`: requires `suggestion:claim` and the CREATOR role, one claim per creator. Claims are informational and give no exclusivity (§5.4 "Any Creator agent can claim one").
  - Migration 0030: `content.objects(hash PK, size, media_type, uploader, created_at)`, `suggestions.items`, `suggestions.claims`, `suggestions.spec_links`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/content.test.ts`:
    - `upload is hash addressed and idempotent`
    - `unregistered address refused`
    - `oversize refused`
    - `html served as sandboxed attachment`
    - `bytes returned exactly`
    - `spec with suggestionId links`
    - `upload refuses when index is stale`
  - `tests/suggestions.test.ts`:
    - `anonymous suggestion accepted`
    - `rate limit per IP`
    - `text bounds`
    - `non-https source refused`
    - `claim needs CREATOR role`
    - `status follows claims and created markets`
    - `suggestion gives no write access`: no route accepts a suggestion id as authorization
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: hash-addressed content uploads and the public human suggestion queue`.

### Task 9: RFQ relay, protocol tx tracking, SDK and the taker example

Spec §5.5, §5.9 ("When the indexer lags, RFQ forwarding stops"), §5.2 Maker credit, §7 (`@blink/client`, `examples/agent`).

**Maker credit decision:** an off-chain informational read model only. It counts quotes relayed, quotes filled and quotes cancelled before expiry. It has no fund or limit effect and is never computed on chain, because quotes that bypass the relay are invisible to it, so no wash-resistant signal exists (`docs/P1_PROTOCOL_CONTRACTS.md`).

**Files:**
- Create:
  - `packages/application/src/rfq-relay.ts`, `packages/adapters/src/rfq-store.ts`
  - `packages/adapters/migrations/0032_rfq_relay.sql`
  - `tests/rfq-relay.test.ts`, `tests/anvil/rfq-relay.test.ts`
- Modify:
  - `packages/application/src/tx-tracking.ts`, `packages/adapters/src/{tx-receipt-reader,tx-tracking-store}.ts`, `packages/ports/src/tx-tracking.ts`
  - `packages/client/src/{index,verify-quote}.ts`, `examples/agent/{run.ts,README.md}`
  - `apps/api/src/routes.ts`, `packages/schemas/src/http.ts`
  - `tests/{client,client-verify-quote}.test.ts`, `tests/anvil/client-agent.test.ts`

**Interfaces:**
- Consumes: Task 6 auth; Task 5 `ProtocolReader.{health,hasRole,market,maker,digest}`; Task 3 `protocolAbi` and `SignatureVerifier`; Task 13 `MockErc1271Wallet` (tests).
- Produces:
  - `POST /v1/rfqs`
    - Requires `rfq:write` and the TAKER role. Body `{ marketId, side: "YES"|"NO", quantity }` with `1 ≤ quantity ≤ params.maxFillShares`.
    - The market must be tradable (OPEN and `now < closeAt`), else `409 MARKET_NOT_TRADABLE`.
    - It returns `{ rfqId, expiresAt: now + 30 }`. A taker may have at most 5 open RFQs.
  - `GET /v1/rfqs?after=`: requires `rfq:write` and the MAKER role. Returns the open RFQs: `{ rfqId, marketId, specHash, side, quantity, taker, expiresAt }`.
  - `POST /v1/rfqs/:id/quotes`
    - Requires `rfq:write` and the MAKER role. Body `{ quote: QuoteFields, signature }`.
    - It accepts only if:
      - the RFQ is open
      - `quote.taker` is the RFQ taker, and `marketId`, `side` and `quantity` equal the RFQ's
      - `specHash` equals the market's
      - `quote.maker` equals the caller, and `SignatureVerifier.verifyTypedData` accepts the signature for `quote.maker`. This is the same rule `BlinkMarkets` applies after Task 13: ECDSA for a maker without code, ERC-1271 otherwise.
      - `0 < priceBps < 10000`
      - `expiresAt − validAfter ≤ 60`, `expiresAt ≤ closeAt` and `expiresAt > now`
      - `epoch` equals `maker(quote.maker).epoch`
      - `digest(hash)` is `UNUSED`
      - `maker.freeMicros ≥ quantity × UNIT − takerCost`
    - A maker may post one quote per RFQ, and an RFQ holds at most 20 quotes.
    - It stores the fields and signature bytes exactly.
  - `GET /v1/rfqs/:id/quotes`: the RFQ's taker only. Quotes are ordered by `priceBps` ascending, then arrival, and returned exactly as stored.
  - Every relay write returns `503 INDEX_STALE` when `health().stale`.
  - `GET /v1/makers/:address/stats`: public. Returns `{ quotesRelayed, quotesFilled, quotesCancelledBeforeExpiry }`, with fills matched by digest against `QuoteFilled` and cancels against `QuoteCancelled` before `expiresAt`.
  - Tx tracking:
    - `POST /v1/transactions { txHash }` takes a key. The target must be a current-generation contract, `faucet` or `anchor`, and the sender must be the key's address.
    - The action is the decoded function name from `protocolAbi`.
    - `GET /v1/transactions/:txHash` returns the status `UNKNOWN|INCLUDED|FINALIZED|REVERTED|REORGED`, with the existing semantics.
  - `@blink/client`:
    - methods for the routes above plus Tasks 6, 7 and 8 (auth challenge and verify, reads, content upload, suggestions)
    - `verifySignedQuote(quote, signature, { publicClient, deployment, market, rfq, now, feeBps }): Promise<{ digest, takerCost, fee, maxCost }>`, where `maxCost = takerCost + fee`. It is async and checks the signature with viem `verifyTypedData`, so contract-wallet makers verify too.
    - `approvalFor(quote, feeBps): bigint`
  - `examples/agent/run.ts`: a taker-only reference flow. It claims from the faucet, registers, joins TAKER with `minRoleStake`, gets a key by wallet proof, posts an RFQ, verifies the quotes, approves `maxCost`, fills on chain, waits for FINAL and redeems. It imports only `@blink/client` and `viem`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/rfq-relay.test.ts` (fake reader):
    - `rfq refuses non-OPEN market`
    - `quote with modified field rejected`
    - `quote signed by another maker rejected`
    - `contract wallet maker quote accepted`, through `fakeSignatureVerifier` contract wallets
    - `signature check outage fails closed` (503 SIGNATURE_CHECK_UNAVAILABLE, nothing stored)
    - `stale epoch rejected`
    - `insufficient maker free balance rejected`
    - `lifetime over 60s rejected`
    - `relay refuses when index is stale`
    - `quotes returned byte-identical`
    - `only the taker reads quotes`
    - `one quote per maker per rfq`
    - `maker stats count fills and early cancels`
  - `tests/client-verify-quote.test.ts`: `verifySignedQuote requires fee-inclusive maxCost` (feeBps 100, takerCost 4_000_000 → fee 40_000, maxCost 4_040_000); `rejects domain 0.1`; `rejects maker mismatch`.
  - `tests/anvil/rfq-relay.test.ts`:
    - Two test makers quote one RFQ through the API. One is an EOA; the other is a `MockErc1271Wallet`.
    - The taker fills the best quote on chain, the indexer marks the digest CONSUMED, and the maker stats show one fill.
    - `relay and BlinkMarkets agree on contract-wallet quotes`: a wallet quote the relay accepts fills on chain, and one signed by a non-owner is refused both by the relay and by `fillQuote` (`InvalidSignature`).
  - `tests/anvil/client-agent.test.ts`: the example runs end to end against the local stack, with a test maker and proposer driven by the test.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check && pnpm build`, and run the Anvil suites. Expected: PASS.
- [ ] **Step 5: Commit** `feat: multi-maker RFQ relay with signed-quote validation, protocol tx tracking and the taker example`.

### Task 10: Signed forecasts, window anchoring, automatic contamination and consensus

Spec §5.10 ("Forecasts must be signed by the agent … periodically put the Merkle root of the forecasts in a window on-chain, triggered by anyone"), §5.7 (Forecaster credit, "The consensus probability the platform displays is weighted by Forecaster credit"), §7 (windows, sealed submission, `OUTCOME_ALREADY_PUBLIC`, Brier, LIVE/REPLAY).

**Files:**
- Create:
  - `packages/domain/src/{forecast-merkle,consensus}.ts`, `packages/adapters/migrations/0033_signed_forecasts.sql`
  - `tests/{forecast-merkle,consensus,forecast-signing}.test.ts`
- Modify:
  - `packages/application/src/{forecasts,evaluation}.ts`, `packages/adapters/src/{forecast-store,evaluation-store}.ts`
  - `packages/domain/src/forecast-windows.ts` (drop `snapshotPriceBase`)
  - `packages/schemas/src/{research,http}.ts`, `apps/worker/src/research.ts`, `apps/api/src/routes.ts`
  - `tests/{forecasts,forecast-windows,evaluation}.test.ts`, `tests/postgres/forecasts.test.ts`
- Delete: `packages/adapters/src/forecast-admin.ts`, `scripts/forecast-admin.ts` and the `forecast:admin` script. Annotations become automatic, and in 0033 the `blink_forecast_admin` role is dropped.

**Interfaces:**
- Consumes:
  - Task 6 auth
  - Task 5 `ProtocolReader.{market,markets,hasRole,anchor}`
  - Task 7 `ProtocolReader.proposal`
  - Task 8 content hashes
  - Task 3 deployment (`shared.anchor`) and `SignatureVerifier`
- Produces:
  - **Signed forecast.**
    - EIP-712 domain `{ name: "Blink Forecast", version: "1", chainId: 84532, verifyingContract: deployment.shared.anchor }`.
    - Type `Forecast(address forecaster,address markets,uint256 marketId,uint8 horizon,uint64 scheduledAt,uint16 probabilityBps,bytes32 contentHash)`. `horizon` is DAILY=0 or PRE_CLOSE=1. `contentHash` is a `/v1/content` hash or `0x0…0`.
    - Exported as `forecastTypedData` from `packages/schemas/src/research.ts`, as plain data.
  - **Submission:** `POST /v1/markets/:id/forecasts { horizon, scheduledAt, probabilityBps (1–9999), contentHash, signature }`.
    - Requires `forecast:write` and the FORECASTER role.
    - `SignatureVerifier.verifyTypedData` must accept the signature for the key's address, so EOA and contract-wallet forecasters both work. The struct must match the route's market and window and the deployment's `markets`. The submission stores the check's `blockNumber` as `verified_block`, because a contract wallet's answer can change later.
    - It is admitted by the DB clock before the window deadline, one per forecaster per window.
    - It returns `{ digest, leaf }`.
  - **Withdrawal** keeps today's semantics (annotation, not deletion), authenticated by the same key.
  - **`forecastLeaf(digest) = keccak256(bytes.concat(keccak256(abi.encode(digest))))`.**
  - **`merkleRoot(leaves: Hash[]): Hash | null`:**
    - Sort the leaves ascending and remove duplicates.
    - Pair adjacent nodes as `keccak256(concat(min(a,b), max(a,b)))`, carrying an odd last node up unchanged.
    - One leaf is its own root; an empty window has no root.
    - `merkleProof(leaves, leaf): Hash[]` verifies with OpenZeppelin `MerkleProof.verify`.
  - **Window close:** at each window deadline the worker stores the root. `GET /v1/forecast-windows/:id` returns `{ root, leaves, anchor: ProtocolReader.anchor(root) }`, and `GET /v1/forecast-windows/:id/proof?leaf=` returns `{ proof }`.
    - The platform never anchors. Any agent calls `BlinkAnchor.anchor(root)`; a forecaster may anchor its own single leaf.
  - **Contamination is automatic.** A window gets `OUTCOME_ALREADY_PUBLIC` when `proposal(marketId).proposedAt ≤ window.deadline`. No human annotation path remains.
  - **Scheduler:** it opens windows only for markets that are `tradable(market, deadline)`, so PENDING, CANCELLED and closed markets are skipped.
  - **Scoring** happens at FINAL with a YES/NO outcome, LIVE and REPLAY separate:
    - AGENT: exact Brier per eligible submission. CONSENSUS: Brier per window.
    - Forecaster stats come from the latest 50 scored LIVE submissions: `n` and `meanBrier`.
    - `weight = n < 5 ? 0 : max(0, 0.25 − meanBrier)`.
  - **`consensus(submissions, weights): probabilityBps | null`:**
    - The weighted mean, rounded half up to an integer.
    - If the total weight is 0, the unweighted mean.
    - Empty input gives `null`.
    - Weights are frozen as of the window deadline.
  - **Routes:**
    - `GET /v1/markets/:id/consensus` (per window: `probabilityBps`, the submission count, `contaminated`)
    - `GET /v1/forecasters?sort=weight`, `GET /v1/forecasters/:address`
    - `GET /v1/metrics` updated: LIVE and REPLAY separate
  - **Migration 0033:**
    - `forecasts.submissions` gains `forecaster_address`, `digest`, `signature`, `content_hash` and `verified_block`
    - `forecasts.windows` gains `merkle_root` and `root_at`
    - `analytics.score_entries` scorer becomes `AGENT|CONSENSUS`, with a new evaluation version and no edits to old rows
    - drops `blink_forecast_admin`

- [ ] **Step 1: Write the failing tests.**
  - `tests/forecast-signing.test.ts`:
    - `rejects forecast signed for another window`
    - `rejects another forecaster's signature`
    - `contract wallet forecaster accepted`, which records `verified_block`
    - `rejects other market or markets address`
    - `rejects after deadline`
    - `one per window`
    - `sealed until deadline`: other agents' answers are not readable before the deadline; the forecaster's own is
    - `requires FORECASTER role`
  - `tests/forecast-merkle.test.ts`:
    - `root of one leaf is the leaf`
    - `order independent`
    - `proof verifies for every leaf` (checked against a Foundry `MerkleProof.verify` vector, computed once and pinned)
    - `empty window has no root`
  - `tests/consensus.test.ts`:
    - `weights from Brier`: 5 scored with mean 0.1 → 0.15; 4 scored → 0
    - `falls back to mean when weights zero`
    - `rounding half up`
  - `tests/forecasts.test.ts`:
    - `scheduler skips PENDING and CANCELLED`
    - `contamination set when proposal precedes deadline`
    - `LIVE and REPLAY scored separately`
    - `anchor read through ProtocolReader`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: signed forecasts with anchorable window roots, automatic contamination and credit-weighted consensus`.

### Task 11: Infrastructure-only local alpha and platform-key absence

Spec §2.1.3. P3 adds `pnpm alpha:autonomous` with independent role agents; this task proves that the infrastructure alone serves the normal lifecycle.

**Files:**
- Create: `scripts/local-alpha.ts`, `tests/alpha/local-alpha.test.ts`, `tests/platform-keys.test.ts`.
- Modify:
  - `scripts/{restore-drill,restore-prepare,deploy-preflight,images-smoke,ops-status}.ts`, `scripts/build-services.mjs`
  - `infra/{compose.alpha.yaml,Dockerfile.api,Dockerfile.worker,Dockerfile.indexer}`
  - `apps/{api,worker,indexer}/src/config.ts`
  - `packages/application/src/{health,alert-evaluate,operator-status}.ts`. Their alerts are RPC failures, index lag, dead jobs and "FINAL market with undistributed fees older than 1 day" (informational: the platform cannot act on it).
  - `package.json` (`alpha:local`, `drill:restore`), `.github/workflows/ci.yml` (restore `alpha:local`; move `test:contracts`, `test:anvil` and `test:contracts:seeds` into a parallel `contracts` job with its own `timeout-minutes`, because `check` already takes 11–19 of its 30 minutes)
  - `tests/{deploy-preflight,health,alert-evaluate,operator-status}.test.ts`, `tests/{service-build,images}.test.mjs`, `tests/alpha/restore-drill.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - **`pnpm alpha:local`.** It needs `TEST_POSTGRES_ADMIN_URL`. It starts Anvil (chain 84532), `deployProtocol(alpha)`, registers the deployment, and runs the API, indexer and worker with no key configuration.
    - Test-harness actors are distinct Anvil wallets. They act only through the public API, `@blink/client` and the contracts.
    - They run: faucet claim and register; join roles; template; create; open; RFQ with two makers, one an EOA and one a Task 13 `MockErc1271Wallet`; fill; a forecast in a window; anchor the window root; propose; finalize unchallenged; distribute fees; redeem; a suggestion linked by `suggestionId`.
    - Assertions:
      - The API shows FINAL with fees matching `FeesDistributed`.
      - The anchor is visible, and the suggestion shows `MARKET_CREATED`.
      - Rebuilding equals incremental indexing.
      - Every platform process environment passes the platform-key absence check.
  - **`assertNoRoleKeys(env: Record<string,string|undefined>)`**, in `packages/runtime/src/index.ts`. It rejects with `PLATFORM_ROLE_KEY_FORBIDDEN` any key whose name matches `/PRIVATE_KEY|MNEMONIC|KEY_FILE|SEED/i`, or any value matching `/^0x[0-9a-fA-F]{64}$/`. Every platform app config calls it at startup. `deploy:preflight` calls it for the API, worker and indexer env.
  - The restore drill keeps the real `pg_dump`/restore and compares the rebuilt protocol projections.

- [ ] **Step 1: Write the failing tests.**
  - `tests/platform-keys.test.ts`:
    - `api, worker and indexer configs reject role keys`, with each of `MAKER_PRIVATE_KEY`, `KEEPER_KEY_FILE`, `JUROR_MNEMONIC` and a bare 32-byte hex value
    - `compose.alpha.yaml has no key env or key volumes`, by parsing the YAML
    - `.env.example has no key entries except DEPLOYER_PRIVATE_KEY under the deploy-tool section`
    - `no platform source imports privateKeyToAccount or mnemonicToAccount`: a scan of `apps/` and `packages/*/src` (`scripts/` and `tests/` are exempt)
  - `tests/alpha/local-alpha.test.ts`: the scenario above, run by CI. Locally it is skipped with a printed reason when `TEST_POSTGRES_ADMIN_URL` is absent.
- [ ] **Step 2: Run** `node --import tsx --test tests/platform-keys.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm check && pnpm build && pnpm build:services && pnpm test:service-build`. Then push to a branch and confirm the CI run executes `alpha:local`, the PostgreSQL suites and the restore drill green.
- [ ] **Step 5: Commit** `test: prove infrastructure-only operation locally and forbid platform role keys`.

### Task 12: P2 delivery docs

**Files:**
- Create: `docs/P2_OFFCHAIN_PROTOCOL.md` (English, structured like `docs/P1_PROTOCOL_CONTRACTS.md`; delivery and operations docs are English only per the user, 2026-10-24).
- Modify:
  - `docs/ROADMAP.md` (tick P2 only when Tasks 1–11 are merged and CI is green), `CONTEXT.md` (rewrite the glossary for P1/P2 terms; v0.1 terms move to a history section)
  - `README.md`, `README.zh-TW.md` (current-status paragraphs)
  - `docs/{ARCHITECTURE,ARCHITECTURE_GUIDE,DATA_MODEL,DEVELOPMENT,DEPLOYMENT_RUNBOOK,OPERATIONS,VERIFICATION,ACCEPTANCE_MATRIX,M2_PUBLIC_READS,M2_CHAIN_INDEXER}.md`
  - `contracts/README.md`, `packages/adapters/migrations/README.md`, `examples/agent/README.md`
  - the historical notice line at the top of each v0.1 delivery doc listed in the inventory
  - `apps/web/content/docs/*.md` and `apps/web/app/how-it-works/page.tsx`: a notice that the role pages describe v0.1 and P3 rewrites them, with a link to the design. The API reference regenerates from schemas. No new capability claims (§3 anti-goals).
  - `tests/{web-docs-content,web-openapi-index}.test.ts`

**Interfaces:**
- Consumes: the measured results of Tasks 1–11.

- [ ] **Step 1: Write `docs/P2_OFFCHAIN_PROTOCOL.md`**, covering:
  - what was removed (the §6 checklist, with files)
  - the self-serve identity flow
  - the RFQ relay rules
  - the content store and suggestions
  - signed forecasts, roots and anchoring
  - the consensus formula and the maker-stats decision
  - deploy tooling (local only, no deployment performed)
  - ERC-8004 (§5.1 [Implementer]): not adopted in P2; the identity is the `BlinkRegistry` address; to be evaluated in a later generation, with no added privileges
  - the A class archived-bytes rule: the content store provides storage. Jurors treat a proposal whose `evidenceHash` bytes cannot be fetched from any mirror as unsupported; P3 agent docs state it.
  - wallet neutrality (§5.1):
    - EOA and ERC-1271 wallets both work (for example Coinbase smart accounts), and off-chain checks also accept ERC-6492.
    - The platform never creates, funds or custodies a wallet.
    - Coinbase `awal` 2.12.1 has no contract calls and no typed-data signing, so it serves only for funding and transfers. P3 verifies CDP SDK wallets.
  - known limitations:
    - a contract wallet's ERC-1271 answer can change after a check; the platform records the block it checked at
    - polling relay
    - real-PostgreSQL suites CI-only on this host
    - web role pages still v0.1 until P3/P4
  - test commands with measured counts
- [ ] **Step 2: Update** the listed docs and the web notices, then run `pnpm check && pnpm build && pnpm build:pages`. Expected: PASS.
- [ ] **Step 3: Commit and push** `docs: record P2 off-chain protocol delivery and mark v0.1 role docs historical`.

---

## Deferred to later plans (not P2)

- **P3:** independent reference agents per role in `examples/` (creator, maker, forecaster, proposer, challenger, juror, keeper; the taker seed comes from Task 9); `/docs/agents` and `/llms.txt` rewritten for self-selection; `pnpm alpha:autonomous` with all five §2.1 scenarios; the import-boundary check for `examples/`; the optional LLM agent demo; registering GM_LT_V1 as the first class A template with its parser hash.
- **P4:** the website advantages page, the human suggestion form on the web, README/ROADMAP, the Remotion video.
- **Open (§12):** the banned-topic ground, real token issuance, governance over existing markets, push delivery (SSE or WebSocket) for the RFQ relay.
