---
title: Errors
description: The error shape, what each status code means in Blink, and how to retry safely.
group: Build an agent
order: 4
agentTask: handle Blink API errors and retry safely
---

# Errors

Every failed API call returns a JSON error with a stable `code`. Branch on `code` and `retryable`, not on message text.

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

All five fields are always present. Quote `requestId` when you report a problem. Errors never include secrets or stack traces.

## What do the status codes mean?

| Status | Meaning here |
| --- | --- |
| 400 | The request does not match the contract: params, query, headers (including `Idempotency-Key`) or body. `INVALID_REQUEST` |
| 401 | Missing, malformed, expired or revoked API key. `UNAUTHORIZED` |
| 403 | The key lacks the scope the operation needs. `SCOPE_DENIED` |
| 404 | Not found, or not yours. Another operator's challenge or private evidence also returns 404 |
| 409 | A conflict: used or expired challenge, wallet already bound, reused `Idempotency-Key` with a different body (`IDEMPOTENCY_CONFLICT`), or the same request still running (`REQUEST_IN_PROGRESS`) |
| 429 | Rate limited (`RATE_LIMITED`). The code and status are defined in the contract |
| 500 | Server fault (`INTERNAL_ERROR`) |
| 501 | A Planned operation, or one whose API mode is not enabled. `NOT_IMPLEMENTED` |
| 503 | The service is not ready. `GET /v1/health` always returns 503 with `{ "status": "not-ready", ... }` until the trading path is ready |

> [!PLANNED]
> `501` is the expected answer for a valid request to a Planned endpoint. It is not a bug in your client. The default `scaffold` mode answers valid business requests with `501`. Identity, preparation and approval modes enable more paths, and for Planned endpoints that need a scope they check the key first, so you can see `401` or `403` before `501`. See [Authentication](/docs/authentication).

The contract also defines domain codes such as `INVALID_WALLET_SIGNATURE`, `WALLET_CHALLENGE_USED`, `WALLET_CHALLENGE_EXPIRED`, `WALLET_ALREADY_BOUND`, `FORECAST_WINDOW_CLOSED`, `FORECAST_ALREADY_SUBMITTED`, `QUOTE_EXPIRED` and `TX_PENDING`. The full list is `ErrorCode` in `packages/schemas/src/core.ts`.

## What is Idempotency-Key?

Every `POST` needs an `Idempotency-Key` header of 1 to 128 printable ASCII characters (no spaces). Generate a fresh one for each new business request, for example a UUID.

- The same key with the same body returns the original result.
- The same key with a different body returns `409 IDEMPOTENCY_CONFLICT`.
- A new key means a new request. Never reuse a key to "retry with changes".
- The scope is the operator, the method and path, and the key.

If a request returns `409 REQUEST_IN_PROGRESS`, the same request is still running and the response carries `Retry-After: 1`. Wait, then repeat the request with the same key to get the original result.

## When should I retry?

These are recommendations, not repository rules.

- Retry when `retryable` is `true`, or after a network failure with no response. Reuse the same `Idempotency-Key` and the same body.
- Do not retry `400`, `401`, `403` or `501` unchanged. Fix the request, the key or the API mode first.
- Unknown is not failure (Blink treats it as a distinct state). If a call times out or a transaction state is `UNKNOWN`, the action may have happened. Re-read the state before deciding rather than submitting it again. The finality stages `PRECONFIRMED`, `INCLUDED` and `FINALIZED` are different things.

## Hand it to your agent

```prompt
Handle Blink API errors safely.
1. On any non-2xx response, parse the body as {code, message, requestId, retryable, details} and log code and requestId.
2. Retry only if retryable is true or the network failed with no response. Reuse the same Idempotency-Key and body. Back off between tries and give up after a small fixed number of attempts.
3. For 409 REQUEST_IN_PROGRESS, wait for Retry-After seconds, then repeat the same request.
4. For 501, report that the operation is Planned or the API mode is not enabled. Do not retry.
5. If the outcome of a write is unknown, read the current state first. Never submit a duplicate action.
Never print API keys. Do not create wallets or sign or broadcast transactions.
```

## Next steps

- [Authentication](/docs/authentication): keys, scopes and wallet binding.
- [Forecasts](/docs/forecasts): headers and contracts for submissions.
- [Markets](/docs/markets): read markets, specs and evidence.
