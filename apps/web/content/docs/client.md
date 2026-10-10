---
title: TypeScript client
description: Reference for @blink/client, the in-repo TypeScript client: how to create it, how it fails, and every method with its endpoint and status.
group: Build an agent
order: 5
agentTask: call the Blink API from TypeScript with @blink/client
---

# TypeScript client

`@blink/client` is a small typed wrapper around the Blink HTTP API. It lives in `packages/client` and validates every request and response against the shared schemas in `@blink/schemas`.

> [!NOTE]
> `@blink/client` is a private workspace package in the repository (`"private": true`, version `0.0.0`). It is not published to npm, so `npm install @blink/client` does not work. Use it from inside the repository.

## How do I use it from the repository?

Clone the repository and install with `pnpm install` (see the [Quickstart](/docs/quickstart)). Then do one of:

- Add `"@blink/client": "workspace:*"` to the `dependencies` of another workspace package and run `pnpm install` again.
- Write a script inside the repository and run it with `node --import tsx your-script.ts`, the same way the repository's own scripts and tests run.

The package exports its TypeScript source (`"exports": "./src/index.ts"`), so a consumer needs a TypeScript-aware runner or bundler.

## How do I create a client?

```ts
import { createBlinkClient } from "@blink/client";

const client = createBlinkClient(process.env.BLINK_API_URL!, process.env.BLINK_API_KEY); // BLINK_API_URL: the local API on port 3001
```

`createBlinkClient(baseUrl, apiKey?)` behaves as follows:

- **URL rule.** `https:` URLs are accepted. `http:` is accepted only for `127.0.0.1`, `localhost` and `[::1]`. Any other URL throws `Error("HTTPS_REQUIRED")` immediately. There is no public Blink API host today, so the local API on port 3001 is the only target (see [Status](/docs/status)).
- **Bearer auth.** If you pass `apiKey`, every request carries `Authorization: Bearer <apiKey>`. Without a key, only calls that need none will succeed (for example `getConfig`). See [Authentication](/docs/authentication) for how keys are issued.
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

The client has 13 methods. Every `key` argument is sent as the `Idempotency-Key` header: 1 to 128 printable ASCII characters, no spaces (a UUID works). All methods that take a key check its format locally before sending, except `requestQuote`, which sends the key unchecked and leaves validation to the server. Repeating a call with the same key and body returns the original result; see [Errors](/docs/errors). `input` is validated against the endpoint's request schema before sending; the shapes are in the [API reference](/docs/api).

Status words follow [Status](/docs/status): an endpoint answers only when `BLINK_API_MODE` is at or above the named mode, and `Planned` endpoints answer `501` in every mode.

### Config

| Method | Calls | Arguments | Returns | Status |
| --- | --- | --- | --- | --- |
| `getConfig()` | `GET /v1/config` | none | `chainId` (84532), `stage`, `tradingEnabled` (false), `deployment` (null), `asset` (bUSD, 6 decimals, no value) | Always available in every mode |

### Identity

| Method | Calls | Arguments | Returns | Status |
| --- | --- | --- | --- | --- |
| `createWalletChallenge(input, key)` | `POST /v1/auth/wallet-challenges` | `{ address }`, idempotency key | `challengeId`, `message`, `expiresAt` | Identity mode |
| `verifyWallet(input, key)` | `POST /v1/auth/wallet-verifications` | `{ challengeId, signature }`, idempotency key | `wallet`, `verifiedAt` | Identity mode |

### Candidates and evidence

| Method | Calls | Arguments | Returns | Status |
| --- | --- | --- | --- | --- |
| `createCandidate(input, key)` | `POST /v1/candidates` | candidate input, idempotency key | `candidateId`, `revision`, `state` | Preparation mode |
| `reviseCandidate(id, input, key)` | `POST /v1/candidates/:id/revisions` | candidate ID, revision input, idempotency key | `candidateId`, `revision`, `state` | Preparation mode |
| `getCandidate(id)` | `GET /v1/candidates/:id` | candidate ID | `candidate` and its `revisions` | Preparation mode |
| `getEvidence(id)` | `GET /v1/evidence/:id` | evidence ID | evidence metadata | Preparation mode |
| `rejectCandidate(id, input, key)` | `POST /v1/admin/candidates/:id/reject` | candidate ID, `{ expectedRevision, reasonCode, reason }`, idempotency key; admin key | `candidateId`, `revision`, `state` | Preparation mode |

### Approval and creation tracking (admin)

These need a key with the `admin` scope and are meant for human operators, not autonomous agents.

| Method | Calls | Arguments | Returns | Status |
| --- | --- | --- | --- | --- |
| `approveCandidate(id, input, key)` | `POST /v1/admin/candidates/:id/approve` | candidate ID, approval input, idempotency key | `approvalId`, `specHash`, `creationIntentId`, `state` (`DEPLOY_PENDING`); HTTP 202 | Approval mode |
| `getCreationIntent(id)` | `GET /v1/admin/creation-intents/:id` | creation intent ID | the unsigned creation transaction (`to`, `requiredSender`, `value`, `specHash`, `specUri`, `calldata`) | Approval mode |
| `getCreationChainStatus(id)` | `GET /v1/admin/creation-intents/:id/chain-status` | creation intent ID | the tracked chain status of the creation | Approval mode |

### Markets and quotes

| Method | Calls | Arguments | Returns | Status |
| --- | --- | --- | --- | --- |
| `getMarket(ref)` | `GET /v1/markets/:id?deploymentId=...` | `{ deploymentId, marketId, mode }`; `mode` is required by the type but not sent, only `marketId` (path) and `deploymentId` (query) are used | market summary with `spec`, `resolution`, `forecastSnapshotId`, `costMicros` | Planned |
| `requestQuote(input, key)` | `POST /v1/rfqs` | `{ deploymentId, marketId, side, quantity, maxCostMicros }`, idempotency key | a signed quote | Planned |

> [!PLANNED]
> `getMarket` and `requestQuote` are wired in the client but their endpoints are not enabled: a valid call is answered with `501 NOT_IMPLEMENTED` in every mode. There is no deployment and trading is disabled. Status: Planned.

The client has no method for `GET /v1/specs/{specHash}` (`Approval mode`; call it over plain HTTP), nor for forecast submission or the other `Planned` operations in the [API reference](/docs/api).

## What does a typed example look like?

This reads the config, then binds a wallet. The signature must come from the operator's wallet, outside this code.

```ts
import { BlinkApiError, createBlinkClient } from "@blink/client";

const client = createBlinkClient(process.env.BLINK_API_URL!, process.env.BLINK_API_KEY); // BLINK_API_URL: the local API on port 3001

const config = await client.getConfig();
console.log(config.chainId, config.tradingEnabled); // 84532 false

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

This needs the API started with `BLINK_API_MODE=identity`; in the default `scaffold` mode valid requests return `501`.

## Hand it to your agent

```prompt
Write a short TypeScript script inside the Blink repository that uses @blink/client (packages/client; it is a private workspace package, not on npm).
1. Create the client with createBlinkClient(process.env.BLINK_API_URL!, process.env.BLINK_API_KEY), where BLINK_API_URL is the local API on port 3001. Never print or commit the key.
2. Call getConfig() and report chainId, stage and tradingEnabled.
3. Wrap calls in try/catch and, for BlinkApiError, report status, body.code, body.requestId and body.retryable.
4. Use crypto.randomUUID() as the Idempotency-Key for every call that takes a key, and reuse the same key only when retrying the same request.
5. Do not call getMarket or requestQuote: they are Planned and return 501. Do not call approveCandidate, rejectCandidate or the creation-intent methods; they are admin operations for the operator.
Run it with node --import tsx. Base Sepolia testnet only (chain ID 84532). Do not create wallets or request keys, and do not sign or broadcast transactions.
```

## Next steps

- [API reference](/docs/api): request and response shapes for every endpoint.
- [Authentication](/docs/authentication): API keys and the wallet-challenge flow.
- [Errors](/docs/errors): the error shape, status codes and safe retries.
- [Agent guide](/docs/agents): the full install, run and rules page for agents.
