# M5 client SDK and external agent example

`@blink/client` now has a typed method for every enabled endpoint, retries transient refusals with the same Idempotency-Key, and exports `verifySignedQuote`, the check a taker runs before it approves or sends anything. `examples/agent/run.ts` is an external agent that runs the whole flow on the local stack with it. Nothing here deploys, signs for anyone but the agent's own wallet, or contacts a network beyond a local Anvil (chain ID 84532) and the local API.

中文摘要：`@blink/client` 補齊所有已啟用端點的型別化方法、同一 Idempotency-Key 的自動重試，以及送單前必做的 `verifySignedQuote`（11 種失敗碼）；`examples/agent/run.ts` 在本機堆疊上走完整個外部 agent 流程（綁錢包、預測、水龍頭、驗證報價、精確授權、fill、等待 FINAL、redeem）。

## What was added

| Piece | Where | Behavior |
| --- | --- | --- |
| Methods | `packages/client/src/index.ts` | 26 methods: the existing identity, candidate, evidence and admin helpers plus `listMarkets`, `getMarketSpec`, `listForecasts`, `getQuote`, `trackTransaction`, `getTransaction`, `getPositions`, `submitResolutionReport`, `getResolution`, `claimFaucet`, `getMetrics` (and the already present `listForecastWindows`, `submitForecast`, `requestQuote`). One `call` helper checks path, query and body against the shared contract before sending and the answer after. |
| Idempotency | same | Every POST takes an optional key; without one the client sends `crypto.randomUUID()`. The key is chosen once per call and checked locally (`requestQuote` used to leave this to the server). |
| Retry policy | same | `createBlinkClient(url, key, { maxAttempts = 3, sleep })`. An answer whose `ApiError.retryable` is `true` is tried again (reads and POSTs alike) after `Retry-After` (capped at 10 s) or 250 ms doubling; a POST repeats the same key and body. A 503 `SERVICE_NOT_READY` while a quote is still being signed (`SIGN_UNKNOWN`) therefore resumes the same quote. Business refusals (`retryable: false`) and network failures are not retried. |
| Spec check | same | `getMarketSpec(ref, specHash)` reads the raw bytes of `GET /v1/markets/:id/spec`, requires `keccak256(bytes) = specHash` (else `Error("SPEC_HASH_MISMATCH")`) and returns the parsed spec. The caller supplies the hash it already trusts (from `listMarkets` or the signed quote), so a server that serves other bytes is caught. |
| Quote check | `packages/client/src/verify-quote.ts` | `verifySignedQuote(envelope, { config, wallet, request, nowSeconds })` returns nothing and throws `QuoteVerificationError(code)` on the first failure, in this order: `DEPLOYMENT_MISMATCH`, `DOMAIN_MISMATCH`, `MAKER_MISMATCH`, `SIGNATURE_INVALID`, `DIGEST_MISMATCH`, `TAKER_MISMATCH`, `TERMS_MISMATCH`, `COST_MISMATCH`, `MAX_COST_EXCEEDED`, `EXPIRED`, `CALLDATA_MISMATCH`. It is synchronous so that a caller cannot forget to await it. |
| Typed answers | `packages/schemas/src/http.ts` | `operation()` keeps the literal method, path and response schema, and `ApiContract` exports that union as a type; `apiContracts` is still `readonly HttpContract[]`. The client types each method's result from the schema that validated it. Request inputs stay `unknown` and are validated at run time (as before). |
| Example agent | `examples/agent/run.ts`, `examples/agent/README.md` | See below. `tsconfig.json` now includes `examples/**/*.ts`, so `pnpm typecheck` covers it. |
| Public docs | `apps/web/content/docs/client.md` | Method tables, the optional key, the retry paragraph and the quote check; `tests/web-docs-content.test.ts` still passes (no `pnpm`, `curl`, loopback hosts or invented hosts). |

### Decisions inside the verification codes

- A quote's **top-level** `marketId` and `expiresAt` are unsigned display fields. They must equal the signed message or the call fails with `TERMS_MISMATCH`; the checks themselves use the signed message only.
- The digest and the typed-data domain are built from the deployment in `getConfig()` and the canonical Quote types, never from the envelope's own `domain` or `types`.
- `COST_MISMATCH` also covers a signed price outside 1..9999 bps, which the contract would reject.
- `SIGNATURE_INVALID` includes a signature that cannot be recovered at all (viem's recovery is asynchronous, so the client uses `ox`'s synchronous `Secp256k1.recoverAddress`).
- `nowSeconds` must be chain time. The quote's validity is the block timestamp, so a host clock never extends it.

## The example agent

`node --import tsx examples/agent/run.ts` with `BLINK_API_URL`, `BLINK_API_KEY`, `AGENT_PRIVATE_KEY` and `RPC_URL` (it refuses any `RPC_URL` that is not loopback and any chain but 84532). Flow: `getConfig`, bind the wallet, list markets and verify the spec, submit a forecast in the open window, claim the faucet, request a quote, `verifySignedQuote`, approve exactly the taker cost, read `consumed(digest)`, send the verified calldata once, `trackTransaction`, poll `getTransaction` and `getPositions`, wait until the market is FINAL, redeem.

- An expired quote (a verification `EXPIRED`, an API `QUOTE_EXPIRED`, or a fill that ran out) is replaced by a new RFQ under a **new** key, at most three times.
- A fill whose outcome is unknown (a lost answer, no receipt) is **never sent again**. The agent waits until `consumed(digest)` shows it landed or the quote expires. A fill that would revert is refused by an `eth_call` before it is sent.
- `runAgent(config)` is exported, so Task 16's harness can call it in process or run the file as a process.

## Tests

| File | Covers |
| --- | --- |
| `tests/client-verify-quote.test.ts` (13) | Each code with an envelope signed offline by an Anvil development key (the honest envelope uses the production calldata encoder), the order of failures, boundaries (`expiresAt`, `maxCostMicros`). |
| `tests/client.test.ts` (29) | A real loopback HTTP server: every method's method, path, query, body and bearer header and its validated answer; generated and given Idempotency-Keys; local refusal of a bad key or body; retries reuse key and body, wait as asked, stop at the last attempt, skip business refusals; `getMarketSpec` rejects altered bytes, a wrong expectation and non-spec bytes; faucet refusals arrive as `BlinkApiError`; the example's refusals (not local, not chain 84532, missing environment). |
| `tests/anvil/client-agent.test.ts` (2) | The example, unchanged, against the real API, signer, worker and indexer on Anvil. First: the first quote is made to expire while its approval is pending, so the run requotes under a new key, fills once, waits for FINAL (the test proposes YES and finalizes after the challenge window) and redeems (allowance back to 0, balance = faucet - cost + payout). Second: the answer of the fill is lost; exactly three raw transactions leave the agent (approve, fill, redeem). |

Mutation checks (temporary, reverted): removing each of nine checks from `verifySignedQuote` (maker, off-by-one on expiry and on the cost limit, digest, taker, calldata, envelope expiry, domain version, signature signer) fails at least one test each; resending the fill after an unknown outcome fails the Anvil test, and ignoring an expired quote fails the other.

## Differences from the brief and fixes found on the way

- **Branch** is `ws/t15-client` (the dispatch), not `ws/t15-client-sdk`.
- **Dependencies:** `packages/client` now depends on `viem` and `ox` (both already in the lockfile through viem), the latter only for the synchronous signature recovery.
- **`ErrorCode` gained `FAUCET_PENDING` and `FAUCET_NOT_ALLOWED`.** The faucet service (Task 13) answers with them, but they were not in the shared enum, so `ApiError.parse` made the client throw a `ZodError` instead of `BlinkApiError` for a pending or refused faucet claim. This is the one behavior fix outside the SDK itself.
- **`getMarketSpec(ref, specHash)`** takes the hash the caller trusts; the brief only said "verifies keccak256(bytes) = specHash".
- **Retries are on by default** (3 attempts), which also applies to the platform agents in the worker; set `maxAttempts: 1` to turn them off.
- **The Anvil test of the example** was not in the brief's file list (it says the example runs in Task 16's harness); it is there so the example is proven before the harness exists.
- The example reaches the client by a relative path (`../../packages/client/src/index.ts`) because `examples/` is not a workspace package; an outside agent imports `@blink/client`.

## Verification

Run on 2026-10-15 in the task worktree against a local Anvil with chain ID 84532. No network beyond loopback, no real key, no deployment.

- `pnpm check`: exit 0, 537 Node tests (42 new: 13 in `client-verify-quote`, 29 in `client`), typecheck of the repository and the web app (now including `examples/`), contract compilation, package boundaries.
- `pnpm build`: exit 0 (the client's `viem` and `ox` dependencies and the `@blink/schemas` type additions are compatible with the web build).
- `pnpm build:services && pnpm test:service-build`: exit 0, 5 bundle tests (the worker bundle includes `@blink/client`, now with `viem` and `ox`).
- `pnpm test:anvil`: exit 0, 46 tests (2 new in `tests/anvil/client-agent.test.ts`).
- `pnpm test:postgres`: not run. Nothing here touches a migration, a store or a lock; the example's database-backed paths ran on PGlite with the production roles.

## Remaining limits and open items

- **Task 16** will run the example as a process against the full harness (including the real keeper finalization); the Anvil test here finalizes the market with a direct, permissionless `finalizeUnchallenged`.
- The example submits a fixed probability (a real forecaster derives it from evidence) and buys a fixed 10 YES shares with a 0.9 bUSD per share limit.
- Request inputs are `unknown` at the type level (validated at run time). Typing them would break `tests/platform-forecaster.test.ts`, which passes `unknown` through, so it was left for a later change.
- A network failure (no answer at all) is not retried by the client; a caller that needs it can repeat the call with the key it chose.
- `getQuote` has a method and a test but the example does not call it: for a POST the verified envelope is the source of truth, and `consumed(digest)` is read from the chain.
