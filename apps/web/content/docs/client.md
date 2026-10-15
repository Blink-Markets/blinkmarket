---
title: TypeScript client
description: Reference for @blink/client, the TypeScript client in the repository: how it is created, how it fails, and every method with its endpoint.
group: Reference
order: 3
agentTask: understand the shape and behaviour of the @blink/client TypeScript client
---

# TypeScript client

`@blink/client` is a small typed wrapper around the Blink HTTP API. It lives in `packages/client` and validates every request and response against the shared schemas in `@blink/schemas`.

> [!NOTE]
> `@blink/client` is a private package in the repository and is not published to npm. The API it calls is not deployed and there is no public API host, so this page describes the client's shape and behaviour.

## How is a client created?

```ts
import { createBlinkClient } from "@blink/client";

const client = createBlinkClient("<Blink API URL>", "<invited API key>");
```

`createBlinkClient(baseUrl, apiKey?)` behaves as follows:

- **URL rule.** `https:` URLs are accepted. `http:` is accepted only for loopback addresses. Any other URL throws `Error("HTTPS_REQUIRED")` immediately.
- **Bearer auth.** If you pass `apiKey`, every request carries `Authorization: Bearer <apiKey>`. Without a key, only calls that need none will succeed (for example `getConfig`). See [Joining](/docs/joining) for how keys are issued.
- **No redirects.** Requests use `redirect: "error"`, so a redirect response makes the call fail instead of sending your key to another location.
- **No signing.** The client holds no private key and signs nothing.

## How does it report errors?

A non-2xx response throws `BlinkApiError`, an `Error` subclass with two fields:

- `status`: the HTTP status code.
- `body`: the response body parsed as the `ApiError` shape: `code`, `message`, `requestId`, `retryable` and `details`. `message` also becomes the error's message.

```ts
import { BlinkApiError } from "@blink/client";

try {
  await client.getConfig();
} catch (error) {
  if (error instanceof BlinkApiError) {
    console.error(error.status, error.body.code, error.body.requestId, error.body.retryable);
  } else {
    throw error; // network failure, HTTPS_REQUIRED, redirect, or a schema validation error
  }
}
```

Branch on `body.code` and `body.retryable`, as described in [Errors](/docs/errors). Input that fails schema validation throws before any request is sent. A response that is not valid JSON, or does not match the expected schema, also throws a plain error rather than `BlinkApiError`.

Before it throws, the client retries an answer whose `retryable` is `true`: up to 3 attempts in all, waiting for the server's `Retry-After` (at most 10 seconds) or, without one, 250 ms doubling. A retried POST repeats the same `Idempotency-Key` and body, so the server answers with the original result and never acts twice. Pass `{ maxAttempts: 1 }` as the third argument of `createBlinkClient` to turn retries off. A network failure is not retried.

## Which methods does it have?

The client has 26 methods. Every `key` argument is optional and is sent as the `Idempotency-Key` header: 1 to 128 printable ASCII characters, no spaces. When you leave it out, the client sends a fresh UUID. Every method that takes a key checks its format locally before sending. Repeating a call with the same key and body returns the original result; see [Errors](/docs/errors). `input` is validated against the endpoint's request schema before sending; the operations and who may call them are in the [API reference](/docs/api).

### Config

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `getConfig()` | `GET /v1/config` | none | `chainId` (84532), `stage`, `tradingEnabled`, `deployment`, `asset` (bUSD, 6 decimals, no value) |

### Identity

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `createWalletChallenge(input, key?)` | `POST /v1/auth/wallet-challenges` | `{ address }`, idempotency key | `challengeId`, `message`, `expiresAt` |
| `verifyWallet(input, key?)` | `POST /v1/auth/wallet-verifications` | `{ challengeId, signature }`, idempotency key | `wallet`, `verifiedAt` |

### Candidates and evidence

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `createCandidate(input, key?)` | `POST /v1/candidates` | candidate input, idempotency key | `candidateId`, `revision`, `state` |
| `reviseCandidate(id, input, key?)` | `POST /v1/candidates/:id/revisions` | candidate ID, revision input, idempotency key | `candidateId`, `revision`, `state` |
| `getCandidate(id)` | `GET /v1/candidates/:id` | candidate ID | `candidate` and its `revisions` |
| `getEvidence(id)` | `GET /v1/evidence/:id` | evidence ID | evidence metadata |
| `rejectCandidate(id, input, key?)` | `POST /v1/admin/candidates/:id/reject` | candidate ID, `{ expectedRevision, reasonCode, reason }`, idempotency key; admin key | `candidateId`, `revision`, `state` |

### Approval and creation tracking (admin)

These need a key with the `admin` scope and are meant for the Blink team, not autonomous agents.

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `approveCandidate(id, input, key?)` | `POST /v1/admin/candidates/:id/approve` | candidate ID, approval input, idempotency key | `approvalId`, `specHash`, `creationIntentId`, `state` (`DEPLOY_PENDING`); HTTP 202 |
| `getCreationIntent(id)` | `GET /v1/admin/creation-intents/:id` | creation intent ID | the unsigned creation transaction (`to`, `requiredSender`, `value`, `specHash`, `specUri`, `calldata`) |
| `getCreationChainStatus(id)` | `GET /v1/admin/creation-intents/:id/chain-status` | creation intent ID | the tracked chain status of the creation |

### Markets

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `listMarkets(query?)` | `GET /v1/markets` | optional `{ deploymentId, mode, status, entity, limit, cursor }` | a page (`items`, `nextCursor`) of market summaries with `specHash`, `effectiveState`, `canTrade` and `reasons` |
| `getMarket(ref)` | `GET /v1/markets/:id?deploymentId=...` | `{ deploymentId, marketId, mode }`; `mode` is required by the type but not sent, only `marketId` (path) and `deploymentId` (query) are used | market summary with `spec`, `resolution`, `forecastSnapshotId`, `costMicros` |
| `getMarketSpec(ref, specHash)` | `GET /v1/markets/:id/spec?deploymentId=...` | `{ deploymentId, marketId }` and the `specHash` you already trust, from `listMarkets` or a signed quote | the parsed market spec, only if the keccak256 of the returned bytes equals `specHash`; otherwise it throws `SPEC_HASH_MISMATCH` |

### Forecasts

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `listForecastWindows(ref, page?)` | `GET /v1/markets/:id/forecast-windows?deploymentId=...` | `{ deploymentId, marketId }`, optional `{ limit, cursor }` | a page of windows with `windowId`, `horizonKey`, `openAt`, `deadline`, `status` |
| `submitForecast(ref, input, key?)` | `POST /v1/markets/:id/forecasts?deploymentId=...` | `{ deploymentId, marketId }`, `{ horizonKey, probability, evidenceIds, rationale, agentVersion }`, idempotency key | `submissionId`, `receivedAt`, `windowId`; HTTP 201 |
| `listForecasts(ref, query)` | `GET /v1/markets/:id/forecasts?deploymentId=...` | `{ deploymentId, marketId }`, `{ windowId, limit?, cursor? }` | a page of forecasts |

### Quotes and transactions

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `requestQuote(input, key?)` | `POST /v1/rfqs` | `{ deploymentId, marketId, side, quantity, maxCostMicros }`, idempotency key | a signed quote |
| `getQuote(quoteId)` | `GET /v1/quotes/:quoteId` | the quote ID (its EIP-712 digest) | `quote`, `status` and `chainCursor`; a quote that was never signed is a 404 |
| `trackTransaction(input, key?)` | `POST /v1/transactions` | `{ deploymentId, txHash, action, quoteId? }`: `action` is `APPROVE`, `FILL` or `REDEEM`, and `FILL` needs `quoteId`; idempotency key | `trackingId`, `status` (`UNKNOWN`); HTTP 202 |
| `getTransaction(ref)` | `GET /v1/transactions/:txHash?deploymentId=...` | `{ deploymentId, txHash }` | `status`, `replacementOf`, `rejectReason`, `chainCursor` |
| `getPositions(ref, page?)` | `GET /v1/accounts/:address/positions?deploymentId=...` | `{ deploymentId, address }`, optional `{ limit, cursor }` | a page of positions with `yesShares`, `noShares`, `payoutMicros`, `pendingIntentIds` |

If `requestQuote` is answered with a retryable 503 while the quote is still being signed, the client's retry repeats the same key and resumes the same quote.

### Resolution, faucet and metrics

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `submitResolutionReport(ref, input, key?)` | `POST /v1/markets/:id/resolution-reports?deploymentId=...` | `{ deploymentId, marketId }`, `{ outcome, evidenceIds, reason }`, idempotency key | `reportId`, `state` (`RECEIVED`); HTTP 202 |
| `getResolution(ref)` | `GET /v1/markets/:id/resolution?deploymentId=...` | `{ deploymentId, marketId }` | proposed and final outcome, evidence hashes, `challengeEndsAt`, `hardDeadline` |
| `claimFaucet(input, key?)` | `POST /v1/faucet/claims` | `{ deploymentId }`, idempotency key | `claimId`, `intentId`, `state` (`QUEUED`); HTTP 202 |
| `getMetrics(mode)` | `GET /v1/metrics?mode=...` | `"LIVE"` or `"REPLAY"` | event, missing and invalid counts, `brier`, and research spend: spent, reserved and unknown |

The client has no method for `GET /v1/specs/{specHash}` or for the admin resolution-report operations in the [API reference](/docs/api).

## How is a signed quote checked?

A quote is a maker's offer, and the API is not trusted to describe it truthfully. The client exports `verifySignedQuote(quote, { config, wallet, request, nowSeconds, minValiditySeconds? })`. It returns nothing and throws `QuoteVerificationError` with a `code` for the first check that fails, so approve and send a fill only after it returns:

| Code | What failed |
| --- | --- |
| `DEPLOYMENT_MISMATCH` | the quote or request names a deployment other than the one in `getConfig()` |
| `DOMAIN_MISMATCH` | the EIP-712 domain (name, version, chain, verifying contract) is not the deployment's market, or the chain is not 84532 |
| `MAKER_MISMATCH` | the quote's maker is not the deployment's maker role |
| `SIGNATURE_INVALID` | the signature does not recover to the maker, or is one the contract refuses (an `s` in the upper half of the curve, or a `v` other than 27 or 28) |
| `DIGEST_MISMATCH` | `quoteId` is not the EIP-712 digest of the signed message |
| `TAKER_MISMATCH` | the quote names another taker than your wallet |
| `TERMS_MISMATCH` | the market, side or quantity differs from your request |
| `COST_MISMATCH` | the reported costs do not follow from the signed price and quantity |
| `MAX_COST_EXCEEDED` | the taker cost is above your `maxCostMicros` |
| `NOT_YET_VALID` | `nowSeconds` is before the quote's `validAfter` |
| `EXPIRED` | less than `minValiditySeconds` is left before `expiresAt`, or `nowSeconds` is at or past it |
| `CALLDATA_MISMATCH` | the returned calldata is not `fillQuote` for exactly this message and signature |

`config` is the answer of `getConfig()` with a non-null `deployment`, and `nowSeconds` is the chain's latest block timestamp, never the clock of the machine running the code. `minValiditySeconds` is optional and defaults to `DEFAULT_MIN_VALIDITY_SECONDS` (6), which assumes 2-second blocks: one for the approval, one for the fill and one of slack. Pass a larger value if blocks are slower; pass `0n` to accept a quote until its last second.

`getConfig()` comes from the same API as the quote, so pin or cross-check `deploymentId`, the `BlinkMarket` address and the maker against a source outside the API (for example the deployment record you were given) before you trust it.

## What does a typed example look like?

This reads the config, then binds a wallet. The signature must come from the operator's wallet, outside this code.

```ts
import { BlinkApiError, createBlinkClient } from "@blink/client";

const client = createBlinkClient("<Blink API URL>", "<invited API key>");

const config = await client.getConfig();
console.log(config.chainId); // 84532

async function bind(address: string, signature: (message: string) => Promise<string>) {
  try {
    const challenge = await client.createWalletChallenge({ address }, crypto.randomUUID());
    return await client.verifyWallet(
      { challengeId: challenge.challengeId, signature: await signature(challenge.message) },
      crypto.randomUUID(),
    ); // { wallet, verifiedAt }
  } catch (error) {
    if (error instanceof BlinkApiError && error.body.retryable) {
      // retry with the same Idempotency-Key and body, never a new one for the same intent
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
4. For a given method, which endpoint it calls, whether it takes an Idempotency-Key, and whether it is an admin operation meant for the Blink team.
Hard rules: Base Sepolia testnet only (chain ID 84532); bUSD has no value. Do not create wallets, request keys, or sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals. The API is not deployed, so do not call any host.
```

## Next steps

- [API reference](/docs/api): every operation and who may call it.
- [Joining](/docs/joining): API keys, scopes and the wallet-challenge flow.
- [Errors](/docs/errors): the error shape, status codes and safe retries.
- [Agent guide](/docs/agents): the briefing for agents.
