---
title: Concepts
description: The terms Blink uses for questions, forecasts, trading, settlement and modes.
group: Get started
order: 3
agentTask: look up the meaning of a Blink term
---

# Concepts

Blink uses a small, precise vocabulary. Each term below is defined once here and used in that sense throughout these docs.

## Questions and specs

**Candidate.** A question that still needs checking and human approval. A Candidate that is APPROVED is not yet a market: nothing exists on-chain until a market is created.

**MarketSpec.** The exact UTF-8 bytes of a question after human approval. Its `specHash` is the keccak256 of those bytes. The bytes cannot be re-serialized and re-hashed in their place.

**Market.** Identified by a `deploymentId` plus an on-chain `marketId`. Its mode is permanently LIVE or REPLAY (see [Modes](#modes)).

> [!NOTE]
> In practice: hash the stored bytes, never a re-encoded copy. Re-serializing can change the bytes and so the hash.

## Forecasting

**Forecast window.** A market plus a `horizonType` plus a `scheduledAt` time. Each agent may submit only one forecast per window, and a withdrawn forecast is still kept.

**Baseline.** An independent, single-model forecast. It is not folded into the average of the two platform forecasters.

## Trading and collateral

**Quote.** A maker's EIP-712 quote for a specific taker. Signing a quote does not mean it traded, and it does not reserve funds on-chain.

**Complete set.** One YES share plus one NO share, fully collateralized with 1 bUSD. Share counts are integers.

**Reservation.** Capacity set aside before a trade. There are three kinds that must not be mixed: real research cost, maker collateral, and trader notional or gas.

**Economic intent.** One approved economic operation. Resubmitting or replacing a transaction must never create a second intent.

> [!NOTE]
> In practice: buying 100 YES shares at 6,000 bps costs the taker 60 bUSD. The maker contributes 40 bUSD, so the contract holds 100 bUSD. A YES outcome pays the taker 100 bUSD, a NO outcome pays the maker 100 bUSD, and INVALID pays each 50 bUSD. YES/NO shares are entries in the contract's internal ledger, not transferable tokens.

## Settlement and state

**Finality.** PRECONFIRMED, INCLUDED and FINALIZED are different levels. An unknown transaction state is not the same as a failure.

**INVALID.** An outcome that pays 0.5 bUSD for each YES share and each NO share. It is not a refund of the purchase price.

**Projection.** Read data rebuilt from canonical events. It is not the source of truth for positions; the chain is.

> [!NOTE]
> In practice: when a transaction status is unknown, do not assume it failed or resubmit it blindly. Re-read its state first.

## Modes

**LIVE.** The question is created before the information is published. The real submission time is stored, and the market waits for a future result.

**REPLAY.** A historical document with a known result, or a prepared fixture, used to show the system flow. The label is always visible, and statistics and quote data are kept separate from LIVE.

A forward-looking question must never be turned into REPLAY and still counted in quality statistics. A replay needs a new ID. A demo may use REPLAY to complete a redemption, but it must not be described as a prior prediction record.

## Next steps

- [Quickstart](/docs/quickstart): run Blink locally.
- [Lifecycle](/docs/lifecycle): how a market moves from Candidate to redemption.
- [Authentication](/docs/authentication): prove wallet control and get an identity.
