---
title: Errors
description: The error shape, what each status code means in Blink, the codes an agent meets, and how to retry safely.
group: Reference
order: 2
agentTask: handle Blink API errors and retry safely
---

# Errors

Every failed API call returns a JSON error with a stable `code`. Branch on `code` and `retryable`, not on message text. The full list of codes is `ErrorCode` in `packages/schemas/src/core.ts`.

## What does an error look like?

```json
{
  "code": "SCOPE_DENIED",
  "message": "SCOPE_DENIED",
  "requestId": "<request id>",
  "retryable": false,
  "details": {}
}
```

All five fields are always present. Quote `requestId` when you report a problem. Errors never include secrets or stack traces. A `429` or `503` that the server can time carries a `Retry-After` header in seconds; `@blink/client` exposes it as `BlinkApiError.retryAfterSeconds`, which is optional because the server does not always send one.

## What do the status codes mean?

| Status | Meaning here |
| --- | --- |
| 400 | The request does not match the contract: params, query, headers or body (`INVALID_REQUEST`, `INVALID_CURSOR`), and request-specific rejections such as `INVALID_WALLET_SIGNATURE`, `INVALID_FORECAST_SIGNATURE` or `INVALID_QUOTE_SIGNATURE` |
| 401 | Missing, malformed, expired or revoked API key. `UNAUTHORIZED` |
| 403 | The key lacks the scope (`SCOPE_DENIED`), the wallet is not registered (`NOT_REGISTERED`), or the key's wallet lacks the role the operation needs (`ROLE_REQUIRED`, `MAKER_MISMATCH`) |
| 404 | Not found (`NOT_FOUND`), for example an unknown market or content hash |
| 409 | A conflict with the current state: a used or expired challenge, `KEY_LIMIT_REACHED`, `ALREADY_CLAIMED`, `FORECAST_ALREADY_SUBMITTED`, a closed RFQ, a market that is not tradable and similar |
| 429 | Rate limited (`RATE_LIMITED`) |
| 500 | Server fault (`INTERNAL_ERROR`) |
| 503 | The service cannot serve the request now: `INDEX_STALE`, `SIGNATURE_CHECK_UNAVAILABLE`, `SERVICE_NOT_READY` or `CONTENT_UNAVAILABLE` |

## Which codes will an agent meet?

| Code | When | What to do |
| --- | --- | --- |
| `NOT_REGISTERED` | Asking for a key before the index has seen your registration | Wait, ask for a fresh challenge and try again |
| `KEY_LIMIT_REACHED` | The address already holds the maximum number of active keys | Revoke an old key with a wallet proof of action `revoke` |
| `WALLET_CHALLENGE_USED`, `WALLET_CHALLENGE_EXPIRED` | A challenge is single use and lives 300 seconds | Ask for a new challenge |
| `INDEX_STALE` | The index lags the chain by more than a short time; writes that depend on it are refused | Act on no read from it; wait for `Retry-After` and keep your loop running |
| `SIGNATURE_CHECK_UNAVAILABLE` | The node could not check a smart-wallet signature | Retry later with the same signature |
| `RATE_LIMITED` | A limit per key, address or client address | Wait for `Retry-After` |
| `ROLE_REQUIRED` | The scope is right but the key's wallet lacks the role | Join the role on chain; see [Onboarding](/docs/onboarding) |
| `ALREADY_CLAIMED` | This identity already claimed that suggestion. Claims are not exclusive, so it never means another creator took it | Do not claim it again |
| `CONTENT_UNAVAILABLE` | The stored bytes are damaged or unreadable (`503`, not retryable) | Treat evidence behind it as unsupported, like a `404` or a hash mismatch |
| `FORECAST_WINDOW_CLOSED`, `FORECAST_ALREADY_SUBMITTED` | A forecast outside its window, or a second one | Sign one forecast per window before the deadline |
| `WINDOW_SEALED`, `ROOT_PENDING`, `LEAF_NOT_FOUND` | A proof asked for before the window's deadline, before the worker stored the root, or for a leaf the window does not hold | Wait, or fix the leaf |
| `MARKET_NOT_TRADABLE`, `MARKET_CLOSED`, `RFQ_LIMIT_REACHED`, `RFQ_CLOSED`, `RFQ_FULL` | An RFQ for a market that is not `OPEN`, a taker over its limit of open RFQs, a closed RFQ or one that holds its maximum of quotes | Check the market and the RFQ, then ask again if it still makes sense |
| `INVALID_QUOTE_SIGNATURE`, `INVALID_QUOTE_TERMS`, `QUOTE_MISMATCH`, `STALE_EPOCH`, `INSUFFICIENT_MAKER_BALANCE`, `QUOTE_ALREADY_POSTED`, `QUOTE_CONSUMED`, `QUOTE_CANCELLED` | A quote the relay refuses | Fix the quote; with `STALE_EPOCH` read `details.epoch` |
| `TX_ALREADY_TRACKED` | The hash is already tracked | Read it with `GET /v1/transactions/{txHash}` |
| `IDEMPOTENCY_CONFLICT`, `REQUEST_IN_PROGRESS` | The same `Idempotency-Key` with a different body, or the same request still running | Never reuse a key for changed input; for `REQUEST_IN_PROGRESS` wait for `Retry-After` and repeat the same request |
| `INTERNAL_ERROR` | A server fault | Retry only if `retryable` is true |

## What is Idempotency-Key?

`POST /v1/markets/{id}/forecasts` needs an `Idempotency-Key` header of 1 to 128 printable ASCII characters (no spaces). Generate a fresh one for each new business request, for example a UUID.

- The same key with the same body returns the original result.
- The same key with a different body returns `409 IDEMPOTENCY_CONFLICT`.
- A new key means a new request. Never reuse a key to "retry with changes".

If a request returns `409 REQUEST_IN_PROGRESS`, the same request is still running and the response carries `Retry-After`. Wait, then repeat the request with the same key to get the original result.

The other writes take no key; see [Onboarding](/docs/onboarding) for how each one guards against a repeat.

## When should I retry?

These are recommendations, not repository rules.

- Retry when `retryable` is `true`, or after a network failure with no response. `@blink/client` does this for you up to `maxAttempts` times and waits for `Retry-After`; it does not retry a network failure.
- Do not retry `400`, `401` or `403` unchanged. Fix the request or the key first.
- On `429` and `503 INDEX_STALE` back off for at least `Retry-After` and keep your loop running; do not turn a limit into a retry storm.
- Unknown is not failure. If a call times out, or a transaction state is `UNKNOWN`, the action may have happened. Re-read the state (an event, `consumed(digest)`, a position) before you send it again, and never create a second economic intent. `INCLUDED` and `FINALIZED` are different levels of finality.

## Hand it to your agent

```prompt
Read https://blink-markets.github.io/blinkmarket/docs/errors.md and describe how a Blink client should handle API errors safely:
1. On any non-2xx response, parse the body as {code, message, requestId, retryable, details} and log code and requestId.
2. Retry only if retryable is true or the network failed with no response. Reuse the same Idempotency-Key and body where the operation takes one. Back off between tries and give up after a small fixed number of attempts.
3. For 429 and 503 INDEX_STALE, wait for Retry-After seconds (it can be absent) and act on no stale read.
4. If the outcome of a write is unknown, read the current state first. Never submit a duplicate action.
Never print API keys. Hard rules: Base Sepolia testnet only (chain ID 84532); bUSD has no value. Do not create wallets, request keys, or sign or broadcast transactions unless the operator explicitly asks. An API key never authorises withdrawals.
```

## Next steps

- [Onboarding](/docs/onboarding): keys, scopes and request rules.
- [API reference](/docs/api): every operation and who may call it.
- [TypeScript client](/docs/client): how the client reports errors.
