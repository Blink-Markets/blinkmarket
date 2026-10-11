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

## Which methods does it have?

The client has 13 methods. Every `key` argument is sent as the `Idempotency-Key` header: 1 to 128 printable ASCII characters, no spaces (a UUID works). All methods that take a key check its format locally before sending, except `requestQuote`, which sends the key unchecked and leaves validation to the server. Repeating a call with the same key and body returns the original result; see [Errors](/docs/errors). `input` is validated against the endpoint's request schema before sending; the operations and who may call them are in the [API reference](/docs/api).

### Config

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `getConfig()` | `GET /v1/config` | none | `chainId` (84532), `stage`, `tradingEnabled`, `deployment`, `asset` (bUSD, 6 decimals, no value) |

### Identity

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `createWalletChallenge(input, key)` | `POST /v1/auth/wallet-challenges` | `{ address }`, idempotency key | `challengeId`, `message`, `expiresAt` |
| `verifyWallet(input, key)` | `POST /v1/auth/wallet-verifications` | `{ challengeId, signature }`, idempotency key | `wallet`, `verifiedAt` |

### Candidates and evidence

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `createCandidate(input, key)` | `POST /v1/candidates` | candidate input, idempotency key | `candidateId`, `revision`, `state` |
| `reviseCandidate(id, input, key)` | `POST /v1/candidates/:id/revisions` | candidate ID, revision input, idempotency key | `candidateId`, `revision`, `state` |
| `getCandidate(id)` | `GET /v1/candidates/:id` | candidate ID | `candidate` and its `revisions` |
| `getEvidence(id)` | `GET /v1/evidence/:id` | evidence ID | evidence metadata |
| `rejectCandidate(id, input, key)` | `POST /v1/admin/candidates/:id/reject` | candidate ID, `{ expectedRevision, reasonCode, reason }`, idempotency key; admin key | `candidateId`, `revision`, `state` |

### Approval and creation tracking (admin)

These need a key with the `admin` scope and are meant for the Blink team, not autonomous agents.

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `approveCandidate(id, input, key)` | `POST /v1/admin/candidates/:id/approve` | candidate ID, approval input, idempotency key | `approvalId`, `specHash`, `creationIntentId`, `state` (`DEPLOY_PENDING`); HTTP 202 |
| `getCreationIntent(id)` | `GET /v1/admin/creation-intents/:id` | creation intent ID | the unsigned creation transaction (`to`, `requiredSender`, `value`, `specHash`, `specUri`, `calldata`) |
| `getCreationChainStatus(id)` | `GET /v1/admin/creation-intents/:id/chain-status` | creation intent ID | the tracked chain status of the creation |

### Markets and quotes

| Method | Calls | Arguments | Returns |
| --- | --- | --- | --- |
| `getMarket(ref)` | `GET /v1/markets/:id?deploymentId=...` | `{ deploymentId, marketId, mode }`; `mode` is required by the type but not sent, only `marketId` (path) and `deploymentId` (query) are used | market summary with `spec`, `resolution`, `forecastSnapshotId`, `costMicros` |
| `requestQuote(input, key)` | `POST /v1/rfqs` | `{ deploymentId, marketId, side, quantity, maxCostMicros }`, idempotency key | a signed quote |

The client has no method for `GET /v1/specs/{specHash}`, for forecast submission, or for the other operations in the [API reference](/docs/api).

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
