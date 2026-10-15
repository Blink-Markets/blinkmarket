---
title: Trader
description: How an invited taker gets test bUSD, requests a signed quote, fills it from its own wallet, and redeems after settlement, with the limits that apply.
group: Roles
order: 5
agentTask: understand what a trader does and how to join as one
---

# Trader

A trader, or taker, buys YES or NO shares in a market. It asks Blink's maker for a quote, receives a signed quote made out to its own wallet, and fills it by sending the transaction itself. After the market settles, it redeems its shares. All trading uses bUSD on the Base Sepolia testnet, and bUSD has no value.

## What is a trader responsible for?

- Managing its own wallet, keys and spending policy. Blink never takes a user's private key.
- Checking every quote before filling it, rather than trusting the returned calldata.
- Paying its own testnet gas in Base Sepolia ETH. Blink does not pay gas for takers.
- Treating an unknown transaction state as unknown: re-reading state instead of sending a new trade.

## How do I join as a trader?

Trading is open to invited wallets; invitations come from the Blink team.

1. Your operator gets an invited API key with `trade:quote`. See [Joining Blink](/docs/joining).
2. Bind your operator's wallet to the key with the signed challenge described there.
3. The Blink admin adds that wallet to the contract's taker allowlist. Binding alone does not do this.

The contract only accepts a fill sent by the allowlisted taker named in the quote. Team role addresses can never be takers.

## How does a trade work?

1. **Get test bUSD.** `POST /v1/faucet/claims` with `{ "deploymentId": "<deploymentId>" }` queues a limited mint to your approved, bound wallet. It returns `202` with `claimId`, `intentId` and `state: "QUEUED"`.
2. **Check the market.** `GET /v1/markets/{id}?deploymentId=...` shows `effectiveState`, `paused`, `canTrade` and `reasons`. Do not assume a market is tradable without checking them.
3. **Request a quote.** `POST /v1/rfqs` with the market, the side, a quantity and the most you will pay:

   ```json
   {
     "deploymentId": "<deploymentId>",
     "marketId": "1",
     "side": "YES",
     "quantity": "10",
     "maxCostMicros": "6500000"
   }
   ```

   The answer is a signed quote or `NO_QUOTE`. The maker does not quote when it has no recent qualifying forecast or the official answer is already known.
4. **Check the quote.** The response has `quoteId`, the EIP-712 `domain`, `types` and `message`, the maker's `signature`, `takerCostMicros`, `makerCostMicros`, `expiresAt` and `calldata`. Recompute the cost yourself: `takerCostMicros = quantity × priceBps × 100`. Check that the domain is `Blink RFQ`, version `0.1`, chain ID 84532 and the deployment's market contract, that the taker is your wallet, and that the `specHash` is the market's.
5. **Approve and fill.** Approve bUSD for only this trade's cost, not an unlimited allowance. Then call `fillQuote(quote, signature)` from your own wallet before `expiresAt`. If the quote expires while you approve, request a new one; never reuse an old price.
6. **Report the transaction.** `POST /v1/transactions` with `deploymentId`, `txHash`, `action` (`APPROVE`, `FILL` or `REDEEM`) and, for a fill, `quoteId`. It returns `202` with `status: "UNKNOWN"`; it is a tracking hint, not proof of success.
7. **Redeem.** Once the market is `FINAL`, call `redeem(marketId)` from your wallet. It pays out both of your sides at once and zeroes them.

## What does the contract check on a fill?

The contract re-checks everything itself, whatever the API said:

- Trading is not paused, and the market exists, is `OPEN` and `now < closeAt`.
- The maker is the fixed maker, the sender is the quote's taker and is allowlisted, and maker and taker differ.
- The `specHash` matches, the side is valid, and the quantity is within the market and account caps.
- `validAfter <= now < expiresAt <= closeAt`, and a quote is valid for at most 60 seconds.
- The quote's epoch is current, and the quote has not been filled or cancelled.
- The signature is valid, the maker has enough free collateral, and you have enough bUSD balance and allowance.

If any check fails, the whole fill reverts and nothing changes. A revert is not retried automatically; a new price or deadline needs a new quote.

A signed quote does not reserve funds on-chain, and only the maker can cancel it, on-chain. Until a cancellation is included or the quote expires, it can still be filled.

## What limits apply?

| Limit | Value | Enforced by |
| --- | --- | --- |
| Shares per trade | 1 to 100 | Contract |
| Complete sets per market | Set per market at creation, at most 10,000 (up to 10,000 bUSD of collateral) | Contract |
| Shares bought per taker per market | Set per market at creation, at most 500, YES and NO combined | Contract |
| Open (unexpired) quotes per taker | 5 | Quote service |
| Quote lifetime | 30 seconds, at most 60 | Quote service and contract |
| Quote requests | 2 per second per API key, bursts of 5 | API |
| Faucet | 1,000 bUSD per approved address per 24 hours | Faucet service |

## How are shares paid?

Each trade creates fully collateralised complete sets: the taker pays its price, the maker pays the rest, and the contract holds 1 bUSD per share pair. Buying 100 YES shares at 6,000 bps costs the taker 60 bUSD; the maker adds 40 bUSD and holds 100 NO. `YES` pays the taker 100 bUSD, `NO` pays the maker 100 bUSD, and `INVALID` pays each side 50 bUSD. See [Concepts](/docs/concepts) for the full example and [Market lifecycle](/docs/lifecycle) for when a market becomes `FINAL`.

## Which endpoints does a trader use?

| Endpoint | Access | Returns |
| --- | --- | --- |
| `GET /v1/markets`, `GET /v1/markets/{id}?deploymentId=...` | Public | Market state, `paused`, `canTrade`, `reasons` |
| `POST /v1/faucet/claims` | Approved, bound wallet | `202` with `claimId`, `intentId`, `state` |
| `POST /v1/rfqs` | `trade:quote` and a bound wallet | The signed quote, or `NO_QUOTE` |
| `GET /v1/quotes/{quoteId}` | The quote's agent and administrators | Signed quote and status: `SIGNED`, `EXPIRED`, `CANCELLED` or `CONSUMED`; unsigned quotes return `404` |
| `POST /v1/transactions` | Bound wallet | `202` with `trackingId` and `status: "UNKNOWN"` |
| `GET /v1/transactions/{txHash}?deploymentId=...` | Public | Transaction state and any replacement |
| `GET /v1/accounts/{address}/positions?deploymentId=...` | Public | `yesShares`, `noShares`, `payoutMicros` and pending intents per market |

Signing uncertainty (`SIGN_UNKNOWN`) is surfaced by `POST /v1/rfqs` as `503 SERVICE_NOT_READY`. Retry POST with the same Idempotency-Key to resolve it; GET returns signed quotes only.

## What can a trader not do?

- Sell shares back early, transfer them, or fill part of a quote. Shares leave a position only by redemption.
- Do anything other than buy YES or NO shares from the fixed maker: no selling, merging or trading with other users.
- Fill a quote made out to another wallet.
- Use the API key to withdraw or transfer tokens. Trading happens only from the taker's own wallet.

Being removed from the allowlist stops new trades but never blocks redeeming shares you already hold.

## Hand it to your agent

```prompt
Read https://blink-markets.github.io/blinkmarket/docs/trader.md and explain the Blink taker flow: what a trader needs before trading, how a quote is requested and checked, what the contract re-checks on a fill, which limits apply, and how redemption pays out. Then check a quote I give you: recompute takerCostMicros and list anything that would make the fill revert. Do not fill, approve or redeem anything. Base Sepolia testnet only (chain ID 84532); bUSD has no value. Do not create wallets, request keys, or sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals.
```
