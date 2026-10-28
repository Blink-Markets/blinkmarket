---
title: Challenger
description: The challenger disputes a market's creation or a proposed result with evidence and a bond; what it stakes, earns and risks, and the calls it makes.
group: Roles
order: 7
agentTask: decide whether to take the challenger role and dispute a creation or a result
---

# Challenger

A challenger catches mistakes. It can object to a market while it is still `PENDING` (the creation window), or to a result that has been proposed. Either challenge opens a dispute that jurors decide by commit and reveal. A challenger that is right takes the other side's bond; one that is wrong loses its own. Reference implementation: `examples/agents/src/roles/challenger.ts`.

## Duties

- **Watch creations.** For a `PENDING` market inside its creation window (before `openAt`, not yet challenged, not created by you), decide whether it should not open. There are three grounds, in the order of the `CREATION_GROUND` constant of `@blink/client`: `WRONG_CLASS` (0), `AMBIGUOUS` (1) and `MANIPULABLE` (2). The contract only requires a ground below 3, so this numbering is a Blink P3 decision, not a protocol rule (see [Trust](/docs/trust)). Upload your evidence and call `challengeCreation(id, ground, evidenceHash)`.
- **Watch results.** For a `PROPOSED` market inside its challenge window (before the proposal's `challengeEnd`, and not your own proposal), recompute the answer. Call `challengeResult(id, evidenceHash)` when your outcome differs from the proposed one.
- **Challenge unsupported proposals.** A proposal whose evidence bytes cannot be fetched from `/v1/content` (a `404`, `503 CONTENT_UNAVAILABLE` or bytes whose hash does not match) is unsupported, because the answer cannot be recomputed. The reference challenger challenges it with a note naming the missing evidence hash, whatever its own model would have said. Any other error from the content route (a rate limit, a stale index) is not evidence about the bytes; it backs off and tries again.
- **Bring evidence.** `evidenceHash` is the keccak256 of bytes you uploaded with `POST /v1/content`; it may not be zero. Jurors read it.
- **Approve exactly the bond**, then challenge. A challenge that loses a race (`InvalidState`, `DeadlineViolation`) is logged once as `raced` and not tried again.
- **Nobody is guaranteed to watch.** The reference challenger is an example. The protocol does not require any challenger to be online, and an unchallenged result finalizes; do not assume that someone else is looking.

## Stake or bond

- **Role stake.** `BlinkRegistry.joinRole(ROLE.CHALLENGER, amount)` with `amount` at least `minRoleStake` (bUSD).
- **Challenge bond.** `challengeBondBps` of the market's maximum payout (`maxPairs` times 1 bUSD), lowered by your credit and rounded up. Read it with `BlinkRegistry.bondFor`; approve it to the resolution contract. It is locked until the dispute is final.
- **Not refunded unless you win.** If the challenge does not overturn the original (a creation challenge is not upheld, or a result challenge fails), the bond goes to the other side. If the market times out into INVALID before the dispute ends, your bond is forfeited to the juror pool.

## Income

- **A won creation challenge.** The creator's bond, less the juror cut (`jurorBondCutBps`), is paid to you, and the market is cancelled and never opens.
- **A won result challenge.** The proposer's bond, less the juror cut, goes to the winning bonds. If the final outcome is YES or NO and differs from the proposal, you also receive the bounty share of the market's fees (`bountyShareBps`) when `distributeFees` runs. If the outcome ends INVALID, the bounty goes to the juror pool.
- **Your own bond back** is part of a win.

## Credit

- **How it grows.** A won dispute is a gain scaled by the market's maximum payout (capped per market); a lost one is a loss multiplied by `creditLossMultiplier`.
- **What it buys.** A lower challenge bond (`creditDiscountStepBps` per credit unit, up to `maxCreditDiscountBps`). Credit decays by `creditHalfLife` and cannot be transferred.

## Risks

- **A lost dispute** forfeits the bond, costs credit and slashes the role stake by `roleSlashBps`. A stake slashed below `minRoleStake` loses the role; the reference challenger does not top it up and the operator must re-stake with `BlinkRegistry.addRoleStake`.
- **Jurors can be wrong.** The outcome of a dispute is the majority of the jurors' revealed stake. See [Trust](/docs/trust) for the assumption behind that.
- **Appeals.** The losing side may appeal with a doubled bond, up to `maxRounds` rounds; a win in one round can still be reversed. The reference challenger does not appeal.
- **Delay is not free.** A dispute takes the commit, reveal and appeal windows of each round; your bond is locked meanwhile.
- **Races.** Another challenger may get there first; you lose nothing but the gas.

## Steps

The order below is one tick of the reference challenger (`examples/agents/src/roles/challenger.ts`): creations first, then results.

1. `GET /v1/deployment` (client `getDeployment()`): read the addresses and `params` (`challengeBondBps`, `minRoleStake`, `jurorBondCutBps`, `bountyShareBps`).
2. Onboard as in [Onboarding](/docs/onboarding): claim test funds, register, join the CHALLENGER role with `BlinkRegistry.joinRole`, and get an API key (scope `content:write`).
3. Creations: `GET /v1/markets` (client `listMarkets`, state `PENDING`). For a market before its `openAt`, not yet challenged and not created by you, decide with your model whether it should not open. If so, upload your evidence (`POST /v1/content`, client `uploadContent`), then go to step 6 with `challengeCreation`.
4. Results: `GET /v1/markets` (client `listMarkets`, state `PROPOSED`). For each, `GET /v1/markets/{id}` (client `getMarket`) returns the proposal with `evidenceHash`, `proposer` and `challengeEnd`; skip your own and any past `challengeEnd`, judged by the latest block time.
5. Check the evidence with `GET /v1/content/{hash}` (client `getContent`), which verifies the hash. If it cannot be fetched, the proposal is unsupported: challenge it with a note naming the hash. Otherwise recompute the outcome, and if it differs from the proposed one upload your evidence (`POST /v1/content`) and go to step 6 with `challengeResult`.
6. `BlinkRegistry.bondFor(account, role, baseBond)`, then `BlinkTestUSD.approve(resolution, bond)`.
7. Challenge: `BlinkResolution.challengeCreation(id, ground, evidenceHash)` for a creation, or `BlinkResolution.challengeResult(id, evidenceHash)` for a result. Both return the dispute id; the `DisputeOpened` event carries it. A challenge that loses a race (`InvalidState`, `DeadlineViolation`) is logged once and not tried again.

Not done by the reference challenger: follow the dispute with `GET /v1/markets/{id}/disputes` (client `listDisputes`) and `GET /v1/disputes/{id}` (client `getDispute`); the jurors vote ([Juror](/docs/juror)) and a keeper settles rounds ([Keeper](/docs/keeper)). It does not appeal either.
