# 01 — Contracts and Ledger Detailed Design

_Status: historical — v0.1 team-operated design baseline (2026-09-22), largely retired by the autonomous-market redesign of 2026-10-23 (§6). Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

Based on product spec §5–9 and §16–17. This document is an implementation blueprint. The existing IBlinkMarket is still an interface draft.

## Contract composition and deployment

BlinkTestUSD is a fixed-version standard ERC-20 with name="Blink Test USD", symbol=bUSD, decimals=6. Only the fixed faucet minter can mint. There is no upgrade, no arbitrary admin withdrawal, no transfer fee and no rebasing. The faucet's rolling 24h limit and the invited-address restriction are enforced by the restricted signer policy/service. The token itself must not be claimed to provide these limits.

BlinkMarket is intended to use version-locked EIP712, ECDSA, SafeERC20 and ReentrancyGuard. It does not write its own signature verification or token transfer wrapper. M1 installation verifies that the chosen library and compiler are compatible, and writes the lock/remapping/artifact.

Constructor parameters:
- collateral, maker, admin, resultProposer, challenger, arbiter.
- All addresses are non-zero. The five business roles are pairwise distinct. The maker must meet the EOA requirement at deployment time.
- collateral must have code and decimals=6. The deployment script checks that it is the TestUSD artifact of that release. It must not accept another token just because its decimals match.
- chainId is fixed at 84532. Local Foundry/Anvil uses the same chain ID. The deployment script and the constructor both reject mainnet, with no env bypass.
- There is no owner replacement, role rotation, delegatecall or upgrade entry.

Roles use an immutable address plus explicit function checks, with external getters. A generic AccessControl includes the ability to grant and revoke dynamically. The contract does not inherit its management interface directly, to avoid violating the fixed-role restriction. [OpenZeppelin access control documentation](https://docs.openzeppelin.com/contracts/5.x/access-control)

## Storage

| Scope | Fields | Purpose |
| --- | --- | --- |
| immutable | collateral, five roles | fixed deployment boundary |
| global | globalTradingPaused, makerFreeBalance, currentMakerEpoch, nextMarketId=1 | trading switch, withdrawable maker collateral |
| global | usedSpecHashes[hash], consumed[digest], cancelled[digest] | market creation and quote dedupe |
| global | takerAllowed[address] | controls new fills only |
| market | specHash/URI, mode, four time fields, caps | immutable after market creation |
| market | state, paused, proposedAt, proposedOutcome, finalOutcome, evidence hashes | state and audit |
| market | totalMintedPairs, escrowMicros | cumulative complete sets and remaining funds |
| market/account | yesShares, noShares, cumulativeTakerShares | redeemable positions and a cumulative cap that never goes to zero |

Storage may keep uint64 share counts and times. Multiplications are promoted to uint256 before computing. The external getter reports whether proposedOutcome/finalOutcome exists. It must not show the enum default YES as a decided YES. Internally, state can be used to tell whether an outcome exists.

totalMintedPairs and cumulativeTakerShares do not decrease on redeem. Market ID=0 or any ID not yet created is always MarketNotFound. Existence is not judged by the zero value OPEN of the enum.

## CreateMarket

ADMIN only. Rejects a zero or duplicate specHash, an empty URI and an invalid mode. Times must satisfy now < closeAt < proposalDeadline < hardDeadline, and hardDeadline-proposalDeadline > challengeSeconds.

LIVE challenge=86400. The REPLAY engineering profile is fixed at 120. maxPairs is 1..10000, and maxTakerShares is 1..500 and <=maxPairs. A single fill of 1..100 is a contract constant. The text content, sources and forecast rules are validated by the approval API. The contract must not be claimed to parse JSON.

Creating the market and MarketCreated happen in the same transaction. The market is mapped to its immutable parameters. The market starts OPEN, unpaused, with a zero ledger. A global pause does not affect the admin creating a market, but it does affect fills.

## Quote signature

The Quote struct has 11 fields in the same order as the existing interface. deploymentId is not added to the typed message. The deployment identity is committed by the domain's chainId/verifyingContract, and the API additionally compares it with the deployment manifest. name="Blink RFQ", version="0.1".

digest = the standard typed-data hash. The maker must be the fixed EOA, and the recovered signature address must match. Non-canonical ECDSA and a wrong domain are rejected. nonce is a random uint256 and is not used as a transaction nonce. Replay protection uses consumed/cancelled/currentMakerEpoch/expiry. EIP-712 does not provide these protections itself. [EIP-712](https://eips.ethereum.org/EIPS/eip-712)

## FillQuote

The whole function is nonReentrant. It checks and changes state in this order:

1. global / market not paused, market exists, OPEN and now<closeAt.
2. q.maker = the fixed maker, q.taker = msg.sender, takerAllowed=true, maker != taker. Admin and arbitration roles are not allowed on the taker list.
3. specHash equal, side=0/1, quantity 1..100, priceBps 1..9999.
4. totalMintedPairs+q.quantity <= maxPairs; cumulativeTakerShares+quantity <= maxTakerShares.
5. validAfter<=now<expiresAt<=closeAt, and expiresAt-validAfter<=60.
6. epoch equal; digest not consumed/cancelled; ECDSA verified.
7. Compute in uint256: notional=q*1000000, takerCost=q*priceBps*100, makerCost=notional-takerCost; free>=makerCost.
8. Set consumed=true, deduct free, add to escrow/pairs/cumulativeTakerShares, and add opposite share counts to the two parties.
9. SafeERC20.safeTransferFrom(taker, contract, takerCost). After it succeeds, emit QuoteFilled. If the transfer reverts, the whole state change rolls back.

A pre-check of taker balance/allowance may run before the effects to give a clear error. A successful real transfer is still required, and the pre-check is not treated as reentrancy protection. The fixed standard TestUSD is specified. Exotic token behavior is not supported.

## Collateral and redemption

depositMaker / withdrawMaker are maker only, with amount>0. deposit adds to free after the transfer in succeeds. withdraw checks free first, deducts the balance first, then transfers to the maker. Both are nonReentrant. There is no beneficiary parameter, no escrow rescue and no donation sweep.

redeem works only when FINAL. Any caller with a position can use it, including one removed from the allowlist and the maker. It does not check pause or trading eligibility. It reads both sides first. If both are zero it returns NoPosition. It zeroes both sides, computes the payout, deducts escrow, then transfers to the caller. If payout=0, no external token transfer is called, but the event is still emitted and the position is still zeroed.

| outcome | per YES share | per NO share |
| --- | ---: | ---: |
| YES | 1000000 | 0 |
| NO | 0 | 1000000 |
| INVALID | 500000 | 500000 |

For example, 100 YES @6000: the taker pays 60, the maker pays 40, and escrow is 100. On YES the payout is 100/0. On NO it is 0/100. On INVALID it is 50/50 bUSD. A maker redeem goes straight to the wallet and is not added to free.

## State and time boundaries

| Operation | Permission / prior state | Valid time | Next state / result |
| --- | --- | --- | --- |
| proposeOutcome | proposer / OPEN | closeAt<=now<proposalDeadline | PROPOSED; evidenceHash non-zero |
| challengeOutcome | challenger / PROPOSED | now<proposedAt+challengeSeconds | DISPUTED; evidenceHash non-zero |
| finalizeUnchallenged | anyone / PROPOSED | challengeEnd<=now<hardDeadline | FINAL; reuses the proposal evidence/outcome |
| arbitrate | arbiter / DISPUTED | now<hardDeadline | FINAL; decisionEvidenceHash non-zero |
| finalizeTimeout | anyone / not FINAL | now>=hardDeadline | FINAL INVALID; zero evidenceHash |
| redeem | self / FINAL | no deadline | clears the caller's own position |

At the instant of closeAt, fills are no longer allowed. CLOSED is a read-derived state of OPEN plus time. At the instant of hardDeadline, only timeout is allowed. An unchallenged proposal that was not finalized in time also becomes INVALID. A pause does not block the six operations above or the maker withdraw.

cancelQuote is maker only, with q.maker=maker and the digest not consumed. If it is already cancelled it is an idempotent no-op and does not emit the event again. It needs no quote signature, and it cancels the maker's own future signature over a specific payload. incrementMakerEpoch is maker only, with a checked increment.

## Errors / Views / Events

Recommended custom errors: UnauthorizedRole, InvalidAddress, WrongChain, MarketNotFound, InvalidSpec, DuplicateSpec, InvalidSchedule, InvalidCap, TradingPaused, MarketClosed, InvalidTaker, InvalidSide, InvalidQuantity, InvalidPrice, CapExceeded, InvalidQuoteTime, EpochMismatch, QuoteConsumed, QuoteCancelled, InvalidSignature, InsufficientMakerBalance, InvalidState, DeadlineViolation, EmptyEvidence, NoPosition.

The exact selectors are locked when M1 generates the ABI. See 02 for the API mapping. Not every revert may be turned into retryable.

Keep the existing §16 events. Add getters that read collateral/roles/global pause/takerAllowed/cumulativeTakerShares. The market getter separates the proposal from the final outcome. The evidence of every non-timeout outcome can be traced from state or events. The cost in QuoteFilled is computed by the contract. A cost supplied in calldata is not accepted.

## Acceptance

The full C01–C15. Also verify:
- The constructor rejects identical roles, zero addresses, a wrong chain and wrong asset metadata. There is no role-mutation selector.
- After receiving a donation, the contract only satisfies >=, and no function can take a donation or escrow out.
- The cap counts cumulative purchases. It cannot be bypassed by the opposite side or by redeem. The maker's opposite-side position does not apply the taker cap.
- If the oracle, DB and keeper are all unreachable, any wallet can still timeout/redeem.
- The ghost ledger invariant covers token failure, a reentry mock, all outcomes and arbitrary operation sequences.
