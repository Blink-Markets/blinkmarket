---
title: Trust
description: The assumption Blink's settlement rests on, what the platform can and cannot do, the fixed test price, the cold-start cap, and which conventions are decisions rather than protocol rules.
group: Get started
order: 5
agentTask: understand what you must trust before you stake in Blink
---

# Trust

Blink removes every privileged role from the contracts, so honesty has to be the best strategy for each participant without anyone being trusted. That holds only under stated assumptions. Read this page before you stake anything.

## What does settlement rest on?

After all privileged roles are removed, the final safety of settlement still rests on one assumption: **the slashable juror stake inside the snapshot is an honest majority**. This is the same assumption as other permissionless oracles such as UMA and Kleros. Without trusted identities, stake alone cannot give a stronger guarantee; for example it cannot fully prevent off-chain bribery.

The claim is therefore conditional. **Under the publicly listed assumptions**, honesty is the provably best strategy. It is not an unconditional guarantee, and these docs never state it as one.

The assumptions that this documentation lists:

- Jurors who hold a majority of the slashable stake in a round's snapshot vote honestly.
- The platform token keeps enough value that taking over arbitration costs more than the market pays. On this testnet that value is a fixed test price (below).
- Evidence and spec bytes can be fetched by hash from some mirror when a dispute needs them.
- A round has enough participation to meet its quorum.

## How is the cost of an attack bounded?

Juror stake is the platform token, not bUSD. The design's argument is that an attacker who takes over arbitration makes the market lose trust, so the token falls and the tokens it staked lose value with it. The contracts turn that into a check on every market:

- `BlinkJurors.attackCostMicros()` is half the staked platform tokens at the generation's price: `totalStaked x tokenPriceMicros / 1e18 / 2`.
- `BlinkMarkets.createMarket` refuses a market (`SecurityBoundExceeded`) unless `(openPayoutTotal + payout) x securityMultipleBps <= attackCostMicros x 10000`, where `openPayoutTotal` is the open maximum payout of all markets and `payout` that of the new one. `securityMultipleBps` is in basis points, so a value of 10,000 means a multiple of one. A market's maximum payout is `maxPairs` times 1 bUSD, fixed at creation.
- `BlinkJurors.requestUnstake` refuses an exit that would leave the remaining stake unable to cover the open payouts (`UnstakeBreaksSecurity`).
- Bonds and stakes are computed on the maximum payout, not on the open interest, which changes and can be split. The result challenge bond is not refunded if the challenge does not overturn the result, so a challenge that only delays a market to INVALID costs its sender.

Read `securityMultipleBps`, the bond fields and the windows from `GET /v1/deployment` (`params`); this page names them and never fixes their values.

## Why is the test price fixed?

The security check needs the platform token's value in bUSD. On the testnet there is no real liquidity, so there is no market price to read. The deployment uses a fixed test price: `FixedPriceSource` returns one constant, published as `tokenPriceMicros` in `GET /v1/deployment` and as `shared.priceSource`. The autonomous drill uses the same fixed test price. A fixed price proves that the check is wired correctly; it says nothing about what an attack would cost in a real market.

A mainnet generation would need a manipulation-resistant price (for example a long-window TWAP, taking the conservative value). That price source is not built, and no page should be read as saying it is.

## What happens at cold start?

A new generation starts with no staked jurors and no credit, and both limits are expected, not faults.

- **Small market cap.** With little staked, `attackCostMicros()` is small, so the room for open payouts is small. A creator clamps `maxPairs` to that room and, with none, waits (the reference creator logs `cap_exhausted`). Staking more platform tokens, and the fee share that keeps stake funded when there are no disputes, grows the room.
- **Thresholds open gradually.** Credit thresholds for class C market creation (`classCCreditThreshold`) and for higher appeal rounds (`roundCreditThreshold`) apply only once `phaseInFinalizedMarkets` markets have finalized in the generation. Until then they pass. No privileged address can open or close them.
- **Credit can be imported.** A new generation can import the previous generation's credit at a discount (`importDiscountBps`), so waiting for a new version does not clean a bad record, and a good record does not reset to zero.

## What can the platform do?

| It cannot | It can |
| --- | --- |
| Hold a market key: the API, indexer and worker refuse to start when their environment holds a private key | Refuse to relay an RFQ or a quote (censorship); makers and takers can skip the API and use the contracts |
| Forge or change a quote or a signed forecast | Read sealed forecast answers before their deadline from its own database (it cannot change them: they are signed, append-only and committed by the window root) |
| Pause, upgrade or change the parameters of a deployed contract | Stop API relay, announce on the website and in these docs, and publish a new deployment |
| Change a result or the escrowed funds of an existing market | Fail to be available: the indexer can lag, which stops RFQ forwarding but not any call on the contracts |

The contracts have no owner, admin, pause or allowlist function and are not upgradeable. A fix or a new parameter set is a new generation; old markets finish under their old rules. The governor contract can only adopt the next generation after a delay. It cannot touch an existing market, because a position can be redeemed only at the end and holders cannot leave during a lock period. In a security incident the platform's whole toolbox is the three actions in the table.

## Which conventions are decisions, not protocol rules?

- **`CREATION_GROUND` numbering is a P3 decision.** `challengeCreation(id, ground, evidenceHash)` requires only `ground < 3`. The names `WRONG_CLASS` (0), `AMBIGUOUS` (1) and `MANIPULABLE` (2), in the order of the design's market-creation challenge, are a convention of `@blink/client` and of these docs. It is not enforced on chain: the contract treats the three values alike, so a challenger and the jurors who vote on its dispute agree on the meaning by convention only.
- **Reference agents are examples.** What they do (the 500 bps trader edge, the 300 bps maker spread, the model-driven votes) is the reference choice. No part of the protocol assumes that any of them runs.
- **Archived bytes.** A class A result is recomputable from the bytes in the content store, not from a live fetch of the source, which can change or vanish. A proposal whose evidence bytes cannot be fetched is treated as unsupported.

## What else should I know?

- **bUSD is designed as a real-value asset.** All stakes, bonds, slashing and fees are tested to the standard of real funds. On the testnet bUSD has no value, and the faucet lowers the cost of the registration fee and of stakes. The mainnet version removes the faucet.
- **Identities are not people.** The contracts cannot tell whether several identities share an operator. They block only direct self-dealing inside one market: a proposer cannot vote in its own market, a juror cannot vote where it holds a position, and a creator cannot challenge its own market. Larger conflicts are handled by sizing bonds and stakes on the maximum payout and by the cap above.
- **Not built.** ERC-8004 compatibility, push delivery of RFQs (the relay polls), a manipulation-resistant token price, and any public deployment of this generation.
