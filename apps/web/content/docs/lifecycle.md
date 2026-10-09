---
title: Market lifecycle
description: How a Blink market moves from OPEN to FINAL, and how shares are redeemed.
group: How Blink works
order: 1
agentTask: explain which state a market is in and what can happen next
---

# Market lifecycle

Every Blink market is a YES/NO question that moves through a small, fixed set of contract states. The rules below come from the MVP specification (section 6.2) and apply to the Base Sepolia testnet (chain ID 84532), where bUSD has no value.

> [!PLANNED]
> No market contract is deployed yet, so no market has gone through this lifecycle on a public chain. The state machine is implemented and tested locally. Status: Planned.

## What states can a market be in?

A market stores one of four states: `OPEN`, `PROPOSED`, `DISPUTED` or `FINAL`. `CLOSED` is not stored. An `OPEN` market is treated as `CLOSED` once `now >= closeAt`, so closing never waits for a keeper to send a transaction. Pausing is a separate switch that only stops new trades.

| State | Meaning |
| --- | --- |
| `OPEN` | Quotes can be filled until `closeAt`. |
| `CLOSED` (derived) | An `OPEN` market whose `closeAt` has passed. Trading has stopped; an outcome can be proposed. |
| `PROPOSED` | An outcome (`YES`, `NO` or `INVALID`) and its evidence hash have been submitted. A challenge window is running. |
| `DISPUTED` | The proposal was challenged with evidence. An arbiter must decide. |
| `FINAL` | The outcome is fixed and cannot be changed. Holders can redeem. |

## How does a market move between states?

Each transition is a contract function with a required role and time condition.

| Function | Who | Condition | Result |
| --- | --- | --- | --- |
| `createMarket` | ADMIN | Valid specification and times | New market in `OPEN` |
| `fillQuote` | Taker (with a signed quote) | `OPEN`, `now < closeAt`, not paused | Position created; stays `OPEN` |
| `proposeOutcome` | RESULT_PROPOSER | `OPEN` and `closeAt <= now < proposalDeadline`; one proposal only | `PROPOSED` |
| `challengeOutcome` | CHALLENGER | `PROPOSED`, before the challenge window ends, non-empty evidence hash; no bond | `DISPUTED` |
| `finalizeUnchallenged` | Anyone | `PROPOSED`, challenge window over, `now < hardDeadline` | `FINAL` with the proposed outcome |
| `arbitrate` | ARBITER | `DISPUTED`, `now < hardDeadline`, decision evidence hash | `FINAL` with the arbiter's outcome |
| `finalizeTimeout` | Anyone | Not `FINAL` and `now >= hardDeadline` | `FINAL` with outcome `INVALID` |
| `redeem` | Share holder | `FINAL` | Shares burned, payout sent |

## What does a proposal, a challenge and arbitration look like?

1. After `closeAt`, a human result proposer submits `YES`, `NO` or `INVALID` plus an evidence hash. This can happen once.
2. A challenger can dispute the proposal during the challenge window. The challenge needs a non-empty evidence hash. The window is 86,400 seconds (24 hours) for `LIVE` markets and 120 seconds for `REPLAY` markets, as enforced by the shared specification schema.
3. If nobody challenges, anyone can finalize the proposed outcome once the window is over.
4. If someone challenges, an arbiter records a decision and its evidence hash, and the market becomes `FINAL`.

Models hold no keys and no adjudication authority. Proposals, challenges and arbitration are done by people holding the explicit roles above.

## What happens if nobody acts in time?

If the market is not `FINAL` by `hardDeadline`, anyone can call `finalizeTimeout`, and the outcome is fixed to `INVALID`. This also applies to an unchallenged proposal that nobody finalized in time. After `hardDeadline`, late proposals and late arbitration are not allowed; only the timeout path remains. The specification requires this fail-safe rule to appear in the market specification and on the trade confirmation page.

## How are shares paid out?

One complete set is 1,000,000 base units, which is 1 bUSD. After `FINAL`, each holder redeems their own shares:

| Final outcome | Each YES share pays | Each NO share pays |
| --- | --- | --- |
| `YES` | 1 bUSD | 0 |
| `NO` | 0 | 1 bUSD |
| `INVALID` | 0.5 bUSD | 0.5 bUSD |

Example from the README: buying 100 YES shares at 6,000 bps costs the taker 60 bUSD and the maker 40 bUSD, so the contract holds 100 bUSD. `YES` pays the taker 100 bUSD, `NO` pays the maker 100 bUSD, and `INVALID` pays each side 50 bUSD.

`FINAL` is irreversible and there is no admin function to change a result. Pausing stops only new fills; proposing, challenging, finalizing and redeeming keep working.

## How final is a transaction?

A separate question from market state is how settled a transaction is on the chain. The specification tracks transaction states `CREATED`, `SIGNED`, `SUBMITTED`, `PRECONFIRMED` (if the RPC supports it), `INCLUDED` and `FINALIZED`, plus the branches `REVERTED`, `REPLACED`, `UNKNOWN` and `REORGED`.

- `UNKNOWN` is not failure. A missing receipt never justifies automatically sending a new economic intent.
- `PRECONFIRMED` is only a hint. It does not count as a settled position.
- `INCLUDED` and `FINALIZED` are different levels. Do not treat a fixed number of blocks as Base L1 finality.

The current market-creation tracker applies a fixed observation policy of 12 confirmations. That is explicitly not Base L1 finality; see `docs/M2_CREATION_TRACKING.md`.

## Hand it to your agent

```prompt
Explain the lifecycle of a Blink market using /docs/lifecycle. Constraints: Base Sepolia testnet (chain ID 84532); bUSD has no value; there is no public deployment or API host. Do not create wallets or request keys, and do not sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals for external users. Given a market state and the current time relative to closeAt, proposalDeadline and hardDeadline, say which transitions are allowed, who may perform them, and what INVALID would pay per share.
```

## Next steps

- [Architecture](/docs/architecture) shows which processes own each part of this flow.
- [Status](/docs/status) lists what runs locally today.
- [API reference](/docs/api) lists the HTTP endpoints.
