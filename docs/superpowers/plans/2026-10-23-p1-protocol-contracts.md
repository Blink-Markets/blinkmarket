# P1 Protocol Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the permissionless, admin-free contract generation for the autonomous agent market: identity registry with credit, platform-token juror staking, multi-maker RFQ markets with fees, layered resolution with commit-reveal arbitration, a testnet faucet and next-generation governance, proven by Foundry unit, invariant and adversarial tests.

**Architecture:** A new contract set under `contracts/src/protocol/`, separate from the v0.1 `BlinkMarket.sol`/`BlinkTestUSD.sol`, which stay untouched until P2 switches the off-chain stack. One generation is four contracts deployed in a fixed nonce order with predicted addresses, so every cross-contract permission is a constructor-immutable address and no contract has an owner, admin, pause, initializer or upgrade path. bUSD (the existing `BlinkTestUSD`) carries collateral, fees, registration fees and per-market bonds; the new platform token carries juror stake and governance votes.

**Tech Stack:** Solidity 0.8.30, OpenZeppelin 5.6.1 (already a dependency: ERC20, ERC20Votes, Governor stack, Checkpoints, EIP712, ECDSA, SafeERC20, ReentrancyGuard), Foundry 1.7.1 via `scripts/foundry.mjs`, EVM Cancun, optimizer 200, viaIR.

**Spec:** `docs/superpowers/specs/2026-10-23-autonomous-market-design.md` (approved 2026-10-23). §5 is the protocol; §2.1 items 1, 4, 5 are this plan's acceptance; P2–P4 get their own plans once this ABI is final.

## Global Constraints

- "新合約沒有 admin、owner、固定角色地址、pause 或 allowlist 管理函式；任何狀態轉移都只依賴註冊身份、押金、時間與合約參數。" (spec §2.1.1) No `onlyOwner`, no `initialize`, no one-shot `bind`; cross-contract addresses are constructor arguments checked against `address(this)`.
- "所有經濟參數…在部署時寫死於合約，部署後不可改；改參數等於新部署。" (§5.0) Parameters live in one immutable `Params` struct stored by `BlinkRegistry` at construction, with no setter.
- "合約不可升級、沒有 pause" (§5.9). "治理…不能修改既有市場的規則、結果或託管資金。" (§5.9)
- bUSD for collateral, fees, registration fee and creation/proposal/challenge bonds; platform token only for juror stake and governance (§5.0).
- "所有押金需求都以最大賠付計" where max payout is `maxPairs × 1 bUSD`, fixed at creation, never lowered (§5.6).
- "權重 = 快照時的可罰沒押金（信用不放大權重…）" (§5.6). Credit never multiplies voting weight.
- "只有超過 hardDeadline 仍未定案才 INVALID" (§5.6); INVALID pays 0.5 bUSD per YES and per NO share (v0.1, kept).
- "信用不直接發錢，只降低成本、放寬上限" and "不來自成交量或未平倉量" (§5.7).
- Keep from v0.1 (§7): complete sets fully collateralised, integer shares, `UNIT = 1_000_000`, EIP-712 quotes with consumed/cancel/epoch replay protection, quote TTL ≤ 60 s, redeem only after FINAL, `block.chainid == 84532` check in every constructor.
- Do not modify `contracts/src/BlinkMarket.sol`, `contracts/src/BlinkTestUSD.sol`, their interfaces or tests; `BlinkTestUSD` is reused unchanged as bUSD with the faucet as its minter.
- Every deployed runtime bytecode ≤ 24,576 bytes (EIP-170), checked in `scripts/check-contracts.mjs`.
- Match the existing contract style: custom errors, `UNIT`, `nonReentrant` on token-moving functions, events for every state change, no NatSpec beyond what the v0.1 files carry.
- Run contracts through `pnpm test:contracts` (never raw `forge`); `pnpm check` must stay green, since the v0.1 stack is still wired.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push after each merged task (AGENTS.md stage checkpoints).

## Review Focus

1. **Juror stake leaves after markets were sized against it.** A juror unstakes, or the price source drops, after creators filled capacity: the system-wide open-payout bound must still hold or unstaking must refuse (Task 3 test `test_unstakeRefusedWhenItBreaksSecurityBound`, Task 4 test `test_createRefusedAboveGlobalSecurityBound`).
2. **Forcing INVALID to collect 0.5.** Cheap challenge, then non-reveal or no quorum: the round restarts instead of ending INVALID, and only `hardDeadline` yields INVALID, with the challenger bond forfeited (Task 7 tests `test_noQuorumRestartsRound`, `test_timeoutDuringDisputeForfeitsChallengerBond`).
3. **Late or split juror stake.** Stake added after a round opens has zero weight; the same stake split across two identities gets the same total weight (Task 7 tests `test_stakeAfterSnapshotHasNoWeight`, `test_splitStakeSameWeight`).
4. **Self-dealing.** The market's creator, proposer, challenger, or any address holding a position in that market cannot vote; wash trades never raise creator credit (Task 7 `test_conflictedJurorsCannotCommit`, Task 8 `test_washTradingEarnsNoCredit`).
5. **Solvency across everything one contract holds.** `BlinkMarkets`' bUSD balance ≥ escrow + maker free balances + fee pools + held bonds at every step; likewise `BlinkResolution` for its bonds and `BlinkJurors` for stake + undistributed rewards (Task 10 invariant `invariant_protocolSolvency`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `contracts/src/protocol/BlinkTypes.sol` | Shared enums (`Role`, `QuestionClass`, `MarketState`, `Outcome`, `DisputeKind`), `Params`, `GenerationAddresses` |
| `contracts/src/protocol/interfaces/IBlinkRegistry.sol`, `IBlinkJurors.sol`, `IBlinkMarkets.sol`, `IBlinkResolution.sol`, `IBlinkPriceSource.sol` | External surfaces used across contracts and by P2 |
| `contracts/src/protocol/BlinkToken.sol` | Platform test token: ERC20 + ERC20Votes (timestamp clock), immutable minter |
| `contracts/src/protocol/BlinkFaucet.sol` | Deploys bUSD and the token with itself as minter; per-address 24 h claim |
| `contracts/src/protocol/FixedPriceSource.sol` | Testnet price of the token in bUSD micros, immutable |
| `contracts/src/protocol/BlinkRegistry.sol` | Identities, registration fee, role stakes and exits, credit (decay, gain/loss, discount, multiplier, thresholds), import from the previous generation, `Params` storage |
| `contracts/src/protocol/BlinkJurors.sol` | Token staking with checkpoints, unstake cooldown and security check, bUSD reward accumulator, slashing hooks |
| `contracts/src/protocol/BlinkMarkets.sol` | Templates, market creation and creation window, multi-maker RFQ fills with fees, positions, finalization hook, fee distribution, redeem |
| `contracts/src/protocol/BlinkResolution.sol` | Proposals, challenges (result and creation), commit-reveal rounds, appeals, bonds, timeout |
| `contracts/src/protocol/BlinkGovernor.sol` | OZ Governor over the token; only action is adopting a successor registry with a delay |
| `contracts/test/protocol/ProtocolBase.sol` | Deploys a generation with predicted addresses and test `Params`; actors and helpers |
| `contracts/test/protocol/*.t.sol` | One test file per contract plus `Lifecycle.t.sol`, `ProtocolInvariant.t.sol`, `ProtocolAdversarial.t.sol` |
| `scripts/check-contracts.mjs` | Compile the protocol set, emit artifacts, enforce EIP-170 |
| `contracts/README.md`, `docs/P1_PROTOCOL_CONTRACTS.md`, `docs/ROADMAP.md` | Delivery docs |

### Shared types (decided here; Task 1 creates them)

```solidity
enum Role { CREATOR, MAKER, TAKER, FORECASTER, PROPOSER, CHALLENGER, JUROR }
enum QuestionClass { A_COMPUTABLE, B_VERIFIABLE, C_JUDGMENT }
enum MarketState { PENDING, OPEN, PROPOSED, DISPUTED, FINAL, CANCELLED }
enum Outcome { YES, NO, INVALID }
enum DisputeKind { CREATION, RESULT }

struct GenerationAddresses {
    address registry; address jurors; address markets; address resolution; // this generation, predicted
    address collateral; address token; address priceSource; address treasury; address previousRegistry; // pre-existing (previousRegistry may be 0)
}

struct Params {
    uint256 registrationFee;        // bUSD micros, paid to treasury, not refundable
    uint256 minRoleStake;           // bUSD micros per role (JUROR excluded: juror stake is the token)
    uint64 roleExitCooldown;
    uint16 feeBps;                  // charged on the taker payment
    uint16 treasuryShareBps; uint16 creatorShareBps; uint16 resolutionShareBps; uint16 jurorShareBps; uint16 bountyShareBps; // sum == 10000
    uint16 keeperTipBps;            // of the resolution share, to whoever distributes
    uint16 creationBondBps; uint16 proposerBondBps; uint16 challengeBondBps; // of maxPayout
    uint16 jurorBondCutBps;         // of every losing bond, to coherent jurors
    uint16 maxCreditDiscountBps;    // bonds never fall below (10000 - this) of base
    uint16 creditDiscountStepBps;   // discount per credit point
    uint16 creditMultiplierStepBps; uint16 maxCreditMultiplierBps; // limit multiplier, starts at 10000
    uint16 creatorExposureMultiple; // open maxPayout per creator <= roleStake * multiplier * this / 10000
    uint64[3] creationWindow;       // per class
    uint64 firstUseExtraWindow;
    uint64[3] resultChallengeWindow; uint64[3] minResultChallengeWindow; uint64 challengeWindowStepSeconds;
    uint64 commitSeconds; uint64 revealSeconds; uint64 appealSeconds;
    uint8 maxRounds;                // <= 4
    uint16[4] quorumBps;            // of snapshot total stake, per round
    uint16 nonRevealSlashBps; uint16 incoherentSlashBps; uint16 roleSlashBps;
    uint64 jurorUnstakeCooldown;
    uint16 securityMultipleBps;     // attackCost * 10000 >= openPayout * this
    uint64 maxMarketPairs; uint64 maxTakerShares; uint64 maxFillShares;
    uint64 creditHalfLife; uint256 creditUnitMicros; uint32 creditGainCap; uint8 creditLossMultiplier;
    uint32 classCCreditThreshold; uint32[4] roundCreditThreshold; uint32 phaseInFinalizedMarkets;
    uint16 importDiscountBps;
    bool replayAllowed;
}
```

Test values live in `ProtocolBase.defaultParams()`; production values are chosen in the P2 deploy task, not here.

### Deployment order (every test and the P2 deployer follow it)

From one deployer: `registry` (nonce n) → `jurors` (n+1) → `markets` (n+2) → `resolution` (n+3). The deployer computes all four addresses first and passes the same `GenerationAddresses` to each constructor; each constructor reverts `WrongAddress()` unless its own slot equals `address(this)`, and reverts `WrongChain()` unless `block.chainid == 84532`. `BlinkFaucet` (which deploys bUSD and the token), `FixedPriceSource` and `BlinkGovernor` are deployed once, before the first generation.

---

### Task 1: Types, tokens, faucet, price source, build script

**Files:**
- Create: `contracts/src/protocol/BlinkTypes.sol`, `contracts/src/protocol/interfaces/IBlinkPriceSource.sol`, `contracts/src/protocol/BlinkToken.sol`, `contracts/src/protocol/BlinkFaucet.sol`, `contracts/src/protocol/FixedPriceSource.sol`, `contracts/test/protocol/ProtocolBase.sol` (token/faucet part only)
- Modify: `scripts/check-contracts.mjs`
- Test: `contracts/test/protocol/Faucet.t.sol`, `tests/protocol-artifacts.test.ts`

**Interfaces:**
- Produces: `BlinkToken(address minter)` with `mint(address,uint256)` (minter only), ERC20Votes with `clock() == block.timestamp` and `CLOCK_MODE() == "mode=timestamp"`; `BlinkFaucet()` exposing `busd() returns (BlinkTestUSD)`, `token() returns (BlinkToken)`, `claim()`, `nextClaimAt(address) returns (uint64)`, constants `CLAIM_BUSD = 1_000e6`, `CLAIM_TOKEN = 1_000e18`, `CLAIM_INTERVAL = 1 days`; `IBlinkPriceSource.tokenPriceMicros() returns (uint256)` (bUSD micros per 1e18 token units, conservative); `FixedPriceSource(uint256 priceMicros)`.

- [ ] **Step 1: Write the failing tests** in `Faucet.t.sol`:
  - `test_faucetIsMinterOfBoth`: `faucet.busd().minter() == address(faucet)`, `faucet.token().minter() == address(faucet)`, `faucet.busd().decimals() == 6`.
  - `test_claimOncePerInterval`: first `claim()` gives `1_000e6` bUSD and `1_000e18` token; second claim in the same interval reverts `ClaimTooSoon()`; after `warp(+1 days)` it succeeds.
  - `test_tokenVotesUseTimestamps`: `token.clock() == block.timestamp`; after `delegate(self)` and a warp, `getPastVotes(self, t)` equals the balance.
  - `test_onlyMinterMints`: a non-faucet `mint` reverts `UnauthorizedMinter()`.
  - `test_fixedPrice`: `FixedPriceSource(2e6).tokenPriceMicros() == 2e6`; constructor with 0 reverts `InvalidPrice()`.
- [ ] **Step 2: Run** `pnpm test:contracts --match-path 'contracts/test/protocol/Faucet.t.sol'`. Expected: FAIL (files missing). If the wrapper does not forward flags, run `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/Faucet.t.sol`.
- [ ] **Step 3: Implement** the types file (exact content above), the price interface, `BlinkToken` (OZ `ERC20`, `ERC20Permit`, `ERC20Votes`; override `clock`/`CLOCK_MODE`; name "Blink Test Token", symbol "tBLINK"), `BlinkFaucet` (constructor `new BlinkTestUSD(address(this))`, `new BlinkToken(address(this))`), `FixedPriceSource`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Extend `scripts/check-contracts.mjs`**: add every `contracts/src/protocol/**/*.sol` source (keep the two v0.1 paths), resolve OZ imports as today, write one artifact per contract, and exit 1 with `<Name>: runtime <n> bytes exceeds EIP-170` when `deployedBytecode` is over 24,576 bytes. Add `tests/protocol-artifacts.test.ts` (node:test) with `compiles protocol contracts within EIP-170`, which runs the script and asserts exit code 0 and that `contracts/artifacts/BlinkFaucet.json` exists.
- [ ] **Step 6: Run** `pnpm check:contracts && node --import tsx --test tests/protocol-artifacts.test.ts`. Expected: both pass.
- [ ] **Step 7: Commit** `feat(contracts): add protocol types, platform test token, faucet and fixed price source`.

### Task 2: BlinkRegistry — identities, role stakes, credit, generations

**Files:**
- Create: `contracts/src/protocol/interfaces/IBlinkRegistry.sol`, `contracts/src/protocol/BlinkRegistry.sol`
- Modify: `contracts/test/protocol/ProtocolBase.sol` (generation deployment with predicted addresses; `defaultParams()`)
- Test: `contracts/test/protocol/Registry.t.sol`

**Interfaces:**
- Consumes: `BlinkTypes`, bUSD (`IERC20`).
- Produces (`IBlinkRegistry`):
  - `register()`: pays `registrationFee` to `treasury`; waived when `previousRegistry != 0 && IBlinkRegistry(previousRegistry).isRegistered(msg.sender)`.
  - `joinRole(Role role, uint256 amount)` (`amount >= minRoleStake`, reverts `JurorUsesToken()` for `Role.JUROR`, which only needs registration), `addRoleStake(Role, uint256)`, `requestRoleExit(Role)`, `withdrawRole(Role)` after `roleExitCooldown`; a role in exit cannot act.
  - Views: `isRegistered(address) bool`, `hasRole(address, Role) bool`, `roleStake(address, Role) uint256`, `creditOf(address, Role) uint256`, `bondFor(address, Role, uint256 baseBond) uint256`, `limitMultiplierBps(address, Role) uint256`, `meetsThreshold(address, Role, uint32 threshold) bool`, `params() Params`, `addresses() GenerationAddresses`.
  - Reporter hooks, callable only by `markets`, `resolution` or `jurors` of this generation (`UnauthorizedReporter()`): `reportGain(address, Role, uint256 maxPayout)`, `reportLoss(address, Role, uint256 maxPayout)`, `slashRole(address, Role) returns (uint256 slashed)` (moves `roleSlashBps` of the stake to `treasury`).
  - `importCredit()`: once per identity, sets each role's credit to `previous.creditOf(sender, role) * importDiscountBps / 10000`; reverts `NothingToImport()` without a previous generation.
  - Events for every state change.

Credit rules (decided here):
- Lazy decay: effective credit = stored `>> ((now - lastUpdate) / creditHalfLife)` (0 once the shift reaches 32); every write first materialises decay.
- `gain = min(maxPayout / creditUnitMicros, creditGainCap)`; `loss = gain * creditLossMultiplier`, floored at 0.
- `bondFor = baseBond * (10000 - min(credit * creditDiscountStepBps, maxCreditDiscountBps)) / 10000`.
- `limitMultiplierBps = min(10000 + credit * creditMultiplierStepBps, maxCreditMultiplierBps)`.
- `meetsThreshold` is true when `IBlinkMarkets(markets).finalizedCount() < phaseInFinalizedMarkets` (phase-in) or `creditOf >= threshold`.

- [ ] **Step 1: Write the failing tests** in `Registry.t.sol`:
  - `test_generationWiringRejectsWrongSelf`: deploying the registry with `addresses.registry != predicted` reverts `WrongAddress()`; `ProtocolBase` deploys a full generation and `registry.addresses().markets == address(markets)`.
  - `test_registrationFeeGoesToTreasuryAndIsFinal`: treasury balance rises by `registrationFee`; a second `register()` reverts `AlreadyRegistered()`; no function returns the fee.
  - `test_roleStakeExitCooldown`: `joinRole(PROPOSER, minRoleStake)` locks bUSD; `withdrawRole` before cooldown reverts `CooldownActive()`; after cooldown returns the stake; `hasRole` is false from `requestRoleExit` on.
  - `test_onlyReportersChangeCredit`: an EOA calling `reportGain` reverts `UnauthorizedReporter()`.
  - `test_creditGainLossAndDecay`: with `creditUnitMicros = 100e6`, `creditGainCap = 50`, `creditLossMultiplier = 3`, a gain on `maxPayout = 1_000e6` gives 10; a loss on the same gives 0 (floored, not negative); credit 40 halves to 20 after one `creditHalfLife`.
  - `test_bondDiscountHasFloor`: with `maxCreditDiscountBps = 5000`, `bondFor` never returns below half of `baseBond` at any credit.
  - `test_thresholdPhaseIn`: `meetsThreshold(x, JUROR, 10)` is true with zero credit while `finalizedCount() < phaseInFinalizedMarkets`, false after.
  - `test_importFromPreviousGeneration`: a second generation pointing at the first lets an identity `register()` free and `importCredit()` at `importDiscountBps`; a second import reverts `AlreadyImported()`.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/Registry.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** `IBlinkRegistry` and `BlinkRegistry` per the Interfaces block. `ProtocolBase` gains `deployGeneration(Params memory, address previous) returns (GenerationAddresses memory)` using cheatcodes `getNonce(address)` and `computeCreateAddress(address,uint256)` (add both to the local `Vm` interface), and deploys stub-free real contracts in Tasks 3–7; until those exist, deploy minimal test stand-ins at the predicted `jurors`/`markets`/`resolution` slots inside `Registry.t.sol` only.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): add the identity registry with role stakes, credit and generation import`.

### Task 3: BlinkJurors — token stake, snapshots, rewards, slashing

**Files:**
- Create: `contracts/src/protocol/interfaces/IBlinkJurors.sol`, `contracts/src/protocol/BlinkJurors.sol`
- Test: `contracts/test/protocol/Jurors.t.sol`

**Interfaces:**
- Consumes: `IBlinkRegistry.isRegistered`, `params()`; `IBlinkPriceSource`; token (`IERC20`), bUSD.
- Produces (`IBlinkJurors`):
  - `stake(uint256 amount)` (registered identities only), `requestUnstake(uint256 amount)`, `withdrawUnstaked()` after `jurorUnstakeCooldown`. Requested amounts stop counting as stake immediately.
  - `stakeAt(address juror, uint256 timepoint) uint256`, `totalStakeAt(uint256 timepoint) uint256` (OZ `Checkpoints.Trace208`, keyed by timestamp), `totalStaked() uint256`.
  - `attackCostMicros() uint256 = totalStaked() * priceSource.tokenPriceMicros() / 1e18 / 2`.
  - `notifyReward(uint256 busdAmount)`: callable by `markets` or `resolution` after transferring bUSD in; distributed per staked token via a reward-per-token accumulator (stake × time); `claimRewards()`.
  - Hooks, `resolution` only: `slash(address juror, uint256 amount, address to)` (token moves to `to`), `reward(address juror, uint256 tokenAmount)` (from tokens already held by this contract via slashes).
  - `requestUnstake` reverts `UnstakeBreaksSecurity()` when `(attackCost after unstake) * 10000 < IBlinkMarkets(markets).openPayoutTotal() * securityMultipleBps`.

- [ ] **Step 1: Write the failing tests** in `Jurors.t.sol`:
  - `test_stakeCheckpointsByTimestamp`: stake 100 at t, 50 more at t+10; `stakeAt(j, t+5) == 100`, `stakeAt(j, t+10) == 150`, `totalStakeAt` matches.
  - `test_unstakeCooldown`: requested stake drops from `stakeAt(now)` at once; `withdrawUnstaked` before cooldown reverts `CooldownActive()`.
  - `test_unstakeRefusedWhenItBreaksSecurityBound`: with a stub `openPayoutTotal()` returning a value that the full stake just covers, `requestUnstake(1)` reverts `UnstakeBreaksSecurity()`.
  - `test_rewardsSplitByStakeAndTime`: A stakes 100, B stakes 300, `notifyReward(400e6)`; A claims 100e6, B claims 300e6; a juror staking after the notify gets 0 of it.
  - `test_onlyResolutionSlashes`: an EOA `slash` reverts `UnauthorizedCaller()`; resolution's `slash` lowers stake and the checkpoint.
  - `test_unregisteredCannotStake`: reverts `NotRegistered()`.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/Jurors.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block (Synthetix-style `rewardPerTokenStored`, `userRewardPerTokenPaid`).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): add token juror staking with snapshots, fee rewards and the security unstake check`.

### Task 4: BlinkMarkets — templates, creation, creation window

**Files:**
- Create: `contracts/src/protocol/interfaces/IBlinkMarkets.sol`, `contracts/src/protocol/BlinkMarkets.sol` (creation half)
- Test: `contracts/test/protocol/MarketsCreation.t.sol`

**Interfaces:**
- Consumes: registry (`hasRole`, `bondFor`, `limitMultiplierBps`, `roleStake`, `meetsThreshold`, `params`), jurors (`attackCostMicros`).
- Produces (`IBlinkMarkets`):
  - `registerTemplate(QuestionClass cls, bytes32 parserHash, string calldata uri) returns (bytes32 templateId)`: permissionless; `templateId = keccak256(abi.encode(cls, parserHash, uri))`; class A requires `parserHash != 0` (`MissingParser()`).
  - `createMarket(CreateArgs calldata a) returns (uint256 id)` where `struct CreateArgs { bytes32 templateId; bytes32 specHash; string specURI; bool replay; uint64 closeAt; uint64 proposalDeadline; uint64 hardDeadline; uint64 maxPairs; }`. Requires CREATOR role; `replay` only if `params.replayAllowed`; duplicate `specHash` reverts `DuplicateSpec()`; schedule rules from v0.1 with `resultChallengeWindow[cls]` in place of the fixed 86400/120; `maxPairs <= maxMarketPairs`; class C requires `meetsThreshold(creator, CREATOR, classCCreditThreshold)`.
  - Takes the creation bond `bondFor(creator, CREATOR, maxPayout * creationBondBps / 10000)` in bUSD.
  - Creator exposure: `openPayoutByCreator[creator] + maxPayout <= roleStake(creator, CREATOR) * limitMultiplierBps(creator, CREATOR) * creatorExposureMultiple / 1e4` else `CreatorLimitExceeded()`.
  - Global security bound: `(openPayoutTotal + maxPayout) * securityMultipleBps <= jurors.attackCostMicros() * 10000` else `SecurityBoundExceeded()`.
  - State PENDING with `openAt = now + creationWindow[cls] + (template first use ? firstUseExtraWindow : 0)`.
  - Views: `getMarket(id)`, `openPayoutTotal() uint256`, `finalizedCount() uint256`, `maxPayout(id) uint256`.
  - Hooks, `resolution` only: `markCreationChallenged(id)`, `resolveCreation(uint256 id, bool upheld, address challenger)` (upheld → CANCELLED, payout released from both open totals, creation bond to `challenger` minus `jurorBondCutBps` which goes to `jurors.notifyReward`; rejected → OPEN at `max(openAt, now)`), `setProposed(id)`, `setDisputed(id)`, `finalize(id, Outcome)`.
  - `open(id)`: permissionless PENDING → OPEN once `now >= openAt` and no creation challenge is pending.

- [ ] **Step 1: Write the failing tests** in `MarketsCreation.t.sol`:
  - `test_createTakesBondScaledByMaxPayout`: `maxPairs = 1_000`, `creationBondBps = 1_000`, zero credit → bond `100e6` moves from creator to markets; `maxPayout(id) == 1_000e6`.
  - `test_onlyCreatorsCreate`: registered identity without the CREATOR role reverts `MissingRole()`.
  - `test_classARequiresParser` and `test_firstTemplateUseHasLongerWindow`: second market on the same template opens `firstUseExtraWindow` earlier than the first.
  - `test_classCNeedsCreditAfterPhaseIn`: allowed with zero credit before phase-in, reverts `InsufficientCredit()` after (use a stub `finalizedCount`).
  - `test_createRefusedAboveGlobalSecurityBound`: with juror stake priced so `attackCost = 10_000e6` and `securityMultipleBps = 20_000`, total open payout 5_000e6 succeeds and one more market reverts `SecurityBoundExceeded()`.
  - `test_creatorExposureLimitGrowsWithCredit`: the same call that reverts `CreatorLimitExceeded()` at zero credit passes after the stub registry reports credit.
  - `test_replayRejectedUnlessAllowed`: `replay = true` reverts `ReplayNotAllowed()` when `replayAllowed == false`.
  - `test_openOnlyAfterWindowWithoutChallenge`: `open` before `openAt` reverts `CreationWindowActive()`; after, state OPEN.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/MarketsCreation.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** the creation half per the Interfaces block.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): add permissionless market creation with classes, bonds and the global security bound`.

### Task 5: BlinkMarkets — multi-maker RFQ fills, fees, positions

**Files:**
- Modify: `contracts/src/protocol/BlinkMarkets.sol`, `contracts/src/protocol/interfaces/IBlinkMarkets.sol`
- Test: `contracts/test/protocol/MarketsTrading.t.sol`

**Interfaces:**
- Consumes: registry `hasRole(MAKER|TAKER)`.
- Produces:
  - EIP-712 domain `("Blink RFQ", "0.2")`; `Quote` keeps the v0.1 field list and typehash string, with `maker` now any registered maker.
  - `depositMaker(uint256)`, `withdrawMaker(uint256)`, `makerFree(address) uint256`, `cancelQuote(Quote)`, `incrementMakerEpoch()`, `makerEpoch(address) uint256`: all keyed by `msg.sender`'s maker identity.
  - `fillQuote(Quote calldata q, bytes calldata sig)`:
    - Requires OPEN and `now < closeAt`; the signer recovers to `q.maker`, which holds the MAKER role; `q.taker == msg.sender` holds the TAKER role and `q.taker != q.maker`.
    - Keeps the v0.1 caps (`maxFillShares`, `maxPairs`, `maxTakerShares`), price bounds, TTL ≤ 60 s and replay checks.
    - The taker pays `takerCost + fee` with `fee = takerCost * feeBps / 10000`; `fee` accrues to `feePool[id]`.
  - Positions as v0.1 (`getPosition`); event `QuoteFilled(id, digest, maker, taker, side, quantity, priceBps, takerCost, makerCost, fee)`.

- [ ] **Step 1: Write the failing tests** in `MarketsTrading.t.sol`:
  - `test_twoMakersQuoteSameMarket`: makers M1 and M2 each fill one taker quote; positions and `makerFree` per maker are independent.
  - `test_feeChargedToTaker`: with `feeBps = 100`, a fill with `takerCost = 60e6` pulls `60.6e6` from the taker and `feePool(id) == 0.6e6`.
  - `test_unregisteredOrExitedRolesCannotTrade`: a maker in role exit, or a taker without the TAKER role, reverts `MissingRole()`.
  - `test_quoteReplayAndEpochPerMaker`: M1's `incrementMakerEpoch` invalidates only M1's quotes.
  - `test_cannotFillPendingOrClosed`: PENDING reverts `MarketNotOpen()`; at `closeAt` reverts `MarketClosed()`.
  - `test_takerCannotBeMaker`: reverts `InvalidTaker()`.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/MarketsTrading.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block, porting the v0.1 `fillQuote` checks.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): add multi-maker RFQ fills with taker-paid fees`.

### Task 6: BlinkResolution — proposals, challenges, unchallenged finalize, timeout

**Files:**
- Create: `contracts/src/protocol/interfaces/IBlinkResolution.sol`, `contracts/src/protocol/BlinkResolution.sol` (non-dispute half)
- Test: `contracts/test/protocol/ResolutionBasic.t.sol`

**Interfaces:**
- Consumes: markets hooks (Task 4), registry (`hasRole`, `bondFor`, `creditOf`, `reportGain/Loss`, `slashRole`).
- Produces (`IBlinkResolution`):
  - `propose(uint256 id, Outcome o, bytes32 evidenceHash, string calldata evidenceURI)`: PROPOSER role; window `closeAt ≤ now < proposalDeadline`; non-empty evidence; bond `bondFor(p, PROPOSER, maxPayout * proposerBondBps / 1e4)`.
  - Challenge window = `max(minResultChallengeWindow[cls], resultChallengeWindow[cls] - creditOf(p, PROPOSER) * challengeWindowStepSeconds)`.
  - `challengeResult(uint256 id, bytes32 evidenceHash)`: CHALLENGER role; challenger ≠ proposer; bond `bondFor(c, CHALLENGER, maxPayout * challengeBondBps / 1e4)`; opens a RESULT dispute (Task 7).
  - `challengeCreation(uint256 id, uint8 ground, bytes32 evidenceHash)`: CHALLENGER role, not the creator; market PENDING; `ground < 3` (0 wrong class, 1 ambiguous/unresolvable, 2 influenceable; values ≥ 3 reserved and revert `UnknownGround()` so a later generation can add the banned-topic ground of spec §12); bond as above; opens a CREATION dispute.
  - `finalizeUnchallenged(id)`: permissionless after the window, before `hardDeadline`; proposer bond returned; `reportGain(p, PROPOSER, maxPayout)`; `markets.finalize(id, o)`.
  - `finalizeTimeout(id)`: permissionless at `now >= hardDeadline` for any non-FINAL, non-CANCELLED market. The outcome is INVALID. An open dispute forfeits every challenger and appeal bond to `jurors.notifyReward`, and the proposer bond is returned.
  - Views for Task 8: `proposerOf(uint256 id) address`, `proposedOutcome(uint256 id) Outcome`, `bountyWinner(uint256 id) address` (the challenger of a RESULT dispute that overturned the proposal, else `address(0)`).

- [ ] **Step 1: Write the failing tests** in `ResolutionBasic.t.sol`:
  - `test_proposeTakesBondAndWindowShrinksWithCredit`: zero-credit proposer gets `resultChallengeWindow[cls]`; with credit the window shrinks but never below `minResultChallengeWindow[cls]`.
  - `test_unchallengedFinalizeReturnsBondAndRaisesCredit`.
  - `test_proposerCannotChallengeSelf`: reverts `SelfChallenge()`.
  - `test_challengeCreationOnlyWhilePending` and `test_unknownGroundReserved`: `ground = 3` reverts `UnknownGround()`.
  - `test_onlyHardDeadlineGivesInvalid`: `finalizeTimeout` before `hardDeadline` reverts `DeadlineViolation()`; at it, FINAL INVALID.
  - `test_timeoutDuringDisputeForfeitsChallengerBond`: open a dispute, warp to `hardDeadline`; challenger bond goes to the juror reward pool, proposer bond returns.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/ResolutionBasic.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block (dispute opening can be a stub that stores the dispute until Task 7).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): add bonded proposals, result and creation challenges, and timeout INVALID`.

### Task 7: BlinkResolution — commit-reveal rounds and appeals

**Files:**
- Modify: `contracts/src/protocol/BlinkResolution.sol`, `contracts/src/protocol/interfaces/IBlinkResolution.sol`
- Test: `contracts/test/protocol/ResolutionDispute.t.sol`

**Interfaces:**
- Consumes: jurors (`stakeAt`, `totalStakeAt`, `slash`, `reward`, `notifyReward`), registry (`meetsThreshold(j, JUROR, roundCreditThreshold[r])`, `reportGain/Loss`), markets (`getPosition`, `resolveCreation`, `finalize`).
- Produces:
  - Round `r` (0-based) has `snapshotAt = roundStart - 1`, a commit phase of `commitSeconds`, then a reveal phase of `revealSeconds`. Choices: RESULT `0=YES, 1=NO, 2=INVALID`; CREATION `0=REJECT, 1=UPHOLD`.
  - `commitVote(uint256 disputeId, bytes32 commitment)`: `commitment = keccak256(abi.encode(disputeId, round, msg.sender, choice, salt))`. Weight = `jurors.stakeAt(msg.sender, snapshotAt)` and must be > 0.
  - `commitVote` reverts `ConflictedJuror()` when the juror is the market's creator, the proposer, the challenger or an appellant, or holds any position in the market. It reverts `InsufficientCredit()` when `meetsThreshold` fails.
  - `revealVote(uint256 disputeId, uint8 choice, bytes32 salt)`.
  - `settleRound(disputeId)`: permissionless after the reveal phase.
    - Quorum is committed weight ≥ `quorumBps[r] * totalStakeAt(snapshotAt) / 1e4`. No quorum, or a tie among revealed weight, restarts the same round with a fresh snapshot (`RoundRestarted`) and never yields INVALID.
    - Non-revealers are slashed `nonRevealSlashBps`; incoherent revealers are slashed `incoherentSlashBps`. Coherent revealers share those tokens pro rata by weight, plus `jurorBondCutBps` of the losing bond in bUSD via `notifyReward`.
    - Sets the leading choice and opens an appeal window of `appealSeconds`.
  - `appeal(disputeId)`: by the losing side's bond poster (or any CHALLENGER/PROPOSER role holder taking that side), posting `2 ×` the previous bond, while `r + 1 < maxRounds`; opens round `r + 1`.
  - `finalizeDispute(disputeId)`: permissionless after the appeal window closes unappealed.
    - Winners get their bonds back plus the losers' bonds minus `jurorBondCutBps`. RESULT winners also get the market's bounty pool via `markets` (Task 8).
    - Credit: winner `reportGain`, loser `reportLoss` plus `slashRole`; coherent jurors in the final round `reportGain(JUROR)`, incoherent ones `reportLoss(JUROR)`.
    - RESULT calls `markets.finalize(id, choice)`; CREATION calls `markets.resolveCreation(id, choice == UPHOLD)`, and UPHOLD also reports a CREATOR loss.

- [ ] **Step 1: Write the failing tests** in `ResolutionDispute.t.sol`:
  - `test_honestMajorityOverturnsLie`: proposer says YES, truth NO; three jurors 60/30/10 stake vote NO/NO/YES; after settle and finalize: market FINAL NO, challenger receives own bond + proposer bond × (1 − cut), the YES juror is slashed `incoherentSlashBps`, the NO jurors receive it pro rata.
  - `test_stakeAfterSnapshotHasNoWeight`: a juror staking after `roundStart` reverts `NoWeight()` on commit.
  - `test_splitStakeSameWeight`: 100 tokens in one identity versus 50 + 50 in two produce the same revealed weight total and the same outcome.
  - `test_noQuorumRestartsRound`: only 5% commits with `quorumBps[0] = 2000`; `settleRound` emits `RoundRestarted` and the market is still DISPUTED, not INVALID.
  - `test_nonRevealIsSlashed`.
  - `test_conflictedJurorsCannotCommit`: creator, proposer, challenger and a position holder each revert `ConflictedJuror()`.
  - `test_appealDoublesBondAndRaisesThreshold`: the appeal requires `2 ×` bond; round 1 rejects a zero-credit juror after phase-in with `InsufficientCredit()`.
  - `test_maxRoundsStopsAppeals`: at `maxRounds - 1`, `appeal` reverts `NoMoreAppeals()`.
  - `test_creationUpheldCancelsMarketAndPaysChallenger`: CREATION dispute UPHOLD → market CANCELLED, creator bond to challenger minus cut, creator CREATOR credit falls.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/ResolutionDispute.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** the same command plus `ResolutionBasic.t.sol`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): add snapshot-weighted commit-reveal arbitration with appeals`.

### Task 8: BlinkMarkets — fee distribution, bounty, redeem, creator credit

**Files:**
- Modify: `contracts/src/protocol/BlinkMarkets.sol`, `contracts/src/protocol/interfaces/IBlinkMarkets.sol`
- Test: `contracts/test/protocol/MarketsSettlement.t.sol`

**Interfaces:**
- Consumes: resolution (`proposerOf(id)`, `proposedOutcome(id)`, `bountyWinner(id)`), jurors `notifyReward`, registry `reportGain/Loss`.
- Produces:
  - `distributeFees(uint256 id)`: permissionless, once, FINAL only. Splits `feePool[id]` by the share bps:
    - **Treasury** → `treasury`.
    - **Creator** → creator when the outcome is not INVALID; otherwise → jurors `notifyReward`.
    - **Resolution** → proposer when the final outcome equals the proposal; `keeperTipBps` of it → `msg.sender`.
    - **Juror** → `jurors.notifyReward`.
    - **Bounty** → `bountyWinner(id)` when a result challenge succeeded; otherwise → `jurors.notifyReward`.
  - On first FINAL (inside `finalize`): `openPayoutTotal`/`openPayoutByCreator` drop by `maxPayout`, `finalizedCount++`. The creator bond is returned on any FINAL. The creator gets `reportGain(CREATOR)` when the outcome is not INVALID, `reportLoss(CREATOR)` otherwise.
  - `redeem(uint256 id)`: as v0.1 (YES/NO 1 bUSD per winning share, INVALID 0.5 per share).

- [ ] **Step 1: Write the failing tests** in `MarketsSettlement.t.sol`:
  - `test_feeSplitMatchesParams`: shares 4000/2000/2000/1500/500, keeper tip 1000 bps of resolution; after `distributeFees` each recipient's delta equals the computed amount and `feePool(id) == 0`; a second call reverts `AlreadyDistributed()`.
  - `test_invalidSendsCreatorShareToJurors`.
  - `test_bountyPaidOnlyOnSuccessfulChallenge`.
  - `test_redeemPaysOutcome`: YES 1e6/share, INVALID 0.5e6 per YES and per NO share; escrow reaches 0 after all redeem.
  - `test_finalReleasesSecurityCapacity`: `openPayoutTotal` drops and a previously refused `createMarket` now succeeds.
  - `test_washTradingEarnsNoCredit`: creator, maker and taker identities of one operator trade 100 fills; creator credit after FINAL equals the credit of the same market with zero fills.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/MarketsSettlement.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** all `test/protocol` files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): distribute fees, pay the challenge bounty and settle creator credit`.

### Task 9: BlinkGovernor — successor adoption only

**Files:**
- Create: `contracts/src/protocol/BlinkGovernor.sol`
- Test: `contracts/test/protocol/Governor.t.sol`

**Interfaces:**
- Consumes: `BlinkToken` (`IVotes`).
- Produces: `BlinkGovernor(IVotes token, uint48 votingDelay, uint32 votingPeriod, uint256 proposalThreshold, uint256 quorumFraction, uint64 adoptionDelay)` built from OZ `Governor`, `GovernorSettings`, `GovernorCountingSimple`, `GovernorVotes`, `GovernorVotesQuorumFraction`; `adoptSuccessor(address registry) onlyGovernance` sets `pendingSuccessor` and `successorEffectiveAt = now + adoptionDelay`; view `successor() returns (address)` returns the pending one only after `successorEffectiveAt`, else the previous; `propose` reverts `OnlySuccessorProposals()` unless every target is the governor itself and every calldata selector is `adoptSuccessor`.

- [ ] **Step 1: Write the failing tests** in `Governor.t.sol`:
  - `test_adoptSuccessorAfterVoteAndDelay`: delegate, propose `adoptSuccessor(gen2)`, vote, execute; `successor()` is still the old value until `adoptionDelay` passes, then `gen2`.
  - `test_cannotProposeOtherActions`: a proposal targeting the token or `markets` reverts `OnlySuccessorProposals()`.
  - `test_votesUseSnapshot`: tokens transferred after the proposal snapshot do not change the tally.
- [ ] **Step 2: Run** `node scripts/foundry.mjs forge test --root contracts --match-path test/protocol/Governor.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): add token governance limited to adopting the next generation`.

### Task 10: Lifecycle, invariants, adversarial suite, delivery docs

**Files:**
- Create: `contracts/test/protocol/Lifecycle.t.sol`, `contracts/test/protocol/ProtocolInvariant.t.sol`, `contracts/test/protocol/ProtocolAdversarial.t.sol`, `docs/P1_PROTOCOL_CONTRACTS.md`
- Modify: `contracts/README.md`, `docs/ROADMAP.md` (tick P1 only when every step here passes), `package.json` (`test:contracts:seeds` also runs `ProtocolInvariantTest` with seeds 0x01 and 0x02)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `Lifecycle.t.sol`** with one test per §2.1 on-chain scenario. Every actor is a separate registered identity that joins its roles itself; none uses a privileged address:
  - `test_normalPath`: faucet claims → register → roles → template → create → open → two makers fill → propose → unchallenged finalize → distribute → redeem; every bUSD balance reconciles to the claims.
  - `test_disputeWithAppeal`: dispute → round 0 → appeal → round 1 → finalize.
  - `test_creationChallengeUpheld`.
  - `test_timeoutInvalid`.
  - `test_generationTwoImportsCredit`: governance adopts gen 2; an identity imports its credit there.
- [ ] **Step 2: Write `ProtocolInvariant.t.sol`** with a handler that randomly registers, stakes, creates, fills, proposes, challenges, commits, reveals, settles, appeals, warps, finalizes, distributes and redeems over two markets. Invariants:
  - `invariant_protocolSolvency`: `busd.balanceOf(markets) >= sum(escrow) + sum(makerFree) + sum(feePool) + sum(held creation bonds)`; `busd.balanceOf(resolution) >= sum(held proposal/challenge/appeal bonds)`; `token.balanceOf(jurors) >= totalStaked + pending unstakes + undistributed slashed tokens`.
  - `invariant_securityBound`: `openPayoutTotal * securityMultipleBps <= attackCostMicros * 10000`.
  - `invariant_noInvalidBeforeHardDeadline`: no market is FINAL INVALID before its `hardDeadline` unless every juror revealed INVALID.
- [ ] **Step 3: Write `ProtocolAdversarial.t.sol`**:
  - `test_reentrantTokenCannotDrain`: port the v0.1 malicious-token pattern to `fillQuote`, `redeem`, `distributeFees`, `withdrawRole`, `claimRewards`.
  - In `tests/protocol-artifacts.test.ts`, add `protocol contracts expose no privileged functions`. Across every protocol artifact except `BlinkGovernor`, no ABI function name matches `/owner|admin|pause|^set|initiali[sz]e|upgrade|bind|allow/i`. For `BlinkGovernor`, `Governor.t.sol` already proves that proposals other than `adoptSuccessor` revert; extend `test_cannotProposeOtherActions` with a proposal calling the governor's own `setVotingDelay`.
  - `test_whitewashingCostsFeeAndResetsCredit`: a fresh identity pays the fee, has zero credit and the minimum multiplier.
  - `test_bribeAbove50PercentIsBoundedByPayout`: an attacker holding 51% of stake wins one dispute; the attacker's gain from that market ≤ `maxPayout`, and `attackCostMicros ≥ maxPayout * securityMultipleBps / 1e4` held at creation.
- [ ] **Step 4: Run** `pnpm test:contracts && pnpm test:contracts:seeds && node --import tsx --test tests/protocol-artifacts.test.ts && pnpm check`. Expected: all pass, the v0.1 suite included.
- [ ] **Step 5: Write `docs/P1_PROTOCOL_CONTRACTS.md`** (Traditional Chinese, matching other delivery docs):
  - The contract set and its deployment order.
  - The `Params` meaning.
  - The trust assumption from spec §5.12 in its approved wording ("在公開列出的假設下，誠實是可證明的最佳策略").
  - Testnet limits: faucet, fixed price, no real token value.
  - Not deployed; P2 wires it.
  - Test commands and counts.

  Update `contracts/README.md` to point to both contract sets. Tick the P1 line in `docs/ROADMAP.md`.
- [ ] **Step 6: Commit and push** `test(contracts): prove the autonomous lifecycle, solvency and attack bounds; document P1`.

---

## Deferred to later plans (not P1)

- P2: deploy script and production `Params`, ABI wiring in `packages/adapters`, removal of the v0.1 off-chain roles and the signer, RFQ relay, self-serve API identity, forecast signing and on-chain anchoring, human suggestions, indexer for the new events, maker credit (spec §5.2 lists it, but no on-chain signal exists that wash trading cannot fake; P2 decides whether an off-chain read model is enough).
- P3: reference agents, agent docs, `pnpm alpha:autonomous`, optional LLM agent demo.
- P4: website advantages page, README/ROADMAP, Remotion intro video (check the Remotion license first).
- Open for discussion (spec §12): banned-topic ground (ground values ≥ 3 are reserved), real token issuance, governance over existing markets.
