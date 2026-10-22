# M2 restricted signer, nonce manager and transaction dispatcher

This slice adds the private signer process that alone holds keys, the persisted sign-request protocol it serves, per-sender nonce allocation that never re-nonces an unknown transaction, gas caps, and a dispatcher that broadcasts only persisted artifacts and tracks receipts, replacements and reorgs. Nothing is wired into the API or the worker yet: the quote reservation check (Task 9) and the keeper, faucet and trader callers (Tasks 13 and 14) build on these seams, and the `tx.dispatch` handler is exported but not registered with `apps/worker`.

中文摘要：這一階段完成唯一持有私鑰的受限 signer（持久化 sign request、角色 policy、確定性簽章、nonce 與 gas 上限）以及只廣播已持久化 artifact 的交易 dispatcher（receipt、replacement、reorg 追蹤）；尚未接上 API 與 worker。

## What was added

| Piece | Where | Behavior |
| --- | --- | --- |
| Schema | `0010_signing.sql` | Schema `signing`: `economic_intents`, `sign_requests`, `artifacts` (append-only), `nonce_allocations` (append-only), `signing_plans` (append-only), `sender_guards`, `tx_attempts`, `gas_spend`, with least-privilege grants for `blink_api`, `blink_worker` and `blink_signer`. |
| Policy | `packages/domain/src/signing-policy.ts` | Pure checks for maker quotes and for keeper, faucet and trader calls, gas arithmetic and caps, the 12.5 percent replacement bump, canonical JSON. |
| Ports | `packages/ports/src/signing.ts` | `RestrictedSigner`, `SigningIntentWriter`, `SignerStore`, `DispatchStore`, `SignerRpc`, `DispatchRpc`. The draft `SignRequest`, `SignResult` and `RestrictedSigner` in `domain/execution.ts` and `ports/index.ts` are replaced; nothing else imported them. |
| Signer service | `packages/application/src/signer.ts` | `createSignerService`, `assertSignerStartup`, `transactionRequestHash`, `quoteRequestHash`, `QuoteCheckRejection`. |
| Dispatcher | `packages/application/src/tx-dispatcher.ts` | `createTxDispatcher` and the `tx.dispatch` handler (`createTxDispatchHandler`, structural job-handler type, `TxDispatchError` with `code` and `retryable`). |
| Adapters | `packages/adapters/src/signing-store.ts`, `signer-client.ts`, `key-file.ts`, `gas-oracle.ts`, `signing-rpc.ts`, `signing-calldata.ts` | PostgreSQL stores and intent writer, HTTP signer client, key-file reader, Base GasPriceOracle call and loopback check, viem RPC adapters, canonical-ABI calldata encoder. |
| Process | `apps/signer/src/config.ts`, `server.ts`, `main.ts` | `POST /internal/sign` on `SIGNER_HOST:SIGNER_PORT` (default `127.0.0.1:3004`). Without `SIGNER_ENABLED=true` the process stays the old health-only stub. Every startup failure, including an invalid configuration, prints a code only and exits 1. |
| Runtime | `packages/runtime/src/index.ts` | `createService` accepts an optional readiness check; the default is unchanged (always not ready). |

## Protocol

A caller (API for maker quotes, worker for the rest) creates an economic intent and a sign request in its own business transaction (`signingIntentWriter`), then calls `POST /internal/sign` with `Authorization: Bearer <token>` and the strict body `{signRequestId, expectedRequestHash}`. The signer never accepts calldata, a key selector or an authorization claim: it reloads the intent, the stored request, the deployment and the chain projection itself.

- Token: SHA-256 of the bearer token is compared in constant time against every `SIGNER_CALLERS` entry (`[{name, tokenSha256, roles}]`). Unknown token: 401 `UNAUTHORIZED`. A role the caller lacks, or a role whose key is not configured: 403 `ROLE_DENIED`. Unknown request: 404. Bad body: 400 `INVALID_REQUEST`.
- `expectedRequestHash` and replay: a request that is still `REQUESTED` and whose caller names a different hash is persisted `REJECTED` with `REQUEST_HASH_MISMATCH` (brief rule 3). A request that is already `SIGNED` or `REJECTED` replays its persisted result only when the supplied hash matches; on a mismatch the response is `REQUEST_HASH_MISMATCH`, nothing changes and no artifact is revealed.
- Transactions are signed in two database transactions. Phase one validates the request, decides nonce, gas and fees against the chain, and commits an immutable **signing plan** (`signing.signing_plans`: sender, nonce, gas limit, both fee fields, L1 fee, maximum cost) together with the nonce allocation and the gas reservation. Phase two locks the request again, re-validates the policy, and signs exactly the planned transaction, persists the artifact and marks the request and intent SIGNED. A retry after a crash between or inside the phases reuses the plan and never asks the chain again, so it signs identical bytes even if the base fee moved, and no other intent can take the planned nonce meanwhile. Maker quotes need no plan (their signature depends only on the message) and are signed in one transaction. A signed or rejected request is answered from the database forever. Any error leaves the committed plan and answers `503 {state: "UNKNOWN"}` (`RPC_UNAVAILABLE` or `SIGNER_ERROR`).
- A request that is rejected after its plan was committed (for example the deployment was switched off in between) gives its gas reservation back and raises `signer.plan_abandoned` in `operations.audit_log`; the nonce a first version allocated cannot be returned, so that audit row is the alert for a nonce hole an operator must fill.
- Responses: 200 `SIGNED` (`artifactId`, `artifactHash`, plus `signature` for quotes or `txHash` for transactions), 422 `REJECTED` with a code (persisted), 503 `UNKNOWN`. The HTTP client maps a timeout or network failure to `UNKNOWN / SIGNER_TIMEOUT`, never `REJECTED`.

### Request hashes

- Maker quote: `request_hash` is the EIP-712 `hashTypedData` digest of the Quote message (domain `{name: "Blink RFQ", version: "0.1", chainId: 84532, verifyingContract: BlinkMarket}`, built by the signer). Callers compute it with `quoteRequestHash(manifest, message)`.
- Transactions: `request_hash` is `keccak256` of the canonical JSON (sorted keys) of `unsigned_payload`, via `transactionRequestHash(payload)`. The payload is exactly `{to, functionName, args}`; a replacement version adds `maxFeePerGas` and `maxPriorityFeePerGas` and nothing else.

### Maker quote policy (`MAKER_QUOTE`, first version only)

Deployment enabled and `manifest.tradingEnabled`; `maker` equals the maker key and `manifest.roles.maker`; `1 <= expiresAt - validAfter <= 60`; signer clock `< expiresAt - 2 s`; the market exists in `chain.markets`, is `OPEN`, has `expiresAt <= close_at` and `specHash = spec_hash`; `epoch = chain.maker_state.epoch`; quantity 1..100; priceBps 1..9999; stored hash equals the digest. The optional `quoteCheck` hook runs last (Task 9 adds the reservation check); `QuoteCheckRejection(code)` becomes a persisted rejection, any other failure leaves the request retryable.

### Transaction policy

| Intent kind (role) | Target | Function | Limits |
| --- | --- | --- | --- |
| `FINALIZE_UNCHALLENGED`, `FINALIZE_TIMEOUT` (keeper) | BlinkMarket | `finalizeUnchallenged(id)`, `finalizeTimeout(id)` | `id > 0` |
| `MINT` (faucet) | BlinkTestUSD | `mint(to, amount)` | `amount <= 1_000_000_000` |
| `APPROVE` (trader) | BlinkTestUSD | `approve(BlinkMarket, amount)` | `0 < amount <= 100_000_000` (never unlimited) |
| `FILL` (trader) | BlinkMarket | `fillQuote(q, sig)` | `q.taker` is the trader key, `q.maker` is the manifest maker |
| `REDEEM` (trader) | BlinkMarket | `redeem(id)` | `id > 0` |

The intent kind pins the exact function; the signer encodes calldata from `blink-abi.ts`; value is always 0. Rejection codes: `PAYLOAD_INVALID` (extra keys such as `data` or `value`, wrong shapes), `INTENT_MISMATCH`, `SELECTOR_NOT_ALLOWED`, `TARGET_NOT_ALLOWED`, `AMOUNT_NOT_ALLOWED`, `TAKER_NOT_ALLOWED`, `MAKER_NOT_ALLOWED`. Other request-level codes: `DEPLOYMENT_MISMATCH`, `DEPLOYMENT_DISABLED`, `POLICY_VERSION_UNSUPPORTED`, `INTENT_NOT_SIGNABLE`, `VERSION_NOT_ALLOWED`, `PAYLOAD_HASH_MISMATCH`, and the quote codes in `signing-policy.ts` (`QUOTE_INVALID`, `TRADING_DISABLED`, `QUOTE_LIFETIME_INVALID`, `QUOTE_EXPIRED`, `MARKET_NOT_FOUND`, `MARKET_NOT_OPEN`, `QUOTE_AFTER_CLOSE`, `SPEC_HASH_MISMATCH`, `EPOCH_MISMATCH`, `QUANTITY_NOT_ALLOWED`, `PRICE_NOT_ALLOWED`).

### Gas

`estimateGas` (failure: `GAS_ESTIMATE_FAILED`); `gasLimit = estimate * 12 / 10`; `maxFee = 2 * baseFee + priority`; with `l1FeeMode: "oracle"` the Base GasPriceOracle `getL1Fee` is read over the unsigned serialized transaction. `maxCost = gasLimit * maxFee + l1Fee` is decided once, in the plan, and must be `<= 0.0002 ETH` (`GAS_CAP_EXCEEDED`) and, with the role's UTC-day `reserved + spent`, `<= 0.002 ETH` (`GAS_DAILY_CAP_EXCEEDED`). The reservation is made with the plan and then follows canonical receipts through the dispatcher's idempotent deltas (see Dispatcher). `local-none` skips the L1 fee and is accepted at startup only for a loopback RPC URL.

### Nonces

The signer locks `sender_guards(84532, sender)`, reads `eth_getTransactionCount(sender, "pending")` and `dbNext = max(allocated) + 1` (or the pending count when nothing is allocated). If the RPC is ahead of the database an unknown occupant used the nonce: `NONCE_UNKNOWN_OCCUPANT` plus an `operations.audit_log` alert (`signer.nonce_unknown_occupant`); it never skips ahead. Otherwise it allocates `dbNext`. A replacement (`artifact_version > 1`) reuses the intent's allocation, must be exactly the previous version's calldata and gas limit, and must raise both fee fields by at least 12.5 percent rounded up (`REPLACEMENT_FEE_TOO_LOW`, `REPLACEMENT_CALLDATA_CHANGED`, `REPLACEMENT_BASE_MISSING`). A zero tip is a valid EIP-1559 field (viem decodes a zero RLP field as `undefined`, which the signer and dispatcher both read as zero through `decodeEip1559`); a transaction with a zero tip is replaced with a 1 gwei minimum tip, the fee cap still rises at least 12.5 percent and never drops below the tip. `minimumReplacementFees` is the one function the dispatcher asks with and the signer accepts against.

### Startup

`createSignerService` refuses a maker key that is not `manifest.roles.maker` (`MAKER_KEY_MISMATCH`), a faucet key that is not `roles.faucetMinter`, keeper or trader keys equal to any manifest role or contract, and two roles sharing a key. `assertSignerStartup` refuses an RPC on chain 8453 (`MAINNET_REFUSED`) or any chain other than 84532, and a deployment row that is missing, disabled or different from the manifest the signer loaded. `main.ts` also refuses key files broader than 0600 (`KEY_FILE_PERMISSIONS`), a shifted business clock (`assertProductionClock`, allowed only with `BLINK_ALLOW_TEST_CLOCK=1`) and a privileged database login (`UNSAFE_SIGNER_DATABASE_ROLE`). The login guard judges the authenticated login (`session_user`), not only the effective role: it must equal `current_user`, be an ordinary login (no superuser, CREATEROLE, CREATEDB or BYPASSRLS, not the database owner, no CREATE on the signing, markets, chain, operations, identity or blink schemas), belong to `blink_signer`, and be a member of no other role at all, so it cannot switch to the API, worker, indexer or an administrator role. An administrator connection that merely starts with `role=blink_signer` is refused. Startup failures print a code only.

`/health/ready` of an enabled signer is its own check: the database answers, the deployment row is still enabled, and the RPC still reports chain 84532. Any failure is 503 with no detail.

## Dispatcher

`createTxDispatcher({store, rpc, signer, replaceAfterMs = 60_000}).dispatch(intentId, signal)` runs short passes that each reload the intent and act once, in this order:

1. No artifact yet: ask the signer for the first sign request (idempotent). A rejection fails the intent (`SIGN_REJECTED:<code>`, not retryable); `UNKNOWN` returns `UNKNOWN`.
2. Insert a `SIGNED` attempt for every artifact before anything is sent. A new attempt holds exactly the reservation the signer made for it.
3. **Observe every persisted version first**, whatever the signer is doing: look up each version's receipt by hash. A receipt counts only while `blockHashAt(number)` still returns its block. Success is `INCLUDED`, or `FINALIZED` when the block is `<= finalized`. A reverted receipt is also `INCLUDED` (receipt status `reverted`) until its block is final; only then is it `REVERTED` and the intent `FAILED`. When finality is unknown a revert is never final. An included attempt whose receipt disappears is `REORGED`. When one version holds the nonce, every other version is `REPLACED`; a `REPLACED` version that later shows a canonical receipt wins and the old winner becomes `REPLACED`.
4. Every observation is written in one transaction that locks the intent, re-reads the attempts and compares versions. If any attempt moved since it was read, nothing is written and the pass reloads, so a stale observer can never overwrite a newer attempt or intent state; the intent state is derived only from persisted attempt states, and a `FINALIZED`, `FAILED` or `CANCELLED` intent never moves again.
5. Nothing mined: send the version that needs it. A version that was mined and then orphaned (`REORGED`) comes first, with its persisted bytes and its nonce; otherwise the newest version if it was never sent. `ACCEPTED` is `SUBMITTED`; "already known", "nonce too low" and "underpriced" (a higher-priced version is pooled) mark the attempt `UNKNOWN`, which is looked up by hash and not blindly resent. Transport failures are retryable and leave the attempt as it was.
6. Only then deal with replacements: finish an outstanding unsigned replacement request, or, after `replaceAfterMs` on the business clock, create the next sign request with `minimumReplacementFees` over the newest signed version. A signer outage or refusal (for example gas caps) leaves the live version in place; no further replacement is attempted after a refusal. A nonce is never allocated by the dispatcher.
7. **A final outcome is reconciled before the job may stop.** When a version is `FINALIZED`, or a revert is final (`FAILED`), the dispatcher first gives any version signed after the winner was read its attempt (it is `REPLACED` and releases its reservation), then asks the signer about every replacement request that was planned but never signed. The signer rejects it as `SUPERSEDED_BY_FINAL` under the request lock, gives the plan's reservation back on the plan's UTC day exactly once, keeps the plan row, and replays that rejection to any racing or later retry (which therefore cannot sign, release again or create an artifact). While the winner is only `INCLUDED` (a reorg could still need the replacement) the reservation is kept and the signer is not asked. If the signer cannot answer, `dispatch` returns `PENDING` after recording the outcome, so the job comes back instead of completing with gas still reserved; observation never waits for the signer.

Gas follows canonical receipts through idempotent deltas. Each attempt records what it currently holds in `gas_spend.reserved_wei` (`gas_reserved_wei`) and has charged to `spent_wei` (`gas_spent_wei`); every state change moves the ledger by the difference. A pending version (`SIGNED`, `SUBMITTED`, `UNKNOWN`, `REORGED`) holds its maximum cost; a version with a canonical receipt holds nothing and is charged its actual cost (gas used times effective price plus the L1 fee); a `REPLACED` version holds and is charged nothing. So orphaning an inclusion reverses its spend and restores its reservation, re-inclusion charges the new actual amount, and a replaced sibling that wins after a reorg is charged. The ledger day is the UTC day of the plan.

The handler returns only for `FINALIZED` and `REVERTED`; every other result throws `TxDispatchError("TX_PENDING", true)` so the job runtime re-enqueues it, which also keeps watching an `INCLUDED` transaction for a reorg until the provider reports finality. `tx.dispatch` jobs get 20 attempts (about 70 minutes of backoff, `TX_DISPATCH_MAX_ATTEMPTS`) because Base Sepolia's finalized head trailed by 14-33 minutes on 2026-10-21; a job that still dies alerts, and the worker's recovery sweep re-enqueues it with the same 20-attempt budget.

## Differences from the brief

- Application code cannot import adapters, so `createSignerService` takes one extra dependency, `encodeCall` (the canonical-ABI encoder, `encodeAllowedCall`), plus optional `now` and `onError`. `viem` is now a dependency of `@blink/application` and `apps/signer` (lockfile updated).
- `signing.artifacts` has an extra nullable `max_cost_wei` (set for transactions) so the dispatcher can release exactly what the signer reserved; `blink_api` cannot read it. `sender_guards` has an `updated_at` column because `SELECT ... FOR UPDATE` needs an UPDATE privilege, which the signer holds on that column only.
- `blink_worker` may update `gas_spend.reserved_wei` as well as `spent_wei`, because moving a reservation into spent needs both.
- `signing.signing_plans` is a new append-only table (not in the brief) holding the pre-signing plan; `tx_attempts` gains `receipt_status`, `gas_reserved_wei` and a non-null `gas_spent_wei` for the ledger deltas, and `REVERTED` now means a final revert. `blink_worker` reads plans to find the ledger day.
- A `BEFORE INSERT` trigger on `sign_requests` requires a request's role to match its intent's role, and limits `blink_api` to first-version maker quotes. `economic_intents` has a (kind, role) CHECK. Superusers are exempt from the `blink_api` triggers, since `pg_has_role` reports a superuser as a member of every role; runtime logins are refused as superusers at startup.
- `request_hash` for transactions is the keccak256 of the canonical JSON of the payload; the brief did not define it.
- A transport failure answers `503 UNKNOWN` and persists nothing new; `GAS_ESTIMATE_FAILED` and the other policy codes are persisted rejections. A request with a committed plan keeps the plan on failure (that is the point of the plan).
- `apps/signer/src/server.ts` and `packages/adapters/src/signing-rpc.ts`, `signing-calldata.ts` are extra files.

## Verification

Run on 2026-10-14 in the task worktree against a local PostgreSQL 17 and a local Anvil with chain ID 84532, after the review fixes (fix rounds 1 and 2).

- `pnpm check`: exit 0, 189 Node tests (129 before this slice), package boundaries pass.
- `pnpm build`: exit 0.
- `pnpm build:services && pnpm test:service-build`: exit 0, 4 bundle tests pass (the signer bundle fails closed with `SIGNER_CONFIGURATION_REQUIRED` when enabled without configuration, and prints only a code for an invalid configuration).
- `pnpm test:anvil`: exit 0, 8 tests (7 new): a faucet MINT is signed over HTTP, dispatched and INCLUDED with +1000 bUSD; a crash after signing, with the real fee market moved by 40 empty blocks and another intent signed meanwhile, re-signs the planned bytes with the same tx hash and nonce; a replacement keeps the nonce and raises both fees and only the included version stays while the other is REPLACED; a reorg gives REORGED, the same bytes are rebroadcast and the ledger holds the new actual cost; the combined replacement-plus-reorg case (the other version wins on the new branch and is charged its exact actual cost, then an orphaned version returns with its own bytes and holds its reservation again); a transaction already in the pool is UNKNOWN and found once mined; the HTTP client maps an unreachable signer to UNKNOWN and a bad token to REJECTED.
- `TEST_POSTGRES_ADMIN_URL=... pnpm test:postgres`: exit 0, 9 tests (8 new, real PostgreSQL 17), run five times in a row with the same result. They cover twelve concurrent requests from two real signer logins getting distinct consecutive nonces; one artifact from the same request signed by two pools at once; S07 (a restarted dispatcher with an UNKNOWN attempt creates no new nonce, intent or attempt, and settles gas once under racing dispatchers); the runtime guard accepting an ordinary signer login and refusing an administrator with `role=blink_signer`, a login that is also a worker or API login, one with CREATEDB, and a database owner; six rounds of observers with conflicting final views (revert versus success) always ending in one coherent attempt, intent and ledger; a replacement plan left behind by a final outcome released exactly once while the dispatcher's cleanup races signing retries from two signer processes (four rounds, with three unrelated reservations held so a double release would show); the real roles' grants; and the signer process refusing a shifted business clock and reporting readiness from its database, deployment row and RPC. The test roles and databases are dropped afterwards.
- Unit tests: `tests/signing-policy.test.ts` (12), `tests/signer.test.ts` (21, PGlite and a fake RPC), `tests/tx-dispatcher.test.ts` (21), `tests/signer-config.test.ts` (4), `tests/signer-server.test.ts` (2).
- Mutation checks: removing the final-outcome reconciliation, the sender lock, the observation version comparison, the REORGED-first send choice, the final-before-revert rule, the spend reversal, or the plan reuse each makes its regression test fail.
- A throwaway script (not committed) also ran `apps/signer/src/main.ts` as a process against real PostgreSQL with a non-owner `blink_signer` login and an Anvil node: a superuser login, a 0644 key file, a wrong maker key and a chain 8453 node each exit 1 with only their code; a MINT request signs over HTTP; a wrong token is rejected; stdout and stderr contain neither the key nor the bearer token.

## Remaining limits

- The `quoteCheck` hook is only a seam; the reservation check is Task 9. No API route calls `signerClient` and `apps/worker` does not register `createTxDispatchHandler`; the controller wires it after the job runtime merges.
- Default Anvil fees (1 gwei base and tip) make a mint cost about 0.00025 ETH, above the 0.0002 ETH per-transaction cap, so the Anvil tests lift the caps and the local Alpha harness must start Anvil with lower fees (or mine empty blocks so the base fee decays). Anvil also reports finalized block 0, so FINALIZED is covered by the fake-RPC dispatcher tests, not by Anvil.
- `l1FeeMode: "oracle"` is covered with a fake RPC only; the Base GasPriceOracle is not available on Anvil.
- A quote's `validAfter` is not bounded against the signer clock beyond the 60 second lifetime and the `expiresAt - 2 s` rule; Task 9 sets it from the canonical block time. A `REVERTED` or `FINALIZED` attempt is final: a reorg deeper than finality is not auto-recovered. On a provider that reports no finality (Anvil reports block 0) a revert is never final, so such an intent stays `INCLUDED` and its `tx.dispatch` job keeps retrying.
- Cleaning up an unsigned replacement after a final outcome needs the signer to answer (it owns the request lock and the rejection); until it does the job keeps returning `PENDING` and the reservation is held, which is conservative. Direct worker writes to `sign_requests` were deliberately not granted for this.
- A first-version plan that is rejected afterwards (the deployment was switched off between the two phases) leaves its nonce allocated with no transaction; the later nonces of that sender queue behind the hole until an operator fills it. The `signer.plan_abandoned` audit row names the sender and nonce. Nothing fills holes automatically.
- A reverted receipt on Anvil is covered with the fake-RPC dispatcher tests only: Anvil reports no finality and a transaction whose gas estimate succeeds but whose inclusion reverts needs market state the signer tests do not build.
- Raw signed transactions are stored unencrypted in a signer/worker-readable table (ruling 7); caller authentication is a bearer token over loopback or private HTTP (ruling 4); mTLS and network ACLs are deployment items.

## Final review fix B — 2026-10-16

Signer readiness now re-checks the production business-clock guard on each
request, preserving the existing explicit local test opt-in. API, worker,
signer and indexer runtime checks share the signer's strict login shape: one
service group, no extra memberships, no privileged role flags, no database
ownership and no CREATE in application schemas. Migration 0020 revokes PUBLIC
EXECUTE on application functions and preserves only explicit business-clock
grants; triggers continue to execute through their installed triggers.

The RFQ and trader snapshot adapter checks the RPC chain before each head or
contract snapshot read, refusing 8453 with MAINNET_REFUSED and other foreign
chains with CHAIN_NOT_ALLOWED. This is the same per-call policy as the execution
reader. No key handling, signing policy, transaction broadcasting or explicit
local harness clock opt-in changed.

Verification: `pnpm check` passed (598 tests); `pnpm test:postgres` passed (50);
`pnpm test:anvil` passed (50); `pnpm build:services && pnpm test:service-build`
passed (5). A final `pnpm typecheck` and `git diff --check` also passed. The web build
was blocked by Google Fonts access.
