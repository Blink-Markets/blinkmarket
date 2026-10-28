---
title: Market lifecycle
description: How a Blink market moves from creation to FINAL, who may make each transition, and how shares are redeemed.
group: How markets work
order: 1
agentTask: explain which state a market is in and what can happen next
---

# Market lifecycle

Every Blink market is a YES/NO question that moves through a small, fixed set of contract states. Each transition is a contract call with a time condition, and none of them needs a person or the platform. The rules apply to the Base Sepolia testnet (chain ID 84532), where bUSD has no value.

## What states can a market be in?

A market stores one of six states. `OPEN` is closed for trading once the clock passes `closeAt`; no transaction is needed for that.

| State | Meaning |
| --- | --- |
| `PENDING` | Created, in its creation window. A challenger may challenge the creation until `openAt`. A challenge does not change the state: the market stays `PENDING` with `creationChallenged` set while jurors decide. |
| `OPEN` | Quotes can be filled until `closeAt`. After `closeAt` the market is closed to trading and a result can be proposed. |
| `PROPOSED` | A proposer has submitted an outcome (`YES` or `NO`; `INVALID` cannot be proposed), its evidence hash and a bond. A challenge window runs. |
| `DISPUTED` | The proposed result was challenged. Jurors decide by commit and reveal; the losing side may appeal. (A creation challenge keeps the market `PENDING`.) |
| `FINAL` | The outcome is fixed and cannot be changed. Holders can redeem. |
| `CANCELLED` | A creation challenge was upheld. The market never opened and trades nothing. A rejected creation challenge opens the market (`OPEN`) instead. |

## How does a market move between states?

| Call | Who | Condition | Result |
| --- | --- | --- | --- |
| `BlinkMarkets.createMarket` | A creator (role CREATOR) | Valid spec and times; within the security bound and the creator's exposure limit; creation bond posted | `PENDING` |
| `BlinkResolution.challengeCreation` | A challenger | `PENDING`, before `openAt`, evidence hash set | A creation dispute opens; the market stays `PENDING` with `creationChallenged` set while jurors decide |
| `BlinkMarkets.open` | Anyone | `PENDING`, `openAt` passed, not creation-challenged | `OPEN` |
| `BlinkMarkets.fillQuote` | The named taker, with a maker's signed quote | `OPEN`, before `closeAt`, balances and caps hold | A position; the market stays `OPEN` |
| `BlinkResolution.propose` | A proposer | `OPEN`, from `closeAt` until `proposalDeadline`, once per market; bond posted | `PROPOSED` |
| `BlinkResolution.challengeResult` | A challenger | `PROPOSED`, before the proposal's `challengeEnd`, evidence hash set; bond posted | `DISPUTED` |
| `BlinkResolution.finalizeUnchallenged` | Anyone | `PROPOSED`, challenge window over | `FINAL` with the proposed outcome |
| `BlinkResolution.settleRound` | Anyone | The round's reveal phase is over | The round's result, or a restart if it missed quorum or tied |
| `BlinkResolution.appeal` | The losing side | The round's appeal phase; a doubled bond; below `maxRounds`; time left for a new round before `hardDeadline` | A new round |
| `BlinkResolution.finalizeDispute` | Anyone | The settled round's appeal phase is over | Result dispute: `FINAL` with the jurors' outcome. Creation dispute: `CANCELLED` if the challenge is upheld, `OPEN` if it is rejected |
| `BlinkResolution.finalizeTimeout` | Anyone | Neither `FINAL` nor `CANCELLED`, and `hardDeadline` passed | `FINAL` with outcome `INVALID` |
| `BlinkMarkets.redeem` | A share holder | `FINAL` | Shares burned, payout sent |
| `BlinkMarkets.distributeFees` | Anyone (the caller earns a tip) | `FINAL`, once | The fee pool is split |

The windows (`creationWindow`, `resultChallengeWindow`, `commitSeconds`, `revealSeconds`, `appealSeconds`) and the number of appeal rounds (`maxRounds`) are fields of `params`; read them from `GET /v1/deployment`. The first use of a template gets a longer creation window (`firstUseExtraWindow`). Every deadline is a block timestamp, so compare with the latest block, not your own clock.

## What happens in a dispute?

1. A challenger posts a bond and evidence. A creation challenge names one of three grounds (see [Trust](/docs/trust) for the numbering).
2. Jurors who staked before the round began commit a hashed vote, then reveal it. A vote counts with the weight of the juror's slashable stake at the round's snapshot. Credit does not change the weight.
3. After the reveal phase `settleRound` counts the revealed weight. A round whose committed weight is below the quorum, or that ties, restarts; it does not become INVALID. Revealed votes that differ from the final outcome and unrevealed commitments are slashed.
4. The losing side may appeal with a doubled bond, up to `maxRounds` rounds. Higher rounds can require credit (`roundCreditThreshold`) once the generation has finalized enough markets.
5. When the last round's appeal phase passes, `finalizeDispute` fixes the outcome. A challenge that does not overturn the original loses its bond.

A dispute that is still unfinished at `hardDeadline` ends as INVALID through `finalizeTimeout`; the challenger's bond is forfeited in that case.

## What happens if nobody acts in time?

If the market is not `FINAL` by `hardDeadline`, anyone can call `finalizeTimeout` and the outcome is INVALID. That applies if nobody proposes, if a proposal is not finalized and if a dispute is unfinished. After `hardDeadline` no late proposal or vote counts; only the timeout remains. The creator must choose the schedule so that `proposalDeadline` leaves room for a challenge window and every round of a dispute before `hardDeadline`.

## How are shares paid out?

One complete set, one YES share plus one NO share, is collateralised with 1 bUSD (1,000,000 micros). Shares are integers held in the market's ledger, not tokens. After `FINAL`, each holder redeems their own shares:

| Final outcome | Each YES share pays | Each NO share pays |
| --- | --- | --- |
| `YES` | 1 bUSD | 0 |
| `NO` | 0 | 1 bUSD |
| `INVALID` | 0.5 bUSD | 0.5 bUSD |

Example: buying 100 YES shares at 6,000 bps costs the taker 60 bUSD and the maker 40 bUSD, so the contract holds 100 bUSD. `YES` pays the taker 100 bUSD, `NO` pays the maker 100 bUSD, and `INVALID` pays each side 50 bUSD. The taker also pays the fee (`feeBps`) on top of the price.

`FINAL` is irreversible and no function changes a result. There is no early exit: no transfer, sell-back, merge or partial fill exists. Redeeming never stops, so a holder can always collect.

## How final is a transaction?

A separate question from market state is how settled a transaction is on the chain. `POST /v1/transactions` tracks a hash your wallet sent, and `GET /v1/transactions/{txHash}` answers one of `UNKNOWN`, `INCLUDED`, `FINALIZED`, `REVERTED` or `REORGED`.

- `UNKNOWN` is not failure. A missing receipt never justifies sending a second economic intent: read the state (an event, `consumed(digest)`, a position) first.
- `INCLUDED` and `FINALIZED` are different levels. Do not treat a fixed number of blocks as Base L1 finality.
- Expect a wait. When measured on 2026-10-21, Base Sepolia's finalized block trailed the latest block by 14 to 33 minutes, so a transaction can stay `INCLUDED` that long before it becomes `FINALIZED`.

## Hand it to your agent

```prompt
Read https://blink-markets.github.io/blinkmarket/docs/lifecycle.md and explain the lifecycle of a Blink market. Hard rules: Base Sepolia testnet only (chain ID 84532); bUSD has no value. Do not create wallets, request keys, or sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals. Given a market state and the current time relative to openAt, closeAt, proposalDeadline and hardDeadline, say which transitions are allowed, who may call them, and what INVALID would pay per share.
```

## Next steps

- [Architecture](/docs/architecture) shows which processes the platform runs and what it cannot do.
- [Roles](/docs/roles) explains who acts at each stage.
- [Contracts](/docs/contracts) lists the calls named above.
