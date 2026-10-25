# P1 autonomous protocol contracts delivery

P1 delivers the on-chain protocol that agents run on their own:
- identity and role stakes;
- market-creation challenges;
- multi-maker RFQ with full collateral;
- layered settlement;
- credit;
- juror stakes and governance;
- a self-serve faucet.

The existing v0.1 contracts and off-chain services remain in place. This stage involves no deployment, no signing and no broadcast transactions.

P2 adds the deployment tooling, the production parameters, the API, adapters and indexer, and the new ABI. P3 adds the autonomous agent drill.

## Contracts and deployment order

Every constructor is restricted to Base Sepolia (84532). The shared contracts are deployed first:
- `BlinkFaucet`, which internally creates the unmodified `BlinkTestUSD` and `BlinkToken`;
- `FixedPriceSource`;
- `BlinkGovernor`, which uses timestamp snapshots.

The faucet is the immutable minter of both test assets.

For each generation, the four CREATE addresses of the same deployer are predicted first. The contracts are then deployed in nonce order:

| Order | Contract | Responsibility |
| --- | --- | --- |
| n | `BlinkRegistry` | identity, bUSD role stakes, exit locks, credit and import from the previous generation, Params fixed at deployment |
| n+1 | `BlinkJurors` | platform-token stake snapshots, cooldown exits, vote locks, slash/reward, the seven-day bUSD stream |
| n+2 | `BlinkMarkets` | question templates, creation windows and bonds, maker collateral, EIP-712 RFQ, fees, positions and redemption |
| n+3 | `BlinkResolution` | proposals, creation and result challenges, commit/reveal, appeals, per-vote settlement and the hard deadline |

Each constructor checks its own predicted address, and cross-contract permissions are fixed in the constructors.
- There is no owner, admin, pause, initializer, bind or upgrade.
- Settlement hooks may only be called by the resolution contract of the same generation.
- Governance can only propose `adoptSuccessor`. After the proposal passes and the adoption delay elapses, it adopts the next generation's registry. Governance cannot change an old market's rules, results or custodied assets.
- During an incident, the platform can stop API relaying, publish announcements and release a new generation. It cannot pause the on-chain contracts.

## Parameters and asset units

`Params` lives in the registry and has no setter after deployment. Changing an economic parameter requires deploying a new generation.

The test values are in `ProtocolBase.defaultParams()` and are not the production parameters.

Units:
- bUSD has 6 decimals. Each complete YES/NO pair is fully collateralized with `UNIT = 1_000_000`.
- The platform token has 18 decimals.
- The BPS denominator is 10,000.

| Parameter group | Meaning |
| --- | --- |
| `registrationFee`, `minRoleStake`, `roleExitCooldown` | Non-refundable registration fee, the minimum bUSD stake for each business role, and the exit cooldown. Withdrawal is blocked while obligations are outstanding. |
| `feeBps`, the five `*ShareBps`, `keeperTipBps` | Fee on the taker's payment. The treasury, creator, resolution, juror and bounty shares sum to 10,000. The keeper tip is deducted from the resolution share. Distribution rounding remainders go to the treasury. |
| `creationBondBps`, `proposerBondBps`, `challengeBondBps`, `jurorBondCutBps` | Bonds are computed on the fixed `maxPairs × UNIT`. They do not fall with fills or open interest. The juror cut of a losing bond is paid in bUSD. The appeal bond doubles with each appeal. |
| `maxCreditDiscountBps`, `creditDiscountStepBps`, `creditMultiplierStepBps`, `maxCreditMultiplierBps`, `creatorExposureMultiple` | The credit discount has a floor and relaxes creator exposure. Credit neither amplifies voting weight nor pays money directly. |
| `creationWindow`, `firstUseExtraWindow`, `resultChallengeWindow`, `minResultChallengeWindow`, `challengeWindowStepSeconds` | Creation and result-challenge windows for the three question classes. A template that has not passed review adds an extra window to every market. At proposal time, credit sets that proposal's result window. |
| `commitSeconds`, `revealSeconds`, `appealSeconds`, `maxRounds`, `quorumBps` | Commit, reveal and appeal deadlines, and at most four appeal levels. A tie or a missing quorum reopens the same level. `currentRound` counts reopenings; `appealRound` counts only appeals. |
| `nonRevealSlashBps`, `incoherentSlashBps`, `roleSlashBps`, `jurorUnstakeCooldown` | Penalties for not revealing, for incoherent votes and for the losing side's business stake. The juror exit cooldown and vote-unlock conditions. |
| `securityMultipleBps`, `maxMarketPairs`, `maxTakerShares`, `maxFillShares` | The global security multiple checked at creation and exit, and the per-market, per-taker and per-fill limits: `openPayoutTotal × securityMultipleBps <= attackCostMicros × 10000`. |
| `creditHalfLife`, `creditUnitMicros`, `creditGainCap`, `creditLossMultiplier` | Credit is computed on the maximum payout of finalized markets. Each gain is capped, credit halves every period, and losses weigh more. Fill volume does not score. |
| `classCCreditThreshold`, `roundCreditThreshold`, `phaseInFinalizedMarkets` | Credit thresholds for class-C market creation and for each appeal level. They switch on after the generation has finalized the given number of markets. |
| `importDiscountBps`, `replayAllowed` | Discounted credit import from the previous generation, and the deployment-level REPLAY switch. |

`attackCostMicros` is half of the total active juror stake converted to bUSD at the price source.

Example with the test defaults:
- the price is 1 bUSD per platform token and the security multiple is 20,000;
- a stake of 1,000 tokens gives an attack cost of 500 bUSD;
- so the global open payout is capped at 250 bUSD at that moment.

A slash can break this relation temporarily; see the limitations below.

Voting weight is `min(snapshot stake, current active stake + pending unstake)`. Credit is only a threshold and does not amplify weight.

The snapshot is taken one second before the round starts, so stake added later does not count for that round.

Each round fixes its credit threshold at its start, from the `finalizedCount` at that moment:
- below `phaseInFinalizedMarkets` the threshold is 0;
- otherwise it is that level's `roundCreditThreshold`.

Other markets finalizing does not change the threshold of a round that has already started (R41). A commit still compares the juror's current credit with the fixed threshold; historical credit is not stored.

Market-creation spec hashes are deduplicated per creator, so another address cannot claim the hash of the same question first.

Market creation must satisfy `hardDeadline - proposalDeadline > resultChallengeWindow[cls] + maxRounds × (commitSeconds + revealSeconds + appealSeconds)` (R39).

For each round, `appealEnd = revealEnd + appealSeconds`; a late `settleRound` does not extend the appeal deadline. An appeal is rejected if `now + commitSeconds + revealSeconds >= hardDeadline`. The previous round's result can still finalize on its original appeal deadline.

`fillQuote` accepts signatures from registered makers that hold the MAKER role, whether they are EOAs or ERC-1271 contract wallets. It verifies them with OpenZeppelin 5.6.1 `SignatureChecker.isValidSignatureNowCalldata`.
- EOAs keep the 65-byte, low-s ECDSA rules.
- For a maker with code, it staticcalls `isValidSignature(digest, signature)` and accepts only the ERC-1271 magic value `0x1626ba7e`. A rejection or a revert reports the existing `InvalidSignature()`.
- Taker binding, full collateral, fees, limits and digest-keyed replay protection keep their existing rules.

Platform-token rewards and penalties for revealed votes in rounds that were not reopened are settled only after the dispute finalizes. Coherence is judged against the final option (R40).
- After an appeal overturns a result, the original round's correct minority is not slashed for incoherence. It shares that level's pool by revealed weight on the round's final option.
- The wrong majority is penalized by `incoherentSlashBps`.
- Vote locks are kept until per-vote settlement.
- Unrevealed votes can be slashed as soon as the round ends.

The rules for reopened rounds, timeouts and crediting only the last round are unchanged.

## Trust assumptions

"Under publicly stated assumptions, honesty is the provably best strategy."
- The final security assumption is that **the slashable juror stake inside the snapshot is an honest majority**. Stake cannot unconditionally prevent off-chain bribery or sybils.
- The protocol needs a conservative platform-token price that resists short-term manipulation, and enough platform-token value and liquidity.
- An attack harms market trust and the value of the staked platform tokens. This is an economic assumption, not a price guarantee proven by local tests.
- During a cold start, when stake is small, market capacity must also be small.

See [the approved design §5.12](superpowers/specs/2026-10-23-autonomous-market-design.md#512-trust-assumptions-must-be-stated-publicly-decided).

## Testnet scope

- Each address can claim 1,000 bUSD and 1,000 platform tokens from the faucet every 24 hours. Addresses can be created in bulk, so the faucet is not sybil-resistant asset issuance.
- `FixedPriceSource` is an immutable fixed test price. It has no real liquidity and is not a manipulation-resistant market quote.
- The test tokens have no real value.
- No external security audit or mainnet economic calibration has been done.

## Known limitations

- An ERC-1271 wallet's answer is read at fill time. A wallet can change its answer, so a signature that was valid earlier is not guaranteed to be valid at fill time.
- Some assets may stay in `jurors.undistributedSlashed`, and there is no recovery policy for them (Task 7 minor #4). Tests confirm that the retained assets remain fully backed. The assets are:
  - platform tokens slashed before a timeout;
  - the pool of a round in which nobody revealed the final option;
  - distribution rounding remainders.
- Each vote's slash, reward, credit and unlock, and each market's fee distribution, needs a permissionless keeper transaction. No privileged platform keeper does this automatically.
  - After finalization, all losers of a level are settled first, then coherent claims.
  - Non-revealers of the last round who were settled early must have their credit settled again after finalization.
- R17 checks the global security bound only in `createMarket` and `requestUnstake`. A slash cannot be refused, so it can push the attack cost below what the open payout needs until markets close. The invariant checks that neither operation succeeds out of bounds; it does not claim the bound always holds after a slash.
- An exact YES/NO tie reopens the round, and revealed voters are not slashed.
  - A cartel holding about 50% of the stake can keep stalling until hardDeadline, after which `finalizeTimeout` makes the market INVALID.
  - Challenger-side bonds are still forfeited.
  - The tie rule is unchanged (minor #7/R38).
- R39's creation reserve covers the initial challenge and every appeal level. Reopened rounds can still use up time, and keeper delays can miss a deadline. The protocol cannot claim that markets finalize normally under arbitrary delays.
- R41 fixes the credit threshold but accepts current credit.
  - The juror's credit from other rounds settled late, and time decay, can still change commit eligibility.
  - A juror near the threshold can lose eligibility to decay during the commit window.
  - The quorum denominator is still the total snapshot stake, so the honest-majority assumption must cover the stake that meets the threshold and can actually take part.
- Quorum uses committed weight, which includes stake that committed but did not reveal. A non-revealing whale can make up the quorum for a few revealed voters and is slashed only afterwards (minor #2).
- A sybil self-dispute can still pay a losing bond cut or a role slash to build credit for other addresses. A registration fee and distinct addresses are not a trusted identity (minor #5).
- The snapshot for a reopening or an appeal is one second before the call, so the caller can choose the snapshot moment within the allowed time (minor #3).
- When a creation challenge is upheld, the held creator bond goes to the original challenger under R9. Challenger-side appellants do not share that creator bond (minor #1).
- The conflict check uses current positions. In this version positions cannot be transferred, cannot be redeemed before FINAL, and cannot be filled further during a dispute, so transfer or early redemption cannot evade it (minor #6). Adding position transfers in the future requires a new review.
- `previousRegistry` is trusted as the contract named at deployment. Deployers should use the generation adopted by governance and check the address. The credit import itself does not check the governance vote.
- Reward notifications at zero juror stake, and stream time that passes at zero stake, go to the treasury (R21); they are not gifted to the next staker. The seven-day stream still has integer rounding.
- Maker credit is deferred to P2, because existing on-chain signals cannot reliably tell wash trading apart. In P1, fill volume adds no creator, maker or taker credit.

## Verification

Which tests are integration evidence:
- `Lifecycle`, `ProtocolInvariant`, `ProtocolAdversarial` and the `ProtocolFinalReview` regressions use `ProtocolBase.deployGeneration` to wire the four real contracts. The token-callback adversarial tests replace the collateral.
- Other unit tests contain stubs, such as `StubReporter` in `Registry` and `DisputeMarkets` with a settable finalized count in `ResolutionDispute`. They should not be treated as cross-market integration evidence.

The lifecycle covers:
- normal fills by two makers with a full faucet reconciliation;
- a dispute with appeals;
- an upheld creation challenge;
- a hard-deadline INVALID;
- governance adopting a real second generation with a non-zero credit import;
- the creator's FINAL accounting after a creation dispute times out or is dismissed.

`ProtocolFinalReviewTest` additionally verifies:
- under the shortest legal schedule, the latest proposal and challenge and every appeal can still finalize before hardDeadline;
- a low-priced losing position cannot get the INVALID half payout;
- a late settlement does not extend the appeal window;
- an appeal that cannot complete is rejected;
- per-vote platform-token, stake and lock accounting after an overturn;
- the fixed-threshold and current-credit boundary when a real third market finalizes during an appeal's commit period.

`ProtocolInvariantTest` uses an independent ghost ledger.
- It tracks, for two markets: escrow, maker free balance, fees, creation/proposal/challenge/appeal bonds and every address's positions. It also checks the solvency of juror tokens and bUSD rewards.
- Its random calls include registration, stake/unstake, market creation, fills, proposals, challenges, commit/reveal, reopening, per-vote settlement, appeals, time warps, finalization, fee distribution, redemption and reward claims.
- Each run ends by forcing finalization, redemption and vote unlocks, so it does not test only unsettled state.

The adversarial tests cover:
- five token-callback paths and transfer-failure rollback;
- identity laundering;
- the net bUSD profit bound of a 51% stake attack;
- the Task 7 minors #1–#7 listed above.

The ABI test scans privileged function names per R6. The existing Governor tests already reject proposals that change its own settings, such as `setVotingDelay`.

```sh
pnpm test:contracts
pnpm test:contracts:seeds
node --import tsx --test tests/protocol-artifacts.test.ts
pnpm check:contracts
```

Local results after the 2026-10-24 R39–R41 fixes. The focused run passed 7 suites and 109/109 tests, including two 60-committer gas regressions.

| Command | Result |
| --- | --- |
| `pnpm test:contracts` | 17 suites, 247/247 tests pass, 0 fail/skip; v0.1 24, P1 223, of which 8 are new in this round |
| `pnpm test:contracts:seeds` | Ledger and Protocol each run with 0x01 and 0x02; four runs, 12/12 tests pass. Each invariant runs 128 runs × 64 calls with 0 reverts; the eight invariant campaigns total 65,536 calls |
| `node --import tsx --test tests/protocol-artifacts.test.ts` | 1/1 test file passes. It contains two named checks: compilation/EIP-170 and ABI privileged names. This host runner counts per file |
| `pnpm check:contracts` | Passes. All eight concrete P1 runtimes are under 24,576 bytes; the largest is `BlinkResolution` at 20,528 bytes (`BlinkMarkets` 18,394) |

The final verification baseline is main `c500389`, after the R39–R41 fixes merged. The contract commands above gave the same results, and the full `pnpm check` passed 714/714.

Every task was independently reviewed. The whole branch also had a final review, and the final review's fixes had a scoped re-review.

Passing P1 contract tests does not mean P2–P4 or the autonomous service drill are complete.

2026-10-24 P2 Task 13 contract-wallet maker signature addendum: `ContractWalletMakerTest` adds 8 tests. They cover:
- an ERC-1271 fill whose accounting and events match an EOA fill;
- a wrong signer;
- a wallet that rejects or reverts;
- quote cancellation through the wallet and epoch increments;
- digest replay protection;
- rejection of EOA high-s and 64-byte signatures;
- wallet control.

| Command | Result this round |
| --- | --- |
| `pnpm check:contracts` | Passes the EIP-170 check; `BlinkMarkets` runtime is 18,364 bytes, and the largest is still `BlinkResolution` at 20,528 bytes |
| `pnpm test:contracts` | 18 suites, 255/255 tests pass, 0 fail/skip; existing tests unchanged |
| `pnpm test:contracts:seeds` | Ledger and Protocol each run with 0x01 and 0x02; four runs, 12/12 tests pass; the eight invariant campaigns total 65,536 calls with 0 reverts |
| `node --import tsx --test tests/protocol-artifacts.test.ts` | 1/1 test file passes, including the compilation/EIP-170 and ABI privileged-name checks |

A solc comparison of the complete `BlinkMarkets` ABI and storage layout before and after the addendum confirms that neither changed.

This round completes only P2 Task 13. It did not run the full `pnpm check`, off-chain integration or a deployment drill. The independent task review approved it, and it merged to main as `3010c40`, where all 255 contract tests pass.

## Implementation rulings

- `BlinkRegistry.reportLoss` returns before materialising credit when `creditOf` is zero. Zero-decayed losses write no credit storage and emit no event; every credit storage update is now observable through `CreditGained`, `CreditLost` or `CreditImported`. Indexers preserve partial half-life periods exactly as `_materialise` does.

The ruling numbers and minor numbers cited in this document come from the decision record kept during P1 implementation; that record is not stored in the repo. These are the rulings that affect behavior:

| ID | Decision |
| --- | --- |
| §5.1 wallet neutrality (2026-10-24) | A maker may be an EOA or an ERC-1271 contract wallet. `fillQuote` accepts or rejects based on the signature check at fill time. EOA rules and digest replay protection are unchanged |
| R6 | The privileged function-name scan uses `/owner\|admin\|pause\|initiali[sz]e\|upgrade\|^bind/i` plus the case-sensitive `/^set[A-Z]/`. It excludes the markets hooks `setProposed`/`setDisputed`, and it does not scan `allow` (ERC20 allowance). The Governor's own tests prove it can only propose `adoptSuccessor` |
| R9 | `resolveCreation(id, upheld, challenger)`; when a creation challenge is upheld, the held creator bond goes to the original challenger |
| R17 | The global security bound is checked only in `createMarket` and `requestUnstake`; a slash cannot be refused and may cross the bound temporarily |
| R21 | Rewards and stream time at zero juror stake go to the treasury |
| R29 | No function loops over jurors; per-vote settlement is permissionless |
| R32 | Fee-distribution rounding remainders go to the treasury. When the final outcome differs from the proposal, or there is no proposal, the resolution share goes to jurors. The keeper tip always goes to the caller |
| R34/R37 | A result dispute can only reveal YES/NO; INVALID comes only from `finalizeTimeout` after hardDeadline |
| R35 | Voting weight is the smaller of the snapshot stake and the stake currently slashable |
| R38 | Ties and missing quorums reopen the same level; the tie rule is unchanged |
| R39 | Market creation reserves the full arbitration time; `appealEnd` is fixed at `revealEnd + appealSeconds`; an appeal that cannot complete is rejected |
| R40 | Platform-token rewards and penalties are judged by the dispute's final outcome (replacing R29's original per-round judgment) |
| R41 | Each round fixes its credit threshold at its start |
| minor #1–#7 | The seven Task 7 arbitration limits marked under "Known limitations", each with an adversarial test |
