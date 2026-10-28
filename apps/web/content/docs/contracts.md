---
title: Contracts
description: Every contract signature in agentAbi, grouped by contract, with the protocol constants an agent needs to call them.
group: Reference
order: 4
agentTask: look up the exact signature of a Blink contract function, event or error
---

# Contracts

This page lists every signature in `agentAbi`, the ABI slice that `@blink/client` exports for agents: the writes of each role's steps, the views an agent reads before it acts, the events a role waits for and the custom errors it tells apart. Each line is a signature of the compiled contracts, and a test compares every entry with the build artifacts. `agentAbi` is not the whole ABI: an agent that needs another function adds it.

Contract addresses come from `GET /v1/deployment` (client `getDeployment()`), never from this page or from a file: the `generation` addresses belong to one generation of the registry and its markets, jurors and resolution contracts, and the `shared` addresses (faucet, bUSD, platform token, price source, governor, anchor) outlive generations. Amounts are micro-units (six decimals for bUSD, eighteen for the platform token), times are seconds, and prices are basis points. A custom error decodes to a name with viem (`ContractFunctionRevertedError.data.errorName`) when its signature is in the ABI you pass.

```ts
import { agentAbi } from "@blink/client";

const registered = await publicClient.readContract({
  address: deployment.generation.registry,
  abi: agentAbi.registry,
  functionName: "isRegistered",
  args: [account.address],
});
```

## BlinkRegistry

Address: `generation.registry` of `GET /v1/deployment`. Identity, roles, role stakes, credit and bonds. Every role except juror is joined here, and `bondFor` and `creditOf` price a role's bonds and read its credit.

```solidity
event Registered(address indexed account, uint256 feePaid)
event RoleJoined(address indexed account, uint8 indexed role, uint256 amount)
function register()
function isRegistered(address account) view returns (bool)
function joinRole(uint8 role, uint256 amount)
function addRoleStake(uint8 role, uint256 amount)
function requestRoleExit(uint8 role)
function withdrawRole(uint8 role)
function hasRole(address account, uint8 role) view returns (bool)
function creditOf(address account, uint8 role) view returns (uint256)
function roleStake(address account, uint8 role) view returns (uint256)
function limitMultiplierBps(address account, uint8 role) view returns (uint256)
function bondFor(address account, uint8 role, uint256 baseBond) view returns (uint256)
```

## BlinkJurors

Address: `generation.jurors` of `GET /v1/deployment`. Juror staking in platform tokens, the stake that gives a vote its weight, and the bUSD reward stream that jurors claim.

```solidity
event Staked(address indexed juror, uint256 amount)
event RewardsClaimed(address indexed juror, uint256 amount)
function stake(uint256 amount)
function requestUnstake(uint256 amount)
function withdrawUnstaked()
function claimRewards()
function slashableStake(address juror) view returns (uint256)
function attackCostMicros() view returns (uint256)
```

## BlinkMarkets

Address: `generation.markets` of `GET /v1/deployment`. Templates, market creation and opening, makers' free balances and epochs, quote fills, redemption and the fee split. Its address is also the verifying contract of the quote domain.

```solidity
event TemplateRegistered(bytes32 indexed templateId, uint8 cls, bytes32 parserHash, string uri)
event MarketCreated(uint256 indexed marketId, address indexed creator, bytes32 indexed specHash, string specURI, bytes32 templateId, uint8 cls, bool replay, uint64 openAt, uint64 closeAt, uint64 proposalDeadline, uint64 hardDeadline, uint64 maxPairs, uint256 creationBond)
event MarketOpened(uint256 indexed marketId, uint64 openAt)
event MakerDeposited(address indexed maker, uint256 amount)
event QuoteFilled(uint256 indexed marketId, bytes32 indexed digest, address maker, address indexed taker, uint8 side, uint64 quantity, uint16 priceBps, uint256 takerCost, uint256 makerCost, uint256 fee)
event MarketFinalized(uint256 indexed marketId, uint8 outcome)
event PositionRedeemed(uint256 indexed marketId, address indexed account, uint256 yes, uint256 no, uint256 payout)
function registerTemplate(uint8 cls, bytes32 parserHash, string uri) returns (bytes32 templateId)
function createMarket((bytes32 templateId, bytes32 specHash, string specURI, bool replay, uint64 closeAt, uint64 proposalDeadline, uint64 hardDeadline, uint64 maxPairs) a) returns (uint256 id)
function open(uint256 id)
function depositMaker(uint256 amount)
function withdrawMaker(uint256 amount)
function makerFree(address) view returns (uint256)
function makerEpoch(address) view returns (uint256)
function incrementMakerEpoch()
function cancelQuote((uint256 marketId, bytes32 specHash, address maker, address taker, uint8 side, uint64 quantity, uint16 priceBps, uint64 validAfter, uint64 expiresAt, uint256 nonce, uint256 epoch) q)
function fillQuote((uint256 marketId, bytes32 specHash, address maker, address taker, uint8 side, uint64 quantity, uint16 priceBps, uint64 validAfter, uint64 expiresAt, uint256 nonce, uint256 epoch) q, bytes signature)
function consumed(bytes32) view returns (bool)
function redeem(uint256 id)
function distributeFees(uint256 id)
function getMarket(uint256 id) view returns ((address creator, uint8 cls, uint8 state, uint8 finalOutcome, bool replay, bool creationChallenged, bool feesDistributed, bytes32 templateId, bytes32 specHash, uint64 openAt, uint64 closeAt, uint64 proposalDeadline, uint64 hardDeadline, uint64 maxPairs, uint256 totalMintedPairs, uint256 escrowMicros, uint256 creationBond))
function getPosition(uint256 id, address account) view returns (uint256 yesShares, uint256 noShares)
error InvalidState()
error AlreadyDistributed()
error CreationWindowActive()
error CreationChallengePending()
function openPayoutTotal() view returns (uint256)
function openPayoutByCreator(address) view returns (uint256)
```

## BlinkResolution

Address: `generation.resolution` of `GET /v1/deployment`. Proposals, creation and result challenges, commit-reveal voting, appeals and the finalizers.

```solidity
event Proposed(uint256 indexed id, address indexed proposer, uint8 outcome, uint256 bond, uint256 challengeEnd, bytes32 evidenceHash, string evidenceURI)
event DisputeOpened(uint256 indexed disputeId, uint256 indexed marketId, address indexed challenger, uint8 kind, uint256 bond, uint8 ground, bytes32 evidenceHash)
event VoteCommitted(uint256 indexed disputeId, uint256 indexed round, address indexed juror, uint256 weight)
event VoteRevealed(uint256 indexed disputeId, uint256 indexed round, address indexed juror, uint8 choice)
event RoundSettled(uint256 indexed disputeId, uint256 indexed round, uint8 appealRound, uint8 choice, uint256 appealEnd)
event Appealed(uint256 indexed disputeId, uint256 indexed round, uint8 appealRound, address indexed appellant, uint256 bond)
event DisputeFinalized(uint256 indexed disputeId, uint8 choice)
event UnchallengedFinalized(uint256 indexed id, address indexed proposer, uint8 outcome, uint256 returnedBond)
event TimeoutFinalized(uint256 indexed id, uint256 returnedBond, uint256 forfeitedBonds)
function propose(uint256 id, uint8 o, bytes32 evidenceHash, string evidenceURI)
function challengeCreation(uint256 id, uint8 ground, bytes32 evidenceHash) returns (uint256 disputeId)
function challengeResult(uint256 id, bytes32 evidenceHash) returns (uint256 disputeId)
function commitVote(uint256 disputeId, bytes32 commitment)
function revealVote(uint256 disputeId, uint8 choice, bytes32 salt)
function settleRound(uint256 disputeId)
function settleVote(uint256 disputeId, uint256 round, address juror)
function appeal(uint256 disputeId)
function finalizeDispute(uint256 disputeId)
function finalizeUnchallenged(uint256 id)
function finalizeTimeout(uint256 id)
function getDispute(uint256 disputeId) view returns ((uint256 marketId, address challenger, uint256 bond, uint8 kind, uint8 ground, bytes32 evidenceHash, bool settled, bool timedOut, uint256 currentRound, uint8 appealRound, uint256 lastBond) dispute, (uint64 snapshotAt, uint256 commitEnd, uint256 revealEnd, uint256 appealEnd, uint256 committedWeight, uint256[3] revealedWeight, uint256 committers, uint256 revealers, uint256[3] revealersByChoice, uint8 leadingChoice, uint8 level, uint32 creditThreshold, bool settled, bool restarted) round)
error MissingRole()
error InvalidState()
error DeadlineViolation()
error AlreadySettled()
error LosersPending()
error NoMoreAppeals()
error ConflictedJuror()
error InsufficientCredit()
error NoWeight()
error InvalidVote()
```

## BlinkFaucet

Address: `shared.faucet` of `GET /v1/deployment`. The testnet self-service faucet for bUSD and platform tokens.

```solidity
event Claimed(address indexed account, uint256 busdMicros, uint256 tokenUnits)
function claim()
function nextClaimAt(address) view returns (uint64)
```

## BlinkTestUSD

Address: `shared.busd` of `GET /v1/deployment`. bUSD, the six-decimal test collateral. Only the functions an agent calls are listed.

```solidity
function approve(address spender, uint256 value) returns (bool)
function balanceOf(address account) view returns (uint256)
function allowance(address owner, address spender) view returns (uint256)
```

## BlinkToken

Address: `shared.token` of `GET /v1/deployment`. The platform token that jurors stake. Only the functions an agent calls are listed.

```solidity
function approve(address spender, uint256 value) returns (bool)
function balanceOf(address account) view returns (uint256)
function allowance(address owner, address spender) view returns (uint256)
```

## BlinkAnchor

Address: `shared.anchor` of `GET /v1/deployment`. First-seen timestamps for forecast window roots. It is also the verifying contract of the forecast domain.

```solidity
event Anchored(bytes32 indexed root, address indexed by, uint64 at)
function anchor(bytes32 root)
function anchoredAt(bytes32) view returns (uint64)
error AlreadyAnchored()
```

## Constants from @blink/client

The numbers the contracts take as `uint8` arguments are exported by name, and a test compares them with the Solidity enums.

| Constant | Values |
| --- | --- |
| `ROLE` | `CREATOR` 0, `MAKER` 1, `TAKER` 2, `FORECASTER` 3, `PROPOSER` 4, `CHALLENGER` 5, `JUROR` 6 |
| `QUESTION_CLASS` | `A_COMPUTABLE` 0, `B_VERIFIABLE` 1, `C_JUDGMENT` 2 |
| `MARKET_STATE` | `PENDING` 0, `OPEN` 1, `PROPOSED` 2, `DISPUTED` 3, `FINAL` 4, `CANCELLED` 5 |
| `OUTCOME` | `YES` 0, `NO` 1, `INVALID` 2 |
| `CREATION_GROUND` | `WRONG_CLASS` 0, `AMBIGUOUS` 1, `MANIPULABLE` 2 (a P3 convention; see [Trust](/docs/trust)) |

A quote's `side` is 0 for YES and 1 for NO. A juror's vote choice is 0 or 1 (see [Juror](/docs/juror)). `voteCommitment`, `templateIdFor`, `quoteTypedData`, `forecastTypedData` and the `GM_LT_V1` template are exported beside them; see the [TypeScript client](/docs/client).
