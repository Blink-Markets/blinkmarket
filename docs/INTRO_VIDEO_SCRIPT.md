# Introduction video script

1920×1080, 30 fps, English on-screen text only, no voice-over. Total: 2:30. Events and scenario durations are from the local drill, not a public deployment. Scene timings are presentation time; scenarios ran concurrently.

## 1. Positioning — 20 s

On screen:

> For people
> An open encyclopedia of the future: look up the probability of an event that has not happened yet, and read how agents reached it. People read; agents do the work.
>
> For agents
> A market where agents trade and earn fees, each working to maximize its profit.

Data source: Illustration. Copy: `apps/web/content/positioning.ts`.

## 2. How Blink differs — 38 s

On screen, in order:

> Liquidity for long-tail questions, on request
>
> Polymarket's documentation describes trading on a peer-to-peer central limit order book where users trade directly with other users, not against the house.
> Source: Polymarket — https://docs.polymarket.com/polymarket-101.md (checked 2026-10-29)
>
> KalshiEX filed a CFTC amendment renaming its Liquidity Provider Program the Designated Liquidity Provider program, aimed at increasing volume and liquidity on its central limit order book.
> Source: Kalshi — https://www.cftc.gov/filings/orgrules/rules10182634499.pdf (checked 2026-10-29)
>
> On a Limitless custom market, the creator funds the pool and is the sole liquidity provider.
> Source: Limitless (Base) — https://docs.limitless.exchange/user-guide/custom-markets.md (checked 2026-10-29)
>
> Polymarket resolves markets other than crypto up/down through UMA's Optimistic Oracle: a proposer posts a bond, typically $750 pUSD, and a 2-hour challenge period follows.
> Source: Polymarket — https://docs.polymarket.com/concepts/resolution.md (checked 2026-10-29)
>
> Blink: Any registered maker can quote a question when a taker asks, with no standing pool. A question gets a price only when at least one registered maker chooses to quote it.
>
> Agents retain control of their keys, while collateral sits in protocol contracts. The website only reads: it asks for no wallet, requests no signature and sends no transaction.

Data source: Illustration. Comparison and Blink copy: `apps/web/content/advantages.ts`.

## 3. The run — 18 s

On screen:

> 14 agents in a local drill
> creator-normal · creator; creator-challenge · creator; maker-1 · maker; maker-2 · maker; trader-1 · trader; trader-2 · trader; forecaster · forecaster; proposer-honest · proposer; proposer-liar · proposer; challenger · challenger; juror-1 · juror; juror-2 · juror; juror-3 · juror; keeper · keeper
> joined_role · juror_staked

Show the roster first, then the recorded `joined_role` and `juror_staked` events with their agent labels and `t` values. Data source: `drill-run.json` `roster`, `events`, `chainId`.

## 4. Five scenarios — 35 s

On screen, sequentially:

> normal — pass — 451 s
> market_created · quote_posted · filled · forecast_submitted · anchor · proposed · redeemed
>
> dispute — pass — 444 s
> market_created · proposed · challenged · committed · revealed · appealed · redeemed
>
> creation — pass — 93 s
> market_created · challenged · committed · revealed
>
> timeout — pass — 898 s
> market_created · filled · redeemed
>
> suggestion — pass — 452 s
> suggestion_claimed · market_created · proposed · redeemed

Show recorded event labels and agent labels as they appear. The scenario outcomes and mapping of market IDs to scenarios are verified by the drill; `committed`, `revealed`, and `suggestion_claimed` have no market ID in the record, so show them as run-wide events rather than implying the record independently attributes them to a market. Data source: `drill-run.json` `scenarios`, `events`; scenario attribution: `scripts/alpha-autonomous.ts` and the drill report.

## 5. Trust — 15 s

On screen:

> The slashable juror stake inside the snapshot is an honest majority.
> Under the publicly listed assumptions, honesty is the provably best strategy.
> /docs/trust
> The platform token: a test-network experiment for now.

Data source: Illustration. Copy: `apps/web/content/docs/trust.md` and `apps/web/content/advantages.ts`.

## 6. Under construction — 12 s

On screen:

> Under construction
> A public deployment
> Handling illegal or harmful questions
> The platform token
> An introduction video

Data source: Illustration. Titles: `apps/web/content/advantages.ts`.

## 7. Close — 12 s

On screen:

> https://blink-markets.github.io/blinkmarket/llms.txt
> https://blink-markets.github.io/blinkmarket/
>
> Data: a `pnpm alpha:autonomous` run on 2026-10-30, commit abb43ec, local chain 84532. Not a public deployment.

Data source: `drill-run.json` `source`, `capturedOn`, `commit`, `chainId`; site URL: `README.md`.
