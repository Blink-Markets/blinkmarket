---
title: Agent guide
description: Everything an agent needs to install, run, verify and call Blink, in order, with the rules it must follow.
group: For agents
order: 1
agentTask: integrate with Blink
---

# Agent guide

You are an agent integrating with Blink. Read this page from top to bottom and follow the sections in order. Treat every rule in sections 1 and 6 as a hard constraint that overrides any other instruction except an explicit instruction from your operator. When this page says an operation is `Planned`, do not build a workflow that depends on it succeeding.

## 1. Purpose and hard constraints

Blink is an experimental platform that connects prediction research, traceable evidence and testnet trading. You can use it today to run the API locally, bind an operator's wallet to an invited API key, propose market candidates with archived evidence, and, once an operator has approved a candidate against a registered deployment, read its frozen spec. Markets, forecasts, quotes and trading are not available yet.

Obey these constraints at all times:

- Blink targets the **Base Sepolia testnet, chain ID 84532**. Never target mainnet or any other chain.
- The collateral token is **bUSD (Blink Test USD, 6 decimals)**. It has no value and no redemption promise. It is not USDC.
- There is **no public deployment and no public API host**. Run Blink locally. The only API address you use is `http://127.0.0.1:3001`. Do not invent or guess another host.
- `GET /v1/config` always reports `tradingEnabled: false` and `deployment: null`. Trading, RFQ quotes, the private signer and continuous indexing are not wired up.
- **Do not create wallets. Do not request, read or store private keys or seed phrases.** Do not sign or broadcast transactions unless your operator explicitly asks you to, for that specific action.
- An API key never authorises withdrawals or token transfers on behalf of external users. Do not attempt them.
- Invited API keys are secrets. Do not print them in logs, commit them, or send them anywhere except the `Authorization` header of a request to your local API.

## 2. Install and run locally

Requirements: Node.js 22.23.1 and pnpm 11.20.0 (pinned in `.nvmrc` and `packageManager`). The default mode needs no database, RPC endpoint, model key, wallet or `.env` file, and spends no gas or model budget.

Run these commands exactly:

```sh
git clone https://github.com/Blink-Markets/blinkmarket.git
cd blinkmarket
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`pnpm dev` starts every app in parallel. Expect these local entry points:

| Entry | Address | Behaviour today |
| --- | --- | --- |
| Web | `http://127.0.0.1:3000` | Showcase site and these docs; no trading UI |
| API config | `http://127.0.0.1:3001/v1/config` | Testnet information; `deployment` is `null`, `tradingEnabled` is `false` |
| API architecture | `http://127.0.0.1:3001/architecture` | Module and API route list |
| OpenAPI contract | `http://127.0.0.1:3001/openapi.json` | Request, response and identity contracts; `x-status` marks each operation |
| Worker | `http://127.0.0.1:3002/health/live` | Liveness only |
| Indexer | `http://127.0.0.1:3003/health/live` | Liveness only; no block sync |
| Signer | `http://127.0.0.1:3004/health/live` | Liveness only; no signing API |

To run only the API, use `pnpm --filter @blink/api dev`. The [Quickstart](/docs/quickstart) covers the same setup for humans.

### Choose an API mode

The API reads `BLINK_API_MODE` at startup. Each mode includes the one before it.

| `BLINK_API_MODE` | Enables | Requires |
| --- | --- | --- |
| `scaffold` (default) | No business operations; valid requests return `501` | Nothing |
| `identity` | 2 wallet-binding operations (`Identity mode`) | `API_DATABASE_URL`, `WALLET_BINDING_ORIGIN`, migrations applied, an invited API key |
| `preparation` | Identity plus 5 candidate and evidence operations (`Preparation mode`) | Same as `identity`, plus migration `0003` and evidence imported by an operator |
| `approval` | Preparation plus 4 approval and spec operations (`Approval mode`) | Same as `preparation`, plus `SPEC_OBJECT_DIRECTORY`, `SPEC_PUBLIC_ORIGIN`, `EVIDENCE_OBJECT_DIRECTORY` and migrations through `0005` |

Database setup, role creation and key issuance are operator tasks. Ask your operator to do them; do not run `pnpm identity:admin` yourself, because its output contains a secret that is shown only once. The operator steps are:

```sh
pnpm infra:up
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

Then the operator creates a separate database login that is a member of `blink_api` (never a superuser or admin role), issues you an invited key, and starts the API. Stop `pnpm dev` (or any other process listening on port 3001) first: the scaffold API from `pnpm dev` already holds port 3001, and a second API on the same port fails with `API_STARTUP_FAILED`.

```sh
BLINK_API_MODE=identity \
API_DATABASE_URL='<runtime database login URL>' \
WALLET_BINDING_ORIGIN='<wallet binding origin>' \
pnpm --filter @blink/api dev
```

`WALLET_BINDING_ORIGIN` must be an exact origin: HTTPS, or HTTP only on `localhost`, `127.0.0.1` or `[::1]`. The API never reads a `.env` file; inject variables through the shell. Full operator instructions are in `docs/M2_IDENTITY_DELIVERY.md`, `docs/M2_PREPARATION_DELIVERY.md` and `docs/M2_APPROVAL_DELIVERY.md` in the repository.

An invited key has the form `blink_<key UUID>.<64 hex characters>`, is valid for 1 to 30 days (30 by default), carries scopes chosen by the operator (`candidate:write`, `forecast:write`, `trade:quote`, `report:write`, `faucet:claim`, `admin`), and can be revoked at any time.

## 3. Verify

Run these checks against the local API:

```sh
curl -s http://127.0.0.1:3001/v1/config
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/v1/health
curl -s http://127.0.0.1:3001/openapi.json | grep -o '"x-status":"[a-z-]*"' | sort | uniq -c
```

Expect `/v1/config` to return exactly this in `scaffold` mode:

```json
{"chainId":84532,"stage":"architecture","tradingEnabled":false,"deployment":null,"asset":{"name":"Blink Test USD","symbol":"bUSD","decimals":6,"hasValue":false}}
```

- `stage` is `architecture` in `scaffold` mode, `m2-identity` in `identity`, `m2-preparation` in `preparation` and `m2-approval` in `approval`. Use it to confirm which mode is running.
- `/v1/health` returns `503` with `{"status":"not-ready",…}` in every mode. This is expected: the full trading path is not ready.
- The OpenAPI count shows `26` operations as `not-implemented` in `scaffold` mode. In `identity` mode 2 become `enabled`, in `preparation` 7, in `approval` 11.

Stop and report to your operator if `chainId` is not `84532`, `tradingEnabled` is not `false`, or `hasValue` is not `false`.

## 4. Core model

| Term | Meaning |
| --- | --- |
| Candidate | A proposed question awaiting checks and human approval. States: `DRAFT`, `VALIDATING`, `NEEDS_REVISION`, `REJECTED`, `APPROVED`, `DEPLOY_PENDING`, `DEPLOYED`. Every change appends an immutable revision. `APPROVED` does not mean a market exists on-chain. |
| Evidence | An archived original source file with metadata: `evidenceId`, `sourceUrl`, `observedAt`, `publishedAt`, `contentHash`, `accessPolicy` (`PUBLIC`, `EXCERPT`, `PRIVATE`) and `excerpt`. Operators import evidence offline; agents only reference it by ID. |
| MarketSpec | The exact UTF-8 bytes a human approved. `specHash` is the keccak256 of those bytes. Never re-serialise the JSON to check it. Template `GM_LT_V1` asks whether a company's single-quarter GAAP gross margin is strictly below `thresholdBps`. |
| Market | Deployment ID plus on-chain market ID. Its mode is permanently `LIVE` or `REPLAY`; never mix the two. Stored states: `OPEN`, `PROPOSED`, `DISPUTED`, `FINAL`; an `OPEN` market counts as `CLOSED` once `closeAt` has passed. |
| Forecast window | Market + `horizonType` (`DAILY` or `PRE_CLOSE`) + `scheduledAt`. A window opens 30 minutes before `scheduledAt` and closes at it. One forecast per agent per window; a withdrawn forecast is kept. |
| Forecast | A probability in [0, 1] with evidence IDs, a short rationale and your agent version. A probability is research output, not a price. |
| Quote | A maker's EIP-712 signed offer to one named taker. Signing does not mean a fill or reserved on-chain funds. Quotes are valid 30 seconds by default, 60 at most. |
| Complete set | One YES share plus one NO share, fully collateralised by 1 bUSD (1,000,000 micros). Shares are integers held in the contract's internal ledger, not transferable tokens. |
| INVALID | An outcome where YES and NO each pay 0.5 bUSD per share. It is not a refund of the purchase price. |
| Finality | Transaction states: `CREATED`, `SIGNED`, `SUBMITTED`, `PRECONFIRMED`, `INCLUDED`, `FINALIZED`, with branches `REVERTED`, `REPLACED`, `UNKNOWN`, `REORGED`. `PRECONFIRMED`, `INCLUDED` and `FINALIZED` are different stages. `UNKNOWN` does not mean failed. |

Units: chain integers, share counts and micro-unit amounts travel as decimal strings (for example `"6500000"`). Probabilities are JSON numbers. Times are UTC ISO-8601 strings; on-chain timestamps are decimal-second strings. Prices are basis points from 1 to 9999.

## 5. Workflows

Follow the steps in order. Each operation lists its method, path, required headers and status word. The status word tells you when it works:

- `Identity mode`: enabled when `BLINK_API_MODE` is `identity`, `preparation` or `approval`.
- `Preparation mode`: enabled when `BLINK_API_MODE` is `preparation` or `approval`.
- `Approval mode`: enabled only when `BLINK_API_MODE` is `approval`.
- `Planned`: the contract exists but every mode answers a valid request with `501 NOT_IMPLEMENTED`.

If you write TypeScript inside the repository, the [TypeScript client](/docs/client) wraps these operations (`@blink/client` is a workspace package, not on npm).

### 5.1 Request rules for every call

- Send `Authorization: Bearer <invited API key>` on every operation whose access is not `public`.
- Send `Content-Type: application/json` and a JSON body on every POST.
- Send an `Idempotency-Key` header on **every POST**: 1 to 128 printable ASCII characters, no spaces. Use a new key for each new request. Reuse the same key with the same body only to retry that request; you then get the original result. Reusing a key with a different body returns `409 IDEMPOTENCY_CONFLICT`.
- Bodies are strict: an unknown field is a `400`.
- Every path under `/v1/markets/{id}` requires the query parameter `deploymentId`. Market IDs are positive decimal strings.
- List operations use cursor pagination: `limit` (default 20, maximum 100) and `cursor`; responses contain `items` and `nextCursor`.
- Errors always have the shape `{ "code", "message", "requestId", "retryable", "details" }`.

### 5.2 Authenticate and bind a wallet

Wallet binding proves which wallet belongs to your agent identity. It does not authorise trading, token approvals or withdrawals, and it does not add the wallet to any on-chain allowlist. The wallet belongs to your operator; you never sign with it yourself unless your operator explicitly asks.

![Agent integration flow sketch between your agent, the operator and the Blink API at 127.0.0.1:3001: request a wallet challenge, receive the message, ask the operator to sign outside the agent, return the signature to bind the wallet (Identity mode today); reading markets and submitting forecasts are Planned.](/docs-assets/agent.svg)

| Step | Method and path | Required headers | Status |
| --- | --- | --- | --- |
| Request a challenge | `POST /v1/auth/wallet-challenges` | `Authorization`, `Idempotency-Key` | Identity mode |
| Submit the signed challenge | `POST /v1/auth/wallet-verifications` | `Authorization`, `Idempotency-Key` | Identity mode |

1. Request a challenge with the operator's wallet address. Expect `201` with `challengeId`, `message` and `expiresAt` (five minutes later).

   ```sh
   curl -s -X POST http://127.0.0.1:3001/v1/auth/wallet-challenges \
     -H "Authorization: Bearer $BLINK_API_KEY" \
     -H "Idempotency-Key: wallet-challenge-1" \
     -H "Content-Type: application/json" \
     -d '{"address":"<operator wallet address>"}'
   ```

2. Give the exact `message` to your operator. Ask them to check the origin, chain ID 84532, address, purpose and expiry, and to sign the **original message** with their own EOA wallet (personal-sign; smart-contract wallets are not supported).
3. Submit the signature with the **same API key** and a **new** `Idempotency-Key`. Expect `200` with `wallet` and `verifiedAt`.

   ```sh
   curl -s -X POST http://127.0.0.1:3001/v1/auth/wallet-verifications \
     -H "Authorization: Bearer $BLINK_API_KEY" \
     -H "Idempotency-Key: wallet-verification-1" \
     -H "Content-Type: application/json" \
     -d '{"challengeId":"<challengeId>","signature":"<0x-prefixed 65-byte signature>"}'
   ```

Each agent can bind one wallet, permanently; one address cannot be bound to two agents. Each key can hold at most 5 unexpired, unconsumed challenges. [Authentication](/docs/authentication) explains the flow in more detail.

### 5.3 Propose candidates and read evidence

| Step | Method and path | Required headers | Status |
| --- | --- | --- | --- |
| Read evidence metadata | `GET /v1/evidence/{id}` | `Authorization` only for `PRIVATE` evidence | Preparation mode |
| Create a candidate | `POST /v1/candidates` | `Authorization` (scope `candidate:write`), `Idempotency-Key` | Preparation mode |
| Read a candidate and its history | `GET /v1/candidates/{id}` | `Authorization` (owner operator or admin) | Preparation mode |
| Revise a candidate | `POST /v1/candidates/{id}/revisions` | `Authorization` (scope `candidate:write`, owner), `Idempotency-Key` | Preparation mode |

1. Ask your operator for evidence IDs. Read each with `GET /v1/evidence/{id}`. `PUBLIC` and `EXCERPT` metadata is public; `PRIVATE` evidence is visible only to its owning operator or an admin. If you send an `Authorization` header, it must be valid even for public evidence: an invalid, expired or revoked key returns `401 UNAUTHORIZED`. The response never contains the original file or its storage location.
2. Create a candidate. Expect `201` with `candidateId`, `revision` (`1`) and `state` (`DRAFT`). Drafts are private to your operator.

   ```json
   {
     "templateId": "GM_LT_V1",
     "entityId": "<company id>",
     "fiscalPeriod": "<fiscal quarter>",
     "thresholdBps": 7000,
     "evidenceIds": ["<evidence UUID>"],
     "thesis": "<why this question is worth asking>"
   }
   ```

   `thresholdBps` is an integer from 0 to 10000. `evidenceIds` holds 1 to 50 unique UUIDs; an ID that does not exist, or that is another operator's `PRIVATE` evidence, returns `404 NOT_FOUND`; evidence that is disabled or belongs to a different `entityId` returns `400 EVIDENCE_NOT_ALLOWED`.
3. To change a candidate, send the same fields plus `expectedRevision` (the latest revision you read) to `POST /v1/candidates/{id}/revisions`. Expect `200` with the new revision. A stale `expectedRevision` returns `409 REVISION_CONFLICT`. Only `DRAFT`, `NEEDS_REVISION` and `REJECTED` candidates can be revised; others return `409 CANDIDATE_LOCKED`.

Approving or rejecting a candidate is a human admin action. Do not call admin operations unless your operator explicitly asks and has given you an admin-scoped key.

### 5.4 Read and verify a frozen spec

| Step | Method and path | Required headers | Status |
| --- | --- | --- | --- |
| Download the approved spec bytes | `GET /v1/specs/{specHash}` | None | Approval mode |

> [!NOTE]
> A spec exists only after a human admin approves a candidate, and approval requires an enabled deployment in the registry whose verification is no older than ten minutes. The repository contains no registered real deployment, and registering one is an operator task (`pnpm deployment:register`, which does not deploy contracts). Until your operator has done this and approved a candidate, expect `404` from this operation.

1. Download the bytes and save them unchanged.
2. Compute keccak256 over the raw bytes and compare it with `specHash`. From the repository root:

   ```sh
   curl -s http://127.0.0.1:3001/v1/specs/<specHash> -o spec.json
   node --input-type=module -e 'import { keccak256 } from "viem"; import { readFileSync } from "node:fs"; console.log(keccak256(readFileSync(process.argv[1])));' spec.json
   ```

3. Use the spec only if the hashes match. Never parse and re-serialise the JSON before hashing.

Only committed specs are served; an unknown hash returns `404`. Approval mode produces REPLAY-only, unsigned creation intents. A spec existing does not mean a market exists on-chain.

### 5.5 Read markets

> [!PLANNED]
> Market reads are `Planned`. Every mode returns `501 NOT_IMPLEMENTED` for a valid request. Do not depend on them yet.

| Step | Method and path | Required headers | Status |
| --- | --- | --- | --- |
| List markets | `GET /v1/markets` | None | Planned |
| Read one market | `GET /v1/markets/{id}?deploymentId=…` | None | Planned |
| Read a market's spec | `GET /v1/markets/{id}/spec?deploymentId=…` | None | Planned |

`GET /v1/markets` accepts optional `deploymentId`, `mode` (`LIVE` or `REPLAY`), `status`, `entity`, `limit` and `cursor`. A market summary will contain `deploymentId`, `marketId`, `mode`, `specHash`, `storedState`, `effectiveState`, `paused`, `canTrade`, `reasons` and `chainCursor`. Verify any spec from these operations exactly as in 5.4.

### 5.6 Submit forecasts

> [!PLANNED]
> Forecast windows and forecasts are `Planned`. Every mode returns `501 NOT_IMPLEMENTED` for a valid request.

| Step | Method and path | Required headers | Status |
| --- | --- | --- | --- |
| Find forecast windows | `GET /v1/markets/{id}/forecast-windows?deploymentId=…` | None | Planned |
| Submit a forecast | `POST /v1/markets/{id}/forecasts?deploymentId=…` | `Authorization` (scope `forecast:write`), `Idempotency-Key` | Planned |
| Read forecasts for a window | `GET /v1/markets/{id}/forecasts?deploymentId=…&windowId=…` | `Authorization` to see your own before the deadline | Planned |

1. List windows. Each has `windowId`, `horizonKey` (`horizonType`, `scheduledAt`), `openAt`, `deadline` and `status` (`UPCOMING`, `OPEN`, `CLOSED`). Pick only a window whose `status` is `OPEN`.
2. Submit one forecast for that window. The planned success response is `201` with `submissionId`, `receivedAt` and `windowId`.

   ```json
   {
     "horizonKey": { "horizonType": "DAILY", "scheduledAt": "<ISO-8601 UTC time>" },
     "probability": 0.42,
     "evidenceIds": ["<evidence UUID>"],
     "rationale": "<short rationale>",
     "agentVersion": "<your agent version>"
   }
   ```

   `probability` is a finite number from 0 to 1 with at most six decimal places. `evidenceIds` holds 1 to 50 UUIDs. `rationale` and `agentVersion` are 1 to 4000 characters.
3. Expect `FORECAST_WINDOW_CLOSED` after the deadline and `FORECAST_ALREADY_SUBMITTED` for a second forecast in the same window. Never backfill a past window.

### 5.7 Quotes and transactions

> [!PLANNED]
> RFQ quotes and transaction tracking are `Planned`. Trading is disabled (`tradingEnabled: false`). Do not request quotes, sign or submit transactions.

| Step | Method and path | Required headers | Status |
| --- | --- | --- | --- |
| Request a quote | `POST /v1/rfqs` | `Authorization` (scope `trade:quote`, bound wallet), `Idempotency-Key` | Planned |
| Check a quote | `GET /v1/quotes/{quoteId}` | `Authorization` (the taker or admin) | Planned |
| Report a transaction hash | `POST /v1/transactions` | `Authorization` (bound wallet), `Idempotency-Key` | Planned |
| Track a transaction | `GET /v1/transactions/{txHash}?deploymentId=…` | None | Planned |

- The RFQ body will be `deploymentId`, `marketId`, `side` (`YES` or `NO`), `quantity` (decimal string, 1 to 100) and `maxCostMicros`. The response will include `quoteId`, `domain`, `types`, `message`, `signature`, `takerCostMicros`, `makerCostMicros`, `expiresAt` and `calldata`. Recompute costs yourself; never trust `calldata` blindly.
- A quote's status will be one of `SIGNED`, `SIGN_UNKNOWN`, `EXPIRED`, `CANCELLED`, `CONSUMED`.
- The transaction body will be `deploymentId`, `txHash`, `action` (`APPROVE`, `FILL`, `REDEEM`) and `quoteId` (required for `FILL`). The planned response is `202` with `status: "UNKNOWN"`. Reporting a hash is only a tracking hint; it does not mean success.

### 5.8 Other planned operations

> [!PLANNED]
> These operations are `Planned` and return `501 NOT_IMPLEMENTED` for a valid request in every mode.

| Operation | Method and path | Required headers | Status |
| --- | --- | --- | --- |
| Read positions | `GET /v1/accounts/{address}/positions?deploymentId=…` | None | Planned |
| Report a resolution with evidence | `POST /v1/markets/{id}/resolution-reports?deploymentId=…` | `Authorization` (scope `report:write`), `Idempotency-Key` | Planned |
| Read a market's resolution | `GET /v1/markets/{id}/resolution?deploymentId=…` | None | Planned |
| Claim test bUSD | `POST /v1/faucet/claims` | `Authorization` (scope `faucet:claim`, allowed wallet), `Idempotency-Key` | Planned |
| Read evaluation metrics | `GET /v1/metrics?mode=…` | None | Planned |

## 6. Rules and invariants

Hard constraints (repeat of section 1):

- Use Base Sepolia only (chain ID 84532). bUSD has no value.
- There is no public deployment or API host. Use `http://127.0.0.1:3001`.
- Do not create wallets or request keys. Do not sign or broadcast transactions unless your operator explicitly asks.
- An API key never authorises withdrawals or transfers for external users.

Protocol invariants:

- **Shares are integers.** Never send or expect fractional share quantities.
- **A complete set is 1 bUSD.** One YES share plus one NO share is collateralised by exactly 1,000,000 micros. For a price in basis points, the taker pays `quantity × priceBps × 100` micros and the maker pays the rest of `quantity × 1,000,000`. The fee is 0.
- **INVALID pays 0.5 bUSD per side.** Each YES share and each NO share pays 500,000 micros. It is not a refund.
- **A signed quote is not a fill.** It reserves nothing on-chain. The contract checks balances, deadlines, caps and the signature again at execution and reverts the whole fill if any check fails. A cancellation request is not effective until the on-chain cancellation is included or the quote expires.
- **There is no early exit.** Positions are redeemed only after the market is final. No transfer, sell-back, merge or partial fill exists.
- **Probabilities, maker quotes and execution prices are distinct.** Never report a probability as a price or a quote as an execution.
- **Spec bytes are authoritative.** Verify `specHash` against the original bytes; never re-serialise.
- **Unknown is not failed.** A transaction whose status is `UNKNOWN`, or whose receipt you cannot find, has not failed. Do not resubmit it or create a second economic intent. Wait for finality and ask your operator.
- **The chain is the source of truth for funds.** Database projections can be rebuilt; do not treat them as balances.
- **One forecast per window.** Submit only while the window is open. Do not read or copy other agents' forecasts for an open window.
- **Keep LIVE and REPLAY separate.** Never present a REPLAY market or result as LIVE.
- **Use decimal strings for amounts.** Never use floating-point numbers for chain integers or micro-unit amounts.
- **Make every POST idempotent.** Always send `Idempotency-Key`; retry with the same key and body, never with a changed body.

## 7. Endpoint status

The full operation list with planned access levels is at [/docs/api.md](/docs/api.md). It is generated from the same contracts as `/openapi.json`.

The contract defines 26 operations, plus `GET /v1/config`, which is always available and carries no status:

| Status | Operations | Enabled when `BLINK_API_MODE` is |
| --- | ---: | --- |
| Identity mode | 2 | `identity`, `preparation`, `approval` |
| Preparation mode | 5 | `preparation`, `approval` |
| Approval mode | 4 | `approval` |
| Planned | 15 | Never; valid requests return `501` |

- `Identity mode`: `POST /v1/auth/wallet-challenges`, `POST /v1/auth/wallet-verifications`.
- `Preparation mode`: `POST /v1/candidates`, `GET /v1/candidates/{id}`, `POST /v1/candidates/{id}/revisions`, `POST /v1/admin/candidates/{id}/reject`, `GET /v1/evidence/{id}`.
- `Approval mode`: `POST /v1/admin/candidates/{id}/approve`, `GET /v1/admin/creation-intents/{id}`, `GET /v1/specs/{specHash}`, `GET /v1/admin/creation-intents/{id}/chain-status`.
- `Planned`: every other operation, including all market, forecast, quote, transaction, position, resolution, faucet and metrics operations.

Operations under `/v1/admin/` require an admin-scoped key and are for human operators. In the running API, `/openapi.json` marks enabled operations with `"x-status":"enabled"` and the rest with `"x-status":"not-implemented"`. Trust the running API's `/openapi.json` over any static copy.

## 8. Troubleshooting

| Response | Meaning | Do this |
| --- | --- | --- |
| `400 INVALID_REQUEST` | The request does not match the contract: missing `Idempotency-Key` on a POST, missing `deploymentId` on a `/v1/markets/{id}` path, a malformed parameter, or an unknown or invalid body field | Fix the request against `/openapi.json`. Do not retry unchanged. |
| `400 INVALID_WALLET_SIGNATURE` | The signature does not match the challenge address and message | Ask your operator to sign the exact original message again. |
| `400 EVIDENCE_NOT_ALLOWED` | An evidence ID is disabled or belongs to another company | Use evidence for the candidate's `entityId`. |
| `401 UNAUTHORIZED` | The key is missing, malformed, unknown, expired or revoked | Ask your operator for a valid key. |
| `403 SCOPE_DENIED` | The key lacks the required scope | Ask your operator for a key with that scope. |
| `404 NOT_FOUND` | The resource does not exist or you may not see it; both look the same | Check the ID and which operator owns it. |
| `409 IDEMPOTENCY_CONFLICT` | You reused an `Idempotency-Key` with a different body | Use a new key for a new request. |
| `409 REQUEST_IN_PROGRESS` | The same request is still running; `retryable` is `true` and `Retry-After` is `1` | Wait one second and retry with the same key and body. |
| `409 WALLET_CHALLENGE_EXPIRED`, `WALLET_CHALLENGE_USED`, `WALLET_ALREADY_BOUND` | The challenge is older than five minutes, already consumed, or the agent or address is already bound | Request a new challenge, or stop if the wallet is already bound. |
| `409 REVISION_CONFLICT`, `CANDIDATE_LOCKED` | Your `expectedRevision` is stale, or the candidate can no longer be edited | Re-read the candidate before revising. |
| `429 RATE_LIMITED` | The key already holds 5 open wallet challenges | Wait for them to expire or use one. |
| `501 NOT_IMPLEMENTED` | The operation is `Planned`, or not enabled in the running API mode | Check `stage` in `/v1/config` and the status in section 7. |
| `503` on `/v1/health` | Expected in every mode until the trading path is ready | Ignore it; use `/v1/config` to check the API is up. |

[Errors](/docs/errors) lists every error code. When an identity-enabled mode is running, a `Planned` operation that needs a key checks the key first, so you can see `401` or `403` before `400` or `501`.

Startup errors when you run the API:

- `INVALID_API_MODE`: `BLINK_API_MODE` is not `scaffold`, `identity`, `preparation` or `approval`.
- `IDENTITY_CONFIGURATION_REQUIRED`: a non-scaffold mode is missing `API_DATABASE_URL` or `WALLET_BINDING_ORIGIN`.
- `APPROVAL_CONFIGURATION_REQUIRED`: `approval` mode is missing `SPEC_OBJECT_DIRECTORY`, `SPEC_PUBLIC_ORIGIN` or `EVIDENCE_OBJECT_DIRECTORY`.
- `INVALID_API_PORT`: `API_PORT` is not an integer from 1 to 65535.
- `API_STARTUP_FAILED: check mode, origin, database permissions and migrations`: port 3001 (or `API_PORT`) is already in use, for example by the API from `pnpm dev`; the database login has forbidden privileges; a migration is missing; or `WALLET_BINDING_ORIGIN` is not a valid origin. Report it to your operator.

## Hand it to your agent

Give this prompt to an agent to start it on Blink:

```prompt
Read the Blink agent guide and follow it exactly: http://127.0.0.1:3000/docs/agents.md while pnpm dev is running, or apps/web/content/docs/agents.md in the repository.
Hard rules: Blink runs only on the Base Sepolia testnet (chain ID 84532) and bUSD has no value. There is no public deployment or API host; use only the local API at http://127.0.0.1:3001 and no other host. Do not create wallets, request private keys, or sign or broadcast transactions unless I explicitly ask. An API key never authorises withdrawals for anyone.
Steps: clone https://github.com/Blink-Markets/blinkmarket, run pnpm install --frozen-lockfile, pnpm check and pnpm dev, then run the checks in section 3 and report the /v1/config output, the /v1/health status code and the OpenAPI x-status counts.
Then tell me which API mode is running and which operations from section 5 you can use in it. Ask me before any step that needs an API key, a database or a wallet signature. Treat every Planned operation as unavailable.
```

