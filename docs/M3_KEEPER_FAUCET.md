# M3 keeper finalization and test-asset faucet

Task 13 delivers the faucet and permissionless keeper slice of M3. It does not mark the full milestone complete.

`POST /v1/faucet/claims` is registered in trading mode. It requires `faucet:claim`, a verified wallet, the configured deployment, and an indexed taker allowlist entry. The request body contains only `deploymentId`; the service derives the wallet and fixed `1000000000` token-micro amount. Operator/path/key idempotency includes the authenticated key in its payload hash and replays a successful response before current window checks. A transaction-scoped advisory lock on a stable hash of the deployment/address pair serializes admission across API keys; the API has only INSERT/SELECT on claims and guards. QUEUED, SUBMITTED and UNKNOWN block another claim. Success starts the rolling 24-hour window at the receipt block timestamp; `Retry-After` rounds up the remaining seconds. The exact 24-hour boundary admits a new claim.

A claim, MINT intent, canonical keccak256 sign request and `faucet.mint` job commit atomically. The worker uses a bearer-authenticated restricted signer, then atomically queues `tx.dispatch` and marks SUBMITTED. UNKNOWN keeps the same request; rejection fails the claim. Dispatch observations set SUCCEEDED on successful inclusion, FAILED on reverted receipts, and restore pending state when an inclusion reorgs. Settlement holds the intent/attempt locks and checks the observed attempt version, so a stale observer cannot overwrite a newer receipt outcome.

The keeper reads `chain.markets` and the cursor's block timestamp. PROPOSED becomes eligible at exactly `proposedAt + challengeSeconds`; every non-FINAL market becomes eligible for timeout at exactly `hardDeadline`. A 15-second `schedulePeriodic` job does not rely on the one-time `market.indexed` event. Each market/kind has one economic intent, including across UNKNOWN retries. Before signing, the worker reads `getMarket` at the latest block. Under the same request row lock as the signer, it cancels work for FINAL markets only when no signing plan or artifact exists. A committed first-version plan keeps the intent live even if signing crashed before persisting bytes: periodic keeper recovery re-requests the same sign request, reuses the identical plan/nonce, and dispatches it. Already signed bytes still dispatch. A finalized revert consumes the allocated nonce and ends the intent FAILED. A gas-estimation rejection records `keeper.manual_required`; direct permissionless contract calls remain available. A pending unchallenged transaction that crosses the hard deadline can revert, while a separate timeout intent is created normally. Economic-intent FAILED follows the existing dispatcher's finalized-revert policy; nonfinal receipt observations remain reorg-aware.

## Runtime configuration

The API retains its existing trading configuration and uses `BLINK_DEPLOYMENT_ID`. Worker execution stays disabled unless `SIGNER_URL` or `WORKER_SIGNER_CALLER_TOKEN` is present; partial execution configuration fails startup. Enabling it requires all of:

- `BLINK_DEPLOYMENT_ID`
- `SIGNER_URL`
- `WORKER_SIGNER_CALLER_TOKEN` (a signer caller authorized for faucet and keeper; authorize other execution roles when their jobs are enabled)
- `BASE_SEPOLIA_RPC_URL`

The worker uses `WORKER_DATABASE_URL` and its existing enabled flag. The chain reader refuses 8453 with `MAINNET_REFUSED` and every other chain except 84532; broadcast and receipt RPC calls are guarded too. API/worker execution startup rejects a test-clock offset. No API or worker module loads private keys. Ordinary job retries are bounded at the existing queue maximum of 10; every 15 seconds, exhausted jobs can resume their same persisted intent/request in a new job bucket. Terminal FINALIZED/FAILED mint intents with QUEUED/SUBMITTED/UNKNOWN claims also get dispatch recovery work. The dispatcher replays the persisted outcome and settles the claim idempotently; a receipt timestamp lookup can retry without another intent or signature. Terminal intents are excluded from faucet signing recovery. Other worker handlers run without execution configuration.

## Migration and integration adjustments

Only new migration `0013_execution.sql` is added. It creates claims and deployment/address guards, grants the API insertion/reading and the worker claim-status updates, and expands Task 8's API policy to first-version MINT requests alongside maker quotes. The API still cannot request keeper/trader intents, replacements, read raw signed transactions, or update signing records.

Admission uses `pg_advisory_xact_lock(hashtextextended(...))` over a JSON-encoded deployment/address pair before inserting the guard. Hash collisions only serialize unrelated addresses; no UPDATE grant is needed on guards. PostgreSQL requires UPDATE privilege for request row locks: the worker retains only UPDATE(updated_at) on sign requests as the minimum privilege needed to share the signer’s request lock and serialize cancellation against plan allocation. No request payload or state UPDATE privilege is added. The worker also receives only the deployment columns its composition reads. The signer accepts an UNKNOWN first-version transaction intent and marks it SIGNED upon successful retry; quote signing policy is unchanged. Existing signing-permission tests now assert the added faucet scope.

## Verification

Fix round 1 addresses all three Important review findings; the results below include the fix-round verification.

- `pnpm check`: passed, 447 unit/integration tests, typechecks, contract compilation and package boundaries.
- `pnpm build`: ordinary build blocked by existing Google Fonts downloads under the no-external-network constraint. The same Turbopack build passed with `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` and installed local font bytes served on loopback. This verifies source exports and application compilation, not production font downloads or font appearance.
- `pnpm build:services && pnpm test:service-build`: passed, all five bundle smoke tests.
- `pnpm test:anvil`: passed, 41 tests. Task 13 exercises the real API, signer HTTP service, dispatcher and indexer; successful mint, mint reorg, signer outage, proposal finalization, late unchallenged revert, timeout finalization, reverted mint, same-intent dead-job recovery, allocated-plan signing recovery after another caller finalizes, and both terminal faucet outcomes after ten failed settlement attempts.
- `TEST_POSTGRES_ADMIN_URL=... pnpm test:postgres`: passed, 27 tests, including API guard-key UPDATE denial and five concurrent claims with two API keys sharing a wallet producing exactly one 202 and four FAUCET_PENDING responses.

The PostgreSQL suite uses isolated random databases; Anvil uses chain ID 84532 and public fixture accounts. Anvil's finalized block stays at zero: finalized transitions use an explicit fake finalized tag with real receipts. Anvil gas caps are raised only in test configuration; production caps remain unchanged. No deployment, external provider, real key, live signing, or paid service was used.
