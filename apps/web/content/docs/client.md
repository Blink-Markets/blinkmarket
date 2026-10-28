---
title: TypeScript client
description: Reference for @blink/client, the TypeScript client and agent kit in the repository: how it is created, how it fails, every method with its endpoint, and the helpers for quotes, votes and forecasts.
group: Reference
order: 3
agentTask: understand the shape and behaviour of the @blink/client TypeScript client
---

# TypeScript client

`@blink/client` is a small typed wrapper around the Blink HTTP API, plus the helpers an agent needs around it: the contract ABI, the protocol constants, the quote check, the vote commitment and the signed-forecast types. It lives in `packages/client`, validates every request and response against the shared schemas in `@blink/schemas`, and is the only Blink package the reference agents in `examples/agents` import.

> [!NOTE]
> `@blink/client` is a private package in the repository and is not published to npm. No API host is running, so this page describes the client's shape and behaviour. It holds no private key and signs nothing: signatures come from your own wallet code.

## How is a client created?

```ts
import { createBlinkClient } from "@blink/client";

const client = createBlinkClient(apiUrl, apiKey, { maxAttempts: 3 });
```

`createBlinkClient(baseUrl, apiKey?, options?)` behaves as follows:

- **URL rule.** `https:` URLs are accepted. `http:` is accepted only for loopback addresses. Any other URL throws `Error("HTTPS_REQUIRED")` immediately.
- **Bearer auth.** If you pass `apiKey`, every request carries `Authorization: Bearer <apiKey>`. Without a key only public calls succeed, which includes the wallet proof that issues a key; see [Onboarding](/docs/onboarding).
- **No redirects.** Requests use `redirect: "error"`, so a redirect makes the call fail instead of sending your key to another location.
- **Mainnet refused.** A JSON answer that names a mainnet chain throws `MAINNET_REFUSED`.

## How does it report errors?

A non-2xx response throws `BlinkApiError`, an `Error` subclass with three fields:

- `status`: the HTTP status code.
- `body`: the response body parsed as the `ApiError` shape: `code`, `message`, `requestId`, `retryable` and `details`. `message` also becomes the error's message.
- `retryAfterSeconds`: the server's `Retry-After` in seconds, when it sent one. It is optional.

```ts
import { BlinkApiError } from "@blink/client";

try {
  await client.getDeployment();
} catch (error) {
  if (error instanceof BlinkApiError) {
    console.error(error.status, error.body.code, error.body.requestId, error.body.retryable, error.retryAfterSeconds);
  } else {
    throw error; // network failure, HTTPS_REQUIRED, redirect, or a schema validation error
  }
}
```

Branch on `body.code` and `body.retryable`, as described in [Errors](/docs/errors). Input that fails schema validation throws before any request is sent. A response that is not valid JSON, or does not match the expected schema, throws a plain error rather than `BlinkApiError`.

Before it throws, the client retries an answer whose `retryable` is `true`: up to `maxAttempts` tries in all (default 3), waiting for the server's `Retry-After` (at most 10 seconds) or, without one, 250 ms doubling. A retried POST resends the same body. Only a forecast submission carries an `Idempotency-Key`, so only a retried `submitForecast` is deduplicated by the server (it answers with the original result). Every other write is resent without a key and is not deduplicated: in particular a retried `createRfq` can open a second RFQ. A taker cannot look for the earlier one: `listRfqs` needs the MAKER role (a taker gets `403 ROLE_REQUIRED`), and a lost answer gives no RFQ id for `listQuotes`. The reference trader does not look either: the failure ends the tick, and the next tick posts a fresh RFQ. An earlier RFQ that was created stays open for its 30 seconds and counts against the taker's limit of open RFQs, but it buys nothing: no money moves until the taker fills a quote it has verified. Pass `{ maxAttempts: 1 }` to turn retries off. A network failure is not retried. After the last try a `429` or `503` reaches your code as a `BlinkApiError`; wait for `retryAfterSeconds` before you ask again.

## Which methods does it have?

The client has 36 methods. Only `POST /v1/markets/{id}/forecasts` takes an `Idempotency-Key`: `submitForecast` accepts your own as its last argument, and otherwise the client chooses a fresh UUID once per call and repeats it on retries. The other POSTs take no key, so the client repeats one only when the server marked its answer `retryable`. `input` is validated against the endpoint's request schema before sending. The operations and who may call them are in the [API reference](/docs/api).

### Identity and config

| Method | Calls | Notes |
| --- | --- | --- |
| `createWalletChallenge(input)` | `POST /v1/auth/wallet-challenges` | `{ address, action }`, public; answers `challengeId`, `message`, `expiresAt` |
| `verifyWallet(input)` | `POST /v1/auth/wallet-verifications` | `{ challengeId, signature }`, public, single use; answers `apiKey`, `keyId` and `expiresAt` for `issue` |
| `getConfig()` | `GET /v1/config` | Chain id and the public parts of the deployment |
| `getDeployment()` | `GET /v1/deployment` | The current generation's addresses, `params`, `startBlock`, `tokenPriceMicros` and the index health it was read at |

### Markets and protocol reads

| Method | Calls | Notes |
| --- | --- | --- |
| `listMarkets(query?)` | `GET /v1/markets` | `{ state, after, limit }`; a page of markets with their parsed spec |
| `getMarket({ marketId })` | `GET /v1/markets/{id}` | The market, the parse of its spec bytes, its proposal (null before one) and the index health |
| `getMarketSpec({ marketId }, specHash)` | `GET /v1/markets/{id}/spec` | Returns the parsed spec only if the keccak256 of the bytes equals the `specHash` you trust; otherwise throws `SPEC_HASH_MISMATCH` |
| `listDisputes({ marketId }, query?)` | `GET /v1/markets/{id}/disputes` | A market's disputes |
| `getDispute({ disputeId }, query?)` | `GET /v1/disputes/{id}` | One dispute, optionally one `round` |
| `getFees({ marketId })` | `GET /v1/markets/{id}/fees` | A market's fee breakdown, or null before there is one |
| `getAccount({ address })` | `GET /v1/accounts/{address}` | Registration, each role's stake and credit, and juror state |
| `getPositions({ address }, query?)` | `GET /v1/accounts/{address}/positions` | YES and NO shares per market |
| `listTemplates(query?)` | `GET /v1/templates` | Registered templates |
| `getMetrics(mode)` | `GET /v1/metrics` | Evaluation metrics for `"LIVE"` or `"REPLAY"` markets |

### Content and suggestions

| Method | Calls | Notes |
| --- | --- | --- |
| `uploadContent(bytes, mediaType)` | `POST /v1/content` | Needs `content:write`; the answer must name `keccak256(bytes)` and the size, or it throws `HASH_MISMATCH` |
| `getContent(hash)` | `GET /v1/content/{hash}` | Returns the bytes only if their keccak256 equals `hash`, else `HASH_MISMATCH`; an unknown hash is `404 NOT_FOUND`, and `503 CONTENT_UNAVAILABLE` means the stored bytes are damaged or unreadable |
| `submitSuggestion(input)` | `POST /v1/suggestions` | Public; each call adds a suggestion |
| `listSuggestions(query?)` | `GET /v1/suggestions` | `status` is `OPEN`, `CLAIMED` or `MARKET_CREATED` |
| `getSuggestion(id)` | `GET /v1/suggestions/{id}` | One suggestion |
| `claimSuggestion(id)` | `POST /v1/suggestions/{id}/claims` | Needs `suggestion:claim` and the CREATOR role; `409 ALREADY_CLAIMED` means this identity already claimed it |

### Signed forecasts

| Method | Calls | Notes |
| --- | --- | --- |
| `listForecastWindows({ marketId }, page?)` | `GET /v1/markets/{id}/forecast-windows` | Windows with their schedule and, once closed, their Merkle roots |
| `submitForecast({ marketId }, input, key?)` | `POST /v1/markets/{id}/forecasts` | Needs `forecast:write` and the FORECASTER role; `{ horizon, scheduledAt, probabilityBps, contentHash, signature }`; answers `digest` and `leaf` |
| `listForecasts({ marketId }, query)` | `GET /v1/markets/{id}/forecasts` | `windowId` is required; before the deadline only your own answer is visible |
| `withdrawForecast({ submissionId })` | `POST /v1/forecasts/{id}/withdrawal` | Before the window's deadline; the answer is still kept |
| `getForecastWindow({ windowId })` | `GET /v1/forecast-windows/{id}` | Root, sorted leaves and `BlinkAnchor` record; empty until the deadline |
| `getForecastProof({ windowId }, leaf)` | `GET /v1/forecast-windows/{id}/proof` | The sibling path for OpenZeppelin `MerkleProof.verify` |
| `getConsensus({ marketId }, page?)` | `GET /v1/markets/{id}/consensus` | The credit-weighted consensus of closed windows |
| `listForecasters(page?)` | `GET /v1/forecasters` | Sorted by weight |
| `getForecaster({ address })` | `GET /v1/forecasters/{address}` | One forecaster's record |

### Quote relay and transactions

| Method | Calls | Notes |
| --- | --- | --- |
| `createRfq(input)` | `POST /v1/rfqs` | Taker: `{ marketId, side, quantity }`; open for 30 seconds; the relay never prices or fills |
| `listRfqs(query?)` | `GET /v1/rfqs` | Maker: the open RFQs |
| `postQuote(rfqId, input)` | `POST /v1/rfqs/{id}/quotes` | Maker: `{ quote, signature }` |
| `listQuotes(rfqId)` | `GET /v1/rfqs/{id}/quotes` | Taker: quotes cheapest first, exactly as the makers posted them; verify each one |
| `getMakerStats(address)` | `GET /v1/makers/{address}/stats` | Informational counts of relayed, filled and cancelled-before-expiry quotes |
| `trackTransaction({ txHash })` | `POST /v1/transactions` | A hash your wallet sent to the generation, the faucet or the anchor |
| `getTransaction({ deploymentId, txHash })` | `GET /v1/transactions/{txHash}` | `UNKNOWN`, `INCLUDED`, `FINALIZED`, `REVERTED` or `REORGED` |

## How is a signed quote checked?

A quote is a maker's offer, and the relay is not trusted to describe it truthfully. `verifySignedQuote(quote, signature, context)` is asynchronous: `await` it, because a caller that forgets gets a promise, not a quote it may use. It resolves to a `VerifiedQuote` (`digest`, `takerCost`, `fee`, `maxCost`) and rejects with `QuoteVerificationError` and a `code` for the first check that fails. Approve and fill only after the awaited call has resolved. It does not read the maker's epoch, so a stale epoch is rejected by `fillQuote` on chain even after a successful verification. The `quote` is the quote fields and `signature` the maker's signature, as `listQuotes` returns them. The `context` carries a `publicClient` for a node you trust, the `deployment` from `getDeployment()`, the `market` as the index reports it, your `rfq` (`marketId`, `side`, `quantity`, `taker`), `now` (the latest block timestamp, never the host clock), the generation's `feeBps`, an optional `maker` and an optional `minValiditySeconds`.

| Code | What failed |
| --- | --- |
| `DEPLOYMENT_MISMATCH` | The quote does not belong to the generation you trust |
| `MAKER_MISMATCH` | The quote's maker is not the maker you meant to deal with |
| `TAKER_MISMATCH` | The quote names another taker than your wallet |
| `TERMS_MISMATCH` | The market, spec hash, side or quantity differs from your request or the indexed market |
| `INVALID_PRICE` | The price is not in 1..9999 bps |
| `INVALID_LIFETIME` | The quote lives longer than `BlinkMarkets` allows (60 seconds) |
| `NOT_YET_VALID` | `now` is before the quote's `validAfter` |
| `EXPIRED` | Less than `minValiditySeconds` is left, or `now` is at or past `expiresAt` |
| `AFTER_CLOSE` | The quote would end after the market's `closeAt` |
| `SIGNATURE_INVALID` | The signature does not verify for the maker, or is one the contract refuses (a wrapper, a high `s`, a `v` other than 27 or 28) |

`DEFAULT_MIN_VALIDITY_SECONDS` is 6, which assumes 2-second blocks: one for the approval, one for the fill and one of slack. Pass a larger value if blocks are slower, or `0n` to accept a quote until its last second. `approvalFor(quote, feeBps)` gives the allowance a fill needs, the cost plus the fee. `takerCostOf`, `feeOf` and `quoteTypedData` build the pieces. Cross-check the `getDeployment()` answer against a source outside the API before you trust it.

## What else does the kit export?

| Export | Use |
| --- | --- |
| `agentAbi` | The ABI slice of every contract an agent calls; listed in full on [Contracts](/docs/contracts) |
| `ROLE`, `QUESTION_CLASS`, `MARKET_STATE`, `OUTCOME`, `CREATION_GROUND` | Protocol constants. `CREATION_GROUND` is a P3 decision, not enforced on chain; see [Trust](/docs/trust) |
| `templateIdFor(cls, parserHash, uri)` | The id `registerTemplate` gives a template |
| `voteCommitment({ disputeId, round, juror, choice, salt })` | The hash a juror commits, which `revealVote` recomputes |
| `forecastTypedData`, `forecastDigest`, `forecastLeaf`, `FORECAST_HORIZONS`, `NO_CONTENT_HASH` | What a forecaster signs and the leaf `BlinkAnchor` may anchor |
| `GM_LT_V1`, `gmLtV1Outcome`, `parseGrossMargin` | The class A template and its computation. `gmLtV1Outcome` accepts only `{"thresholdBps": <int 1..9999>}` |
| `parseMarketSpec` | Reads the bytes of a MarketSpec without importing the schemas package |

## What does a typed example look like?

```ts
import { BlinkApiError, createBlinkClient } from "@blink/client";

const client = createBlinkClient(apiUrl, apiKey);

const { generation, params } = await client.getDeployment();
const page = await client.listMarkets({ state: "OPEN", limit: 20 });

async function track(txHash: string) {
  try {
    return await client.trackTransaction({ txHash });
  } catch (error) {
    if (error instanceof BlinkApiError && error.body.retryable) {
      // the client already retried; wait error.retryAfterSeconds and ask again, never send the transaction twice
    }
    throw error;
  }
}
```

## Hand it to your agent

```prompt
Read https://blink-markets.github.io/blinkmarket/docs/client.md and explain how @blink/client (packages/client in the repository; it is not on npm) behaves:
1. Which base URLs createBlinkClient accepts, and what happens with any other URL.
2. How it sends the API key, and why it refuses redirects.
3. What BlinkApiError contains, and which failures throw a plain error instead.
4. For a given method, which endpoint it calls and which scope and role it needs.
Hard rules: Base Sepolia testnet only (chain ID 84532); bUSD has no value. Do not create wallets, request keys, or sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals. No API host is running, so do not call any host.
```

## Next steps

- [API reference](/docs/api): every operation and who may call it.
- [Onboarding](/docs/onboarding): API keys, scopes and the wallet-challenge flow.
- [Errors](/docs/errors): the error shape, status codes and safe retries.
- [Contracts](/docs/contracts): the signatures in `agentAbi`.
