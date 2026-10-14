# M3 keeper finalization and test-asset faucet

中文摘要：完成每個核准錢包每滾動 24 小時領取 1,000 bUSD，以及依鏈上時間自動結算的 keeper；私鑰僅存在 signer。

Task 13 delivers the faucet and permissionless keeper slice of M3. It does not mark the full milestone complete.

`POST /v1/faucet/claims` is registered in trading mode. It requires `faucet:claim`, a verified wallet, the configured deployment, and an indexed taker allowlist entry. The request body contains only `deploymentId`; the service derives the wallet and fixed `1000000000` token-micro amount. Operator/path/key idempotency includes the authenticated key in its payload hash and replays a successful response before current window checks. A deployment/address row lock serializes admission across API keys. QUEUED, SUBMITTED and UNKNOWN block another claim. Success starts the rolling 24-hour window at the receipt block timestamp; `Retry-After` rounds up the remaining seconds. The exact 24-hour boundary admits a new claim.

A claim, MINT intent, canonical keccak256 sign request and `faucet.mint` job commit atomically. The worker uses a bearer-authenticated restricted signer, then atomically queues `tx.dispatch` and marks SUBMITTED. UNKNOWN keeps the same request; rejection fails the claim. Dispatch observations set SUCCEEDED on successful inclusion, FAILED on reverted receipts, and restore pending state when an inclusion reorgs. Settlement holds the intent/attempt locks and checks the observed attempt version, so a stale observer cannot overwrite a newer receipt outcome.

The keeper reads `chain.markets` and the cursor's block timestamp. PROPOSED becomes eligible at exactly `proposedAt + challengeSeconds`; every non-FINAL market becomes eligible for timeout at exactly `hardDeadline`. A 15-second `schedulePeriodic` job does not rely on the one-time `market.indexed` event. Each market/kind has one economic intent, including across UNKNOWN retries. Before signing, the worker reads `getMarket` at the latest block and cancels unsigned work for FINAL markets. Already signed bytes still dispatch to consume their allocated nonce. A gas-estimation rejection records `keeper.manual_required`; direct permissionless contract calls remain available. A pending unchallenged transaction that crosses the hard deadline can revert, while a separate timeout intent is created normally. Economic-intent FAILED follows the existing dispatcher's finalized-revert policy; nonfinal receipt observations remain reorg-aware.

## Runtime configuration

The API retains its existing trading configuration and uses `BLINK_DEPLOYMENT_ID`. Worker execution stays disabled unless `SIGNER_URL` or `WORKER_SIGNER_CALLER_TOKEN` is present; partial execution configuration fails startup. Enabling it requires all of:

- `BLINK_DEPLOYMENT_ID`
- `SIGNER_URL`
- `WORKER_SIGNER_CALLER_TOKEN` (a signer caller authorized for faucet and keeper; authorize other execution roles when their jobs are enabled)
- `BASE_SEPOLIA_RPC_URL`

The worker uses `WORKER_DATABASE_URL` and its existing enabled flag. The chain reader refuses 8453 with `MAINNET_REFUSED` and every other chain except 84532; broadcast and receipt RPC calls are guarded too. API/worker execution startup rejects a test-clock offset. No API or worker module loads private keys. Ordinary job retries are bounded at the existing queue maximum of 10; every 15 seconds, exhausted jobs can resume their same persisted intent/request in a new job bucket. Other worker handlers run without execution configuration.

## Migration and integration adjustments

Only new migration `0013_execution.sql` is added. It creates claims and deployment/address guards, grants the API insertion/reading and the worker claim-status updates, and expands Task 8's API policy to first-version MINT requests alongside maker quotes. The API still cannot request keeper/trader intents, replacements, read raw signed transactions, or update signing records.

PostgreSQL requires UPDATE privilege for row locks: the API receives column-scoped UPDATE(address) on guards; the worker receives UPDATE(updated_at) on sign requests to serialize cancellation against signing. The worker also receives only the deployment columns its composition reads. The signer accepts an UNKNOWN first-version transaction intent and marks it SIGNED upon successful retry; quote signing policy is unchanged. Existing signing-permission tests now assert the added faucet scope.

## Verification

- `pnpm check`: passed, 447 unit/integration tests, typechecks, contract compilation and package boundaries.
- `pnpm build`: ordinary build blocked by existing Google Fonts downloads under the no-external-network constraint. The same Turbopack build passed with `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` and installed local font bytes served on loopback. This verifies source exports and application compilation, not production font downloads or font appearance.
- `pnpm build:services && pnpm test:service-build`: passed, all five bundle smoke tests.
- `pnpm test:anvil`: passed, 38 tests. Task 13 exercises the real API, signer HTTP service, dispatcher and indexer; successful mint, mint reorg, signer outage, proposal finalization, late unchallenged revert, timeout finalization, reverted mint, and same-intent dead-job recovery.
- `TEST_POSTGRES_ADMIN_URL=... pnpm test:postgres`: passed, 26 tests, including five concurrent claims with two API keys sharing a wallet producing exactly one 202 and four FAUCET_PENDING responses.

The PostgreSQL suite uses isolated random databases; Anvil uses chain ID 84532 and public fixture accounts. Anvil's finalized block stays at zero: finalized transitions use an explicit fake finalized tag with real receipts. Anvil gas caps are raised only in test configuration; production caps remain unchanged. No deployment, external provider, real key, live signing, or paid service was used.
