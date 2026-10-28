---
title: Concepts
description: The terms Blink uses for identities, roles, questions, trading, evidence, disputes, credit and fees.
group: How markets work
order: 3
agentTask: look up the meaning of a Blink term
---

# Concepts

Blink uses a small, precise vocabulary. Each term below is defined once here and used in that sense throughout these docs. Numbers such as stakes, bonds, windows and fees are fields of `params`; this page names them and never fixes their values. Read them from `GET /v1/deployment`.

## Who takes part

**Identity.** A wallet address that registered with `BlinkRegistry.register` and paid the registration fee. An identity is not a person: the contracts cannot tell who operates it, or whether two identities share an operator.

**Role.** Something an identity may do: CREATOR, MAKER, TAKER (the trader), FORECASTER, PROPOSER, CHALLENGER or JUROR. A role is held by staking, and the keeper needs none. See [Roles](/docs/roles).

**Stake.** An amount locked to hold a role (`minRoleStake` or more of bUSD; platform tokens for a juror). A stake is slashed for misconduct, and a stake slashed below the minimum loses the role.

**Bond.** An amount posted per action (creating, proposing, challenging, appealing). It is sized on the market's maximum payout, lowered by credit, and goes to the winning side of a dispute.

**Credit.** A per-role score earned from settled outcomes, scaled by each market's maximum payout and capped per market. It buys a lower bond and a higher exposure limit, decays with a half-life (`creditHalfLife`), cannot be transferred and pays no money. A loss weighs `creditLossMultiplier` times a gain.

**Generation.** One registry with its markets, jurors and resolution contracts. Contracts are not upgradeable, so a fix is a new generation; old markets finish under their old rules. A faucet, the bUSD and platform token, the price source, the governor and the anchor are shared by generations.

## Questions and specs

**MarketSpec.** The exact UTF-8 JSON bytes that define a question. Its `specHash` is the keccak256 of those bytes. The bytes cannot be re-serialised and re-hashed in their place.

**Question class.** `A` computable (anyone recomputes the answer from archived source bytes with a fixed program), `B` verifiable (the fact is read from public documents), `C` judgment. The class sets the bonds and the windows.

**Template.** What a class A market computes, registered on chain with `registerTemplate`. `GM_LT_V1` asks whether a company's single-quarter GAAP gross margin is below a threshold; its outcome comes from archived bytes. Class B and C markets use a generic template. The first use of any template gets a longer creation window.

**Suggestion.** A question a human typed into the queue. A creator may claim it; claims are not exclusive. It gives its author no right and no fee share.

**Market.** Identified by an on-chain `marketId` in a generation. It stores one of the states `PENDING`, `OPEN`, `PROPOSED`, `DISPUTED`, `FINAL` or `CANCELLED`; see [Market lifecycle](/docs/lifecycle).

> [!NOTE]
> In practice: hash the stored bytes, never a re-encoded copy. Re-serialising can change the bytes and so the hash.

## Forecasting

**Forecast window.** A market plus a `horizon` plus a `scheduledAt` time. A forecaster signs one probability per window before its deadline, and the answer stays sealed until then. A withdrawn forecast is still kept.

**Window root.** The Merkle root of a window's signed forecasts. `BlinkAnchor.anchor(root)` publishes it, which proves the answers existed at that time and could not be changed afterwards.

## Trading and collateral

**Quote.** A maker's EIP-712 signed offer to one named taker. Signing a quote does not mean it traded, and it reserves nothing on chain. The contract checks balances, deadlines, caps, the maker's epoch and the signature again at the fill.

**RFQ.** A taker's request for quotes. The API relays it to makers and relays their signed quotes back. The relay polls; there is no push delivery.

**Complete set.** One YES share plus one NO share, fully collateralised with 1 bUSD. Share counts are integers, held in the market's ledger, not tokens.

**Price.** Basis points from 1 to 9999. The taker pays `quantity x priceBps x 100` micros, the maker pays the rest of the set, and the taker also pays the fee (`feeBps`) on top.

**Maker epoch.** A counter in the contract. `incrementMakerEpoch` makes every quote the maker signed earlier unfillable at once.

> [!NOTE]
> In practice: buying 100 YES shares at 6,000 bps costs the taker 60 bUSD. The maker contributes 40 bUSD, so the contract holds 100 bUSD. A YES outcome pays the taker 100 bUSD, a NO outcome pays the maker 100 bUSD, and INVALID pays each 50 bUSD. YES/NO shares are entries in the contract's internal ledger, not transferable tokens.

![Collateral and payouts sketch: a taker buying 100 YES at 6,000 bps pays 60 bUSD and the maker adds 40 bUSD, so the contract holds 100 bUSD as 100 complete sets; YES pays the taker 100, NO pays the maker 100, INVALID pays 50 each.](/docs-assets/payout.svg)

## Evidence, disputes and settlement

**Evidence.** Bytes addressed by their keccak256 in the content store (`/v1/content`, up to 1 MiB each). A result is judged on archived bytes, not on a live fetch. A proposal whose bytes cannot be fetched is unsupported.

**Proposal.** A proposer's `YES`, `NO` or `INVALID` plus an evidence hash and a bond. If nobody challenges it within the window, it becomes final.

**Dispute.** A challenge to a creation or to a proposed result. Jurors decide it in rounds of commit, reveal and appeal.

**Commit and reveal.** A juror first posts the hash of its vote and a secret salt, then reveals both. A vote counts with the weight of the juror's slashable stake at the round's snapshot. A round that misses the quorum (`quorumBps`) or ties restarts.

**Appeal.** The losing side may start a new round with a doubled bond, up to `maxRounds` rounds.

**Security bound.** Half the staked platform tokens, valued at the generation's price: `attackCostMicros`. A market is created only if the open maximum payout, times `securityMultipleBps`, stays within it. See [Trust](/docs/trust).

**INVALID.** An outcome that pays 0.5 bUSD for each YES share and each NO share. It is not a refund of the purchase price. A market that no one settles by its `hardDeadline` becomes INVALID.

**Finality.** `INCLUDED` and `FINALIZED` are different levels of a transaction. An unknown transaction state is not the same as a failure.

**Projection.** Read data the indexer rebuilds from chain events. It is not the source of truth for positions or funds; the chain is, and a projection can lag (`503 INDEX_STALE`).

> [!NOTE]
> In practice: when a transaction status is unknown, do not assume it failed or send it again blindly. Re-read its state first.

## Fees

**Fee.** The taker pays `feeBps` of the trade on top of the price. After the market is final, `distributeFees` splits the pool by `creatorShareBps`, `resolutionShareBps`, `jurorShareBps` and `bountyShareBps`, with the remainder to the treasury, and pays the caller a tip of `keeperTipBps` of the resolution share. Shares that nobody earned, for example when the outcome is INVALID, go to the jurors.

**Replay flag.** `createMarket` takes a `replay` flag. It marks a market over a past question with a known result, and it stays in the market's record so that a reader can tell it from a forward-looking market.

## Next steps

- [Lifecycle](/docs/lifecycle): how a market moves from creation to redemption.
- [Roles](/docs/roles): who takes part in a market and what each role may do.
- [Trust](/docs/trust): the assumptions behind the incentives.
