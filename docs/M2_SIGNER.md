# M2 restricted signer, nonce manager and transaction dispatcher

This slice adds the private signer process that alone holds keys, the persisted sign-request protocol it serves, per-sender nonce allocation that never re-nonces an unknown transaction, gas caps, and a dispatcher that broadcasts only persisted artifacts and tracks receipts, replacements and reorgs. Nothing is wired into the API or the worker yet: the quote reservation check (Task 9) and the keeper, faucet and trader callers (Tasks 13 and 14) build on these seams, and the `tx.dispatch` handler is exported but not registered with `apps/worker`.

中文摘要：這一階段完成唯一持有私鑰的受限 signer（持久化 sign request、角色 policy、確定性簽章、nonce 與 gas 上限）以及只廣播已持久化 artifact 的交易 dispatcher（receipt、replacement、reorg 追蹤）；尚未接上 API 與 worker。

## What was added

| Piece | Where | Behavior |
| --- | --- | --- |
| Schema | `0010_signing.sql` | Schema `signing`: `economic_intents`, `sign_requests`, `artifacts` (append-only), `nonce_allocations` (append-only), `sender_guards`, `tx_attempts`, `gas_spend`, with least-privilege grants for `blink_api`, `blink_worker` and `blink_signer`. |
| Policy | `packages/domain/src/signing-policy.ts` | Pure checks for maker quotes and for keeper, faucet and trader calls, gas arithmetic and caps, the 12.5 percent replacement bump, canonical JSON. |
| Ports | `packages/ports/src/signing.ts` | `RestrictedSigner`, `SigningIntentWriter`, `SignerStore`, `DispatchStore`, `SignerRpc`, `DispatchRpc`. The draft `SignRequest`, `SignResult` and `RestrictedSigner` in `domain/execution.ts` and `ports/index.ts` are replaced; nothing else imported them. |
| Signer service | `packages/application/src/signer.ts` | `createSignerService`, `assertSignerStartup`, `transactionRequestHash`, `quoteRequestHash`, `QuoteCheckRejection`. |
| Dispatcher | `packages/application/src/tx-dispatcher.ts` | `createTxDispatcher` and the `tx.dispatch` handler (`createTxDispatchHandler`, structural job-handler type, `TxDispatchError` with `code` and `retryable`). |
| Adapters | `packages/adapters/src/signing-store.ts`, `signer-client.ts`, `key-file.ts`, `gas-oracle.ts`, `signing-rpc.ts`, `signing-calldata.ts` | PostgreSQL stores and intent writer, HTTP signer client, key-file reader, Base GasPriceOracle call and loopback check, viem RPC adapters, canonical-ABI calldata encoder. |
| Process | `apps/signer/src/config.ts`, `server.ts`, `main.ts` | `POST /internal/sign` on `SIGNER_HOST:SIGNER_PORT` (default `127.0.0.1:3004`). Without `SIGNER_ENABLED=true` the process stays the old health-only stub. |

## Protocol

A caller (API for maker quotes, worker for the rest) creates an economic intent and a sign request in its own business transaction (`signingIntentWriter`), then calls `POST /internal/sign` with `Authorization: Bearer <token>` and the strict body `{signRequestId, expectedRequestHash}`. The signer never accepts calldata, a key selector or an authorization claim: it reloads the intent, the stored request, the deployment and the chain projection itself.

- Token: SHA-256 of the bearer token is compared in constant time against every `SIGNER_CALLERS` entry (`[{name, tokenSha256, roles}]`). Unknown token: 401 `UNAUTHORIZED`. A role the caller lacks, or a role whose key is not configured: 403 `ROLE_DENIED`. Unknown request: 404. Bad body: 400 `INVALID_REQUEST`.
- `expectedRequestHash` must equal the stored `request_hash`; otherwise the response is `REQUEST_HASH_MISMATCH` and the stored request is left untouched (a wrong claim from a caller cannot poison a request).
- One database transaction: lock the request and intent, validate, allocate, reserve, sign, persist the artifact, mark the request and intent SIGNED, audit. A signed or rejected request is answered from the database forever, so a retry returns the identical artifact or rejection. Any error before commit rolls everything back and answers `503 {state: "UNKNOWN"}` (`RPC_UNAVAILABLE` or `SIGNER_ERROR`); signing is RFC 6979 deterministic, so a re-sign of the same unsigned transaction gives the same hash.
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

`estimateGas` (failure: `GAS_ESTIMATE_FAILED`); `gasLimit = estimate * 12 / 10`; `maxFee = 2 * baseFee + priority`; with `l1FeeMode: "oracle"` the Base GasPriceOracle `getL1Fee` is read over the unsigned serialized transaction. `maxCost = gasLimit * maxFee + l1Fee` must be `<= 0.0002 ETH` (`GAS_CAP_EXCEEDED`) and, with the role's UTC-day `reserved + spent`, `<= 0.002 ETH` (`GAS_DAILY_CAP_EXCEEDED`). The reservation is added on success and moved into `spent` by the dispatcher when the receipt arrives. `local-none` skips the L1 fee and is accepted at startup only for a loopback RPC URL.

### Nonces

The signer locks `sender_guards(84532, sender)`, reads `eth_getTransactionCount(sender, "pending")` and `dbNext = max(allocated) + 1` (or the pending count when nothing is allocated). If the RPC is ahead of the database an unknown occupant used the nonce: `NONCE_UNKNOWN_OCCUPANT` plus an `operations.audit_log` alert (`signer.nonce_unknown_occupant`); it never skips ahead. Otherwise it allocates `dbNext`. A replacement (`artifact_version > 1`) reuses the intent's allocation, must be exactly the previous version's calldata and gas limit, and must raise both fee fields by at least 12.5 percent (`REPLACEMENT_FEE_TOO_LOW`, `REPLACEMENT_CALLDATA_CHANGED`, `REPLACEMENT_BASE_MISSING`).

### Startup

`createSignerService` refuses a maker key that is not `manifest.roles.maker` (`MAKER_KEY_MISMATCH`), a faucet key that is not `roles.faucetMinter`, keeper or trader keys equal to any manifest role or contract, and two roles sharing a key. `assertSignerStartup` refuses an RPC on chain 8453 (`MAINNET_REFUSED`) or any chain other than 84532, and a deployment row that is missing, disabled or different from the manifest the signer loaded. `main.ts` also refuses a privileged database login (`UNSAFE_SIGNER_DATABASE_ROLE`) and key files broader than 0600 (`KEY_FILE_PERMISSIONS`). Startup failures print a code only.

## Dispatcher

`createTxDispatcher({store, rpc, signer, replaceAfterMs = 60_000}).dispatch(intentId, signal)` runs short passes that each reload the intent and act once:

1. No artifact yet: ask the signer for the first sign request (idempotent). A rejection fails the intent (`SIGN_REJECTED:<code>`, not retryable); `UNKNOWN` returns `UNKNOWN`.
2. Insert a `SIGNED` attempt for every artifact before anything is sent.
3. Look up the receipt of every version by hash. A receipt counts only while `blockHashAt(number)` still returns its block. Success is `INCLUDED`, or `FINALIZED` when the block is `<= finalized`; a revert is `REVERTED` (intent `FAILED`). The gas moves from `reserved` to `spent` exactly once per attempt. When any version is mined the others become `REPLACED` and release their reservation. An included attempt whose receipt disappears is `REORGED`.
4. Nothing mined: send the newest version when it is `SIGNED` or `REORGED` (the same raw bytes). `ACCEPTED` is `SUBMITTED`; "already known" and "nonce too low" mark the attempt `UNKNOWN`, which is looked up by hash and not blindly resent. Transport failures are retryable and leave the attempt as it was.
5. Still unmined after `replaceAfterMs` on the business clock: create the next sign request with both fees raised by 12.5 percent and ask the signer. A refusal (for example gas caps) leaves the live version in place and no further replacement is attempted. A nonce is never allocated by the dispatcher.

The handler returns only for `FINALIZED` and `REVERTED`; every other result throws `TxDispatchError("TX_PENDING", true)` so the job runtime re-enqueues it, which also keeps watching an `INCLUDED` transaction for a reorg until the provider reports finality.

## Differences from the brief

- Application code cannot import adapters, so `createSignerService` takes one extra dependency, `encodeCall` (the canonical-ABI encoder, `encodeAllowedCall`), plus optional `now` and `onError`. `viem` is now a dependency of `@blink/application` and `apps/signer` (lockfile updated).
- `signing.artifacts` has an extra nullable `max_cost_wei` (set for transactions) so the dispatcher can release exactly what the signer reserved; `blink_api` cannot read it. `sender_guards` has an `updated_at` column because `SELECT ... FOR UPDATE` needs an UPDATE privilege, which the signer holds on that column only.
- `blink_worker` may update `gas_spend.reserved_wei` as well as `spent_wei`, because moving a reservation into spent needs both.
- A `BEFORE INSERT` trigger on `sign_requests` requires a request's role to match its intent's role, and limits `blink_api` to first-version maker quotes. `economic_intents` has a (kind, role) CHECK. Superusers are exempt from the `blink_api` triggers, since `pg_has_role` reports a superuser as a member of every role; runtime logins are refused as superusers at startup.
- `request_hash` for transactions is the keccak256 of the canonical JSON of the payload; the brief did not define it.
- The signer reports `503 UNKNOWN` without persisting anything for transport failures; `GAS_ESTIMATE_FAILED` and the other policy codes are persisted rejections.
- `apps/signer/src/server.ts` and `packages/adapters/src/signing-rpc.ts`, `signing-calldata.ts` are extra files.

## Verification

Run on 2026-10-14 in the task worktree against a local PostgreSQL and a local Anvil with chain ID 84532.

- `pnpm check`: exit 0, 170 Node tests (129 before this slice), package boundaries pass.
- `pnpm build`: exit 0.
- `pnpm build:services && pnpm test:service-build`: exit 0, 3 bundle tests pass (new: the signer bundle fails closed with `SIGNER_CONFIGURATION_REQUIRED` when enabled without configuration).
- `pnpm test:anvil`: exit 0, 7 tests (6 new): a faucet MINT is signed over HTTP, dispatched and INCLUDED with +1000 bUSD; a crash after signing, rolled back, signs the same tx hash and nonce; a replacement keeps the nonce, raises both fees, and only the included version stays while the other is REPLACED; a reorg (snapshot, include, revert) gives REORGED, the same bytes are rebroadcast and the intent is INCLUDED again; a transaction already in the pool is UNKNOWN and found once mined; the HTTP client maps an unreachable signer to UNKNOWN and a bad token to REJECTED.
- `TEST_POSTGRES_ADMIN_URL=... pnpm test:postgres`: exit 0, 5 tests (4 new, real PostgreSQL 17): twelve concurrent requests from two signer pools get distinct consecutive nonces; the same request signed from two pools yields one artifact; S07, a restarted dispatcher with an UNKNOWN attempt creates no new nonce, intent or attempt and settles gas once under racing dispatchers; the real roles' grants hold. With the sender lock removed, the first test fails (mutation check).
- New unit tests: `tests/signing-policy.test.ts` (11), `tests/signer.test.ts` (16, PGlite and a fake RPC), `tests/tx-dispatcher.test.ts` (10), `tests/signer-config.test.ts` (4).
- A throwaway script (not committed) also ran `apps/signer/src/main.ts` as a process against real PostgreSQL with a non-owner `blink_signer` login and an Anvil node: a superuser login, a 0644 key file, a wrong maker key and a chain 8453 node each exit 1 with only their code; a MINT request signs over HTTP; a wrong token is rejected; stdout and stderr contain neither the key nor the bearer token.

## Remaining limits

- The `quoteCheck` hook is only a seam; the reservation check is Task 9. No API route calls `signerClient` and `apps/worker` does not register `createTxDispatchHandler`; the controller wires it after the job runtime merges.
- Default Anvil fees (1 gwei base and tip) make a mint cost about 0.00025 ETH, above the 0.0002 ETH per-transaction cap, so the Anvil tests lift the caps and the local Alpha harness must start Anvil with lower fees (or mine empty blocks so the base fee decays). Anvil also reports finalized block 0, so FINALIZED is covered by the fake-RPC dispatcher tests, not by Anvil.
- `l1FeeMode: "oracle"` is covered with a fake RPC only; the Base GasPriceOracle is not available on Anvil.
- A quote's `validAfter` is not bounded against the signer clock beyond the 60 second lifetime and the `expiresAt - 2 s` rule; Task 9 sets it from the canonical block time. A `REVERTED` or `FINALIZED` attempt is final: a reorg deeper than finality is not auto-recovered.
- `/health/ready` of `@blink/runtime` still reports not-ready for every service, including an enabled signer. `assertProductionClock` is not called by the signer (it only uses `blink.now()` for the gas day).
- Raw signed transactions are stored unencrypted in a signer/worker-readable table (ruling 7); caller authentication is a bearer token over loopback or private HTTP (ruling 4); mTLS and network ACLs are deployment items.
- `docs/OPERATIONS.md` and `docs/DEVELOPMENT.md` still say the signer has no endpoint; the controller updates them with the roadmap.
