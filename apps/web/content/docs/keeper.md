---
title: Keeper
description: The keeper calls the permissionless transitions that follow a deadline, so that markets open, settle and pay out on time; what it earns and risks, and the calls it makes.
group: Roles
order: 9
agentTask: run a keeper that advances markets after their deadlines
---

# Keeper

Every state change that follows a deadline is permissionless: anyone may call it, and the contracts check only the state and the clock. A keeper is any agent that does so. It has no authority, cannot change a result and holds no role. Reference implementation: `examples/agents/src/roles/keeper.ts`.

## Duties

Each tick the reference keeper lists the markets in each live state and calls whichever transition is due, judged by the latest block time:

- **Open a market** after its creation window: `open` on a `PENDING` market whose `openAt` has passed and that is not creation-challenged.
- **Finalize an unchallenged proposal** after its challenge window: `finalizeUnchallenged` on a `PROPOSED` market whose proposal's `challengeEnd` has passed.
- **Time out** a market that is not final at its `hardDeadline`: `finalizeTimeout` in any non-final state. The outcome becomes INVALID, and each share on either side pays half.
- **Settle a dispute round** once its reveal phase is over: `settleRound`. A round that misses quorum or ties restarts instead of settling; it is not INVALID.
- **Finalize a dispute** once the settled round's appeal window has passed: `finalizeDispute`.
- **Distribute the fees** of a `FINAL` market: `distributeFees`, once per market.
- **Anchor forecast roots.** For every closed forecast window whose root `BlinkAnchor` does not hold, call `anchor(root)`; `anchoredAt(root)` says whether it is held.
- **Lose races quietly.** Several keepers may run at once. A transaction that loses to another keeper (`InvalidState`, `AlreadySettled`, `AlreadyDistributed` or `AlreadyAnchored`) is logged once as `{"event":"raced"}` and the keeper moves on. Any other failure propagates, so a `429` or a stale index reaches the loop's backoff instead of becoming a retry storm.

## Stake or bond

None. A keeper holds no role and posts no stake or bond, and nothing on chain requires it to register. The reference keeper is onboarded like every reference agent (it registers and gets an API key), but it only uses public reads.

## Income

- **Execution tip.** `distributeFees` pays the caller `keeperTipBps` of the resolution share of the fee pool. That tip is the only payment a keeper receives.
- **The other transitions pay nothing**, so they cost gas and nothing more. A market that no keeper moves still times out, because anyone, including a trader or a creator, can send the call.

## Credit

Not counted. A keeper has no on-chain credit and needs none.

## Risks

- **Gas for nothing.** A transaction that loses a race still costs gas. Check the state and the time before you send, and expect to lose some.
- **Chain time, not yours.** Every deadline is a block timestamp. Compare with the latest block, not the host clock.
- **A stale or limited API.** The keeper reads market lists and disputes from the API. On `503 INDEX_STALE` or `429` it must wait for `Retry-After` and act on no stale read; the chain stays the source of truth for any call.
- **Polling cost.** The reference keeper reads one list per live state each tick, ten pages of 100 at most; a deployment with more markets in one state needs a cursor kept in state. A final market with a window that has no root is scanned again each tick.
- **No power over outcomes.** A keeper cannot choose a result, skip a deadline or change a payout; it only supplies the call.
- **Anchoring is optional.** Anchoring a root makes its first-seen time public; it does not change any score.

## Steps

The order below is one tick of the reference keeper (`examples/agents/src/roles/keeper.ts`): the states `PENDING`, `OPEN`, `PROPOSED`, `DISPUTED` and `FINAL`, in that order.

1. `GET /v1/deployment` (client `getDeployment()`): read the addresses, the anchor address and `params` (`keeperTipBps`).
2. Onboard as in [Onboarding](/docs/onboarding) if you want an API key; no role is needed.
3. For each state: `GET /v1/markets` (client `listMarkets`), and for each market in a state before `FINAL`:
   - If its `hardDeadline` has passed: `BlinkResolution.finalizeTimeout(id)`, and go to the next market.
   - `PENDING` with a creation challenge: drive its dispute (below). `PENDING` with no challenge and `openAt` passed: `BlinkMarkets.open(id)`.
   - `PROPOSED`: `GET /v1/markets/{id}` (client `getMarket`) returns the proposal and its `challengeEnd`; after it, `BlinkResolution.finalizeUnchallenged(id)`.
   - `DISPUTED`: drive its dispute.
4. Drive a dispute: `GET /v1/markets/{id}/disputes` (client `listDisputes`), then `BlinkResolution.getDispute(disputeId)` for the current round. After `revealEnd`, `BlinkResolution.settleRound(disputeId)`. After `appealEnd` of a settled round that did not restart, `BlinkResolution.finalizeDispute(disputeId)`.
5. For a `FINAL` market whose fees are not distributed: `BlinkMarkets.distributeFees(id)`.
6. For every market that is not `PENDING`, and not yet recorded as done: `GET /v1/markets/{id}/forecast-windows` (client `listForecastWindows`) lists each window's `root`; if `BlinkAnchor.anchoredAt(root)` is zero, call `BlinkAnchor.anchor(root)`.
