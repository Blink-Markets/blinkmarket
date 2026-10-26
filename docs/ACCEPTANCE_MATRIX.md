# Acceptance evidence — spec §17

> Historical (v0.1): this matrix maps spec §17 of the v0.1 MVP specification to the v0.1 tests. P2 removed much of what it cites (the v0.1 contract, signer, RFQ pricing, trader and the three REPLAY scenarios). The current evidence for the autonomous design is in [P1](P1_PROTOCOL_CONTRACTS.md) and [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md#verification); a new matrix for the design's §2.1 success criteria belongs to P3.

Commands run from the repository root. Node suites use the installed Node 22 and
`tsx`; contract suites use the pinned Foundry wrapper. Real PostgreSQL commands
require `TEST_POSTGRES_ADMIN_URL` pointing to the dedicated local/CI administrator
database; each test creates and drops its own random database. Anvil tests start
their own local chain with chain ID 84532.

This matrix identifies coverage, not a declaration that public Alpha is complete.
The integrated Task 16b harness (`tests/alpha/local-alpha.test.ts`, `pnpm alpha:local`) exercises normal YES, disputed NO and timeout INVALID REPLAY lifecycles, the local example agent and worker keeper finalization, plus canonical rebuild and drop/re-index restore drills. Recorded local results and limits are in [Local Alpha](M5_LOCAL_ALPHA.md); they do not prove hosted availability or public-network finality.
[Internal trader](M3_INTERNAL_TRADER.md) and [client SDK](M5_CLIENT_SDK.md) evidence are separate deliveries. Automated client and harness tests do not prove external usability.

## §17.1 Contract cases

| Case | Behavior / test file | Reproducible command |
| --- | --- | --- |
| C01 | YES collateral and opposite shares; `contracts/test/BlinkMarket.t.sol`, `test_C01_yesAccounting` | `pnpm test:contracts --match-test test_C01` |
| C02 | NO-side arithmetic; same file, `test_C02_noAccounting` | `pnpm test:contracts --match-test test_C02` |
| C03 | Wrong chain/verifier/spec/taker/maker; same file, `test_C03_wrongPayloadAndDomain` | `pnpm test:contracts --match-test test_C03` |
| C04 | Consumed/cancelled/old epoch; same file, `test_C04_C09_consumedCancelledEpoch` | `pnpm test:contracts --match-test test_C04_C09` |
| C05 | expiresAt/closeAt/validAfter boundaries; same file, `test_C05_quoteBoundaries` | `pnpm test:contracts --match-test test_C05` |
| C06 | Quantity, price, side and cumulative caps; same file, `test_C06_badAmountsCapsAndLifetime`, `test_marketCapAcrossAccountsAndPerMarketPause` | `pnpm test:contracts` |
| C07 | Maker/taker balance and allowance rollback; same file, `test_C07_balanceAndAllowanceRollback`; hostile token rollback in `contracts/test/Adversarial.t.sol` | `pnpm test:contracts` |
| C08 | Competing quotes serialize against funds; `contracts/test/BlinkMarket.t.sol`, `test_C08_competingQuotes` | `pnpm test:contracts --match-test test_C08` |
| C09 | Cancel/fill chain ordering; same file, `test_C04_C09_consumedCancelledEpoch` | `pnpm test:contracts --match-test test_C04_C09` |
| C10 | YES/NO/INVALID payout, repeat redeem; same file, `testFuzz_C10_redemption`, `test_bothSidesRedeemAndRevocationRejectsNewFill` | `pnpm test:contracts` |
| C11 | Permissionless INVALID from all nonfinal states; same file, `test_C11_timeoutAllNonFinalStates` | `pnpm test:contracts --match-test test_C11` |
| C12 | Challenge/proposal/hard deadline and late finalization; same file, both `test_C12_*` tests | `pnpm test:contracts --match-test test_C12` |
| C13 | Pause/allowlist revocation stop new fills, preserve exits; same file, `test_C13_pauseAndRevocationDoNotBlockRedemption`, `test_bothSidesRedeemAndRevocationRejectsNewFill` | `pnpm test:contracts` |
| C14 | Role matrix, fixed spec, escrow isolation; same file, `test_C14_rolesConstructorAndDonations`; `contracts/test/Adversarial.t.sol`, `test_unauthorizedRoleMatrix` | `pnpm test:contracts` |
| C15 | Arbitrary sequences preserve ghost ledger and solvency; `contracts/test/Invariant.t.sol`, `invariant_ghostLedgerAndSolvency`, `testFuzz_multiUserSettlement` | `pnpm test:contracts`; `pnpm test:contracts:seeds` |

## §17.2 API / worker / indexer cases

| Case | Existing test files and evidence | Reproducible command |
| --- | --- | --- |
| S01 | `tests/preparation.test.ts`, `tests/forecasts.test.ts`, `tests/rfq.test.ts`, `tests/faucet.test.ts`: candidate/forecast/quote/mint replay creates one result; PostgreSQL RFQ/faucet races prove concurrent replay | `node --import tsx --test tests/preparation.test.ts tests/forecasts.test.ts tests/rfq.test.ts tests/faucet.test.ts`; `pnpm test:postgres` |
| S02 | Same four suites: key reuse with changed payload returns 409 and preserves original result | Same command as S01 |
| S03 | `tests/budget-ledger.test.ts`; `tests/postgres/jobs-budgets.test.ts`: real concurrent daily/question budget admission | `node --import tsx --test tests/budget-ledger.test.ts`; `pnpm test:postgres` |
| S04 | `tests/budgeted-model.test.ts`, `tests/discovery.test.ts`, `tests/worker-runtime.test.ts`: UNKNOWN retains full reservation, bounded costed retries, durable model answers | `node --import tsx --test tests/budgeted-model.test.ts tests/discovery.test.ts tests/worker-runtime.test.ts` |
| S05 | `tests/identity.test.ts`: invalid binding/signature/domain, expired/revoked key and scopes, including cached mutations | `node --import tsx --test tests/identity.test.ts` |
| S06 | `tests/discovery.test.ts`: hostile document; `tests/allowlist-fetcher.test.ts`: SSRF/redirect rules; `tests/signing-policy.test.ts`, `tests/signer.test.ts`: selector/value/destination and trusted request reload | `node --import tsx --test tests/discovery.test.ts tests/allowlist-fetcher.test.ts tests/signing-policy.test.ts tests/signer.test.ts` |
| S07 | `tests/tx-dispatcher.test.ts`, `tests/signer.test.ts`, `tests/faucet-worker.test.ts`, `tests/keeper.test.ts`: unknown receipt/restart reconciliation, stable intent/sign request/nonce; `tests/anvil/signer-dispatch.test.ts` exercises real RPC | `node --import tsx --test tests/tx-dispatcher.test.ts tests/signer.test.ts tests/faucet-worker.test.ts tests/keeper.test.ts`; `pnpm test:anvil` |
| S08 | `tests/tx-tracking.test.ts`, `tests/chain-indexer.test.ts`, `tests/quote-reconcile.test.ts`; `tests/anvil/chain-indexer.test.ts`, `tests/anvil/rfq.test.ts`: replacement, duplicate logs, rollback/rebuild and reopened collateral | `node --import tsx --test tests/tx-tracking.test.ts tests/chain-indexer.test.ts tests/quote-reconcile.test.ts`; `pnpm test:anvil` |
| S09 | `tests/preparation.test.ts`: corrupt source bytes fail approval; `tests/m0.test.ts`, `tests/approval-policy.test.ts`, `tests/file-object-store.test.ts`: spec byte/hash tampering and exact content-addressed bytes; `tests/market-read.test.ts`: a tampered archived spec is refused on read with `SPEC_UNAVAILABLE` and an audit row; `tests/trading-ops.test.ts`, `a SPEC_INTEGRITY gate stops new quotes...`: an operator-closed SPEC_INTEGRITY gate answers `NO_QUOTE`/`SPEC_INTEGRITY` and leaves markets, quotes, reservations and sign requests unchanged (the fixture holds no positions, so position preservation is not exercised). **Partial:** no automatic detector closes the gate | `node --import tsx --test tests/preparation.test.ts tests/m0.test.ts tests/approval-policy.test.ts tests/file-object-store.test.ts tests/market-read.test.ts tests/trading-ops.test.ts` |
| S10 | `tests/forecasts.test.ts`, `tests/rfq.test.ts`, `tests/trading-ops.test.ts`: stale snapshot, early-announcement gate, indexer lag and reasons; `tests/health.test.ts`: degraded deployment health | `node --import tsx --test tests/forecasts.test.ts tests/rfq.test.ts tests/trading-ops.test.ts tests/health.test.ts` |
| S11 | `tests/evaluation.test.ts`, `tests/market-read.test.ts`, `tests/web-sample-markets.test.ts`: mode is preserved, REPLAY excluded from LIVE event scores; `tests/alpha/local-alpha.test.ts` and `scripts/local-alpha.ts` assert no LIVE market/score rows and zero LIVE event count | `node --import tsx --test tests/evaluation.test.ts tests/market-read.test.ts tests/web-sample-markets.test.ts`; `pnpm alpha:local` |
| S12 | `tests/identity.test.ts`: invited client binds wallet through HTTP; `tests/discovery.test.ts`, `tests/platform-forecaster.test.ts`: platform agents use public API without DB mutation privileges. `tests/client.test.ts`, `tests/client-verify-quote.test.ts` and `tests/anvil/client-agent.test.ts` cover the SDK and example; the integrated Alpha harness runs `runAgent` in process through binding, forecast, faucet, verified RFQ, exact approval, fill tracking and redemption with keeper finalization for normal/timeout cases | `node --import tsx --test tests/identity.test.ts tests/discovery.test.ts tests/platform-forecaster.test.ts tests/client.test.ts tests/client-verify-quote.test.ts`; `pnpm test:anvil`; `pnpm alpha:local` |

S09 is partially covered. Tested: separate source/archive integrity checks, the
read-time refusal of a tampered spec, and the operator response (closing a
SPEC_INTEGRITY gate stops new quotes without rewriting settlement state). Not
implemented or tested: an automatic background detector that notices stored-spec
corruption and closes that gate. Detection and gate closure remain a manual drill.
The generic gate path is also exercised with OUTCOME_KNOWN and OPERATOR_PAUSE in
`tests/rfq.test.ts` and `tests/trading-ops.test.ts`.

## §17.3 Remaining public Alpha work

- Deploy API, web, workers, signer and indexer with real least-privilege logins,
  private signer access, backups and monitoring. Local service tests do not
  establish deployed availability.
- Publish Base Sepolia source/ABI and verify a real deployment manifest against
  API/web. No real keys or public-chain transactions are part of these tests.
- Repeat the implemented local Alpha scenarios and projection restore drills as regression checks; separately rehearse hosted backups and restoration. The local harness is not a full operational restore drill.
- Approve one eligible LIVE event with reviewed official sources and timestamped
  forecasts; until then label the product a restricted preview.
- Have a non-team invited operator follow the docs and example to submit forecasts
  and complete test trades. Record external participation separately from a
  non-implementer usability review.
- Review the deployed UI for test-asset, no-early-exit, trusted-arbitration,
  INVALID-payout and transaction-confirmation disclosures. Wallet/admin UI is
  outside the current backend plan.
- Rehearse real budget/pause/RPC/keeper alerts, operator response and backup
  restoration. Automated fault tests and projection rebuilds cover only part of
  the operational drill.
- Publish the short demo video, current README/OpenAPI/example and feedback entry.

Operational endpoint regression commands: `node --import tsx --test
tests/health.test.ts` and `pnpm test:postgres` (includes
`tests/postgres/health.test.ts`). Run `pnpm check`, `pnpm build` and
`pnpm build:services && pnpm test:service-build` after shared contract changes.
