# 02 — API and Data Contracts

_Status: historical — v0.1 team-operated design baseline (2026-09-22), largely retired by the autonomous-market redesign of 2026-10-23 (§6). Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

Implementation differences: `GET /v1/quotes/:quoteId` returns only a signed envelope. When unsigned it returns 404, not SIGN_UNKNOWN. An RFQ SIGN_UNKNOWN is recovered by resending the POST with the same key and the same body. The market detail hooks `forecastSnapshotId` / `costMicros` are not wired yet and are currently null / `"0"`. The metrics budget total is platform-wide and is not split by mode. See [RFQ limits](../M2_RFQ.md) and [evaluation](../M3_EVALUATION.md).

M2.3a adds the admin-only `GET /v1/admin/creation-intents/:id/chain-status`. It returns a historical observation snapshot with observedAt/headHash and does not trigger an RPC on GET. Even CONFIRMED does not mean the transaction cannot be reorged. For details see [creation tracking](../M2_CREATION_TRACKING.md).

All endpoints use the prefix /v1. Identity mode enables wallet auth. Preparation mode also enables the candidate/evidence flow. Approval mode adds manual approval, admin creation-intent queries and public original spec bytes, see [M2 approval delivery](../M2_APPROVAL_DELIVERY.md). Markets mode wires public markets / positions / settlement / transaction tracking, forecast, resolution reports and metrics. Trading mode also wires RFQ, faucet, the public `GET /v1/health` and the admin-only `GET /v1/admin/metrics`. Health returns `{status, tradingEnabled, reasons}`. Ready is 200, otherwise 503. An admin key adds details. An invalid or non-admin key gets 401 / 403. API `/health/ready` uses the same decision. Earlier modes stay not-ready. Admin metrics provide execution latency, persisted state / error counts and role/day gas. They are not the public evaluation metrics, see [health and metrics](../M5_HEALTH_METRICS.md). Paths that are not enabled still fail closed. The official OpenAPI is generated from apiContracts. Actual availability depends on the runtime mode and readiness. See [public reads](../M2_PUBLIC_READS.md), [RFQ](../M2_RFQ.md) and [keeper/faucet](../M3_KEEPER_FAUCET.md). The API is not deployed yet.

## ID / types / versions

- deploymentId: an opaque release ID. One chain can have multiple deployments. marketId: the on-chain uint256 as a decimal string, starting from 1. The DB market UUID is called marketRecordId and is used only as an internal FK.
- GET /markets/:id and its subpaths require the query deploymentId. POST on the same subpaths also names it in the query. The RFQ body and other cross-deployment writes require deploymentId in the body. If missing, return 400. If it is inconsistent with the held quote/manifest, return 409 DEPLOYMENT_MISMATCH.
- GET /markets can span deployments, and each item carries deploymentId/marketId/mode. The accounts positions and transactions queries also require deploymentId. /config for an undeployed system returns deployment=null, tradingEnabled=false.
- Identity and business records use UUIDs. A UUID is never put into the on-chain marketId. Evidence / candidate / forecast IDs are not required to be decimal.
- All on-chain integers / share counts / micro-unit values on the wire are decimal strings without leading zeros, with magnitude validated to uint64/uint256. Quote side is "0"/"1" and RFQ side is "YES"/"NO", converted only in the shared mapper.
- Probability is a finite JSON number, 0..1, with at most 6 decimal places. Excess precision is rejected and not silently truncated. The DB uses NUMERIC(7,6). Pricing converts to integer millionths before computing, to avoid float ceil errors.
- JSON timestamps use UTC ISO-8601 Z. The seconds signed for the contract are decimal strings. Enum, amount, address and hash all have shared schemas. After validation, an address is stored in the DB as 20 bytes and a hash as 32 bytes. The API returns hex.
- Unknown body fields are rejected, and query filters have an allowlist. content-type=application/json. The default body limit is 64KiB. Evidence full text goes through a controlled storage pipeline, and POST does not carry arbitrary blobs.
- A list returns {items,nextCursor}. limit defaults to 20 and is at most 100. The cursor encapsulates the sort key createdAt/id and a filter hash, to prevent reuse with other filters. Results are filtered again by endpoint permission.

The earlier "opaque market ID" design is explicitly replaced by this deployment-aware rule, see ADR0002. The shared schemas already use deploymentId + chain decimal marketId. `@blink/client` now has typed endpoint responses, runtime validation, same-key retry, and spec hash and signed quote verification. It is still a private workspace package and not published to npm. The external agent example connects only to a local RPC, see [SDK delivery](../M5_CLIENT_SDK.md).

## Identity

API key: a 256-bit random secret, shown only once. The key ID is visible and the secret hash is stored. The server compares in constant time. A key is bound to operator/agent/scopes/expiresAt/revokedAt. It is valid for 30 days by default and revocable, and a deployment policy may shorten it. Issuing a key by invitation is an audited admin operation. There is no public self-signup at first.

Wallet challenge: an authenticated key requests an address. The server generates a nonce, a fixed domain, chainId 84532, issuedAt, expiresAt (5 minutes) and keyId/agentId. The message states "binds identity only; does not authorize trading or withdrawals". Only the exact challenge bytes stored by the server are accepted. EOA signature verification is done, the nonce is consumed in the same transaction, and the wallet binding is written. In v0.1 the external client uses an EOA, and smart-account verification is added separately. The challenge itself has no approve/fill meaning.

Verification order: key → scope → resource owner → wallet → rate limit → idempotency → schema/use case. An invalid key gets 401 and a missing permission gets 403. A private candidate/quote does not reveal its existence to others and returns 404. Every idempotent resend re-verifies the current permission. A past success does not bypass revocation.

Admin operations use a restricted admin key/session. If the Web later uses cookies, they must be HttpOnly/Secure/SameSite with CSRF protection. The API bearer key is not stored in the public frontend bundle. An on-chain ADMIN signature is made by a person's wallet. API admin is not treated as the on-chain signing authority.

## Idempotency

Every POST must carry an Idempotency-Key (1..128 printable ASCII). scope=(operatorId, HTTP method + resolved deployment/resource path, key). The payload hash covers all semantic body/query content after normalization. JSON key order does not affect the hash. This normalization applies only to the HTTP request and not to spec bytes.

The first write is IN_PROGRESS. After the business DB transaction succeeds, the status code / response or the intent reference is saved. The same payload after completion returns the original result. While in progress it returns 409 REQUEST_IN_PROGRESS + Retry-After. A different payload returns 409 IDEMPOTENCY_CONFLICT. An RFQ resend after expiry still returns the same expired quote and does not automatically produce a new price.

An IN_PROGRESS with external side effects is not redone just because a lease expired. It is resolved by looking up the intent / sign request / provider ID. v0.1 does not delete mutation keys automatically, to avoid replay by late retries. A business rejection also stores its final result. Whether a transient failure can be continued depends on the intent state, and no new intent is opened.

## Core writes

| Endpoint | Business fields of the request | Success response |
| --- | --- | --- |
| POST /candidates | templateId/entityId/fiscalPeriod/thresholdBps/evidenceIds/thesis | 201 candidateId/revision/state=DRAFT |
| POST /admin/candidates/:id/approve | expectedRevision/spec/budgetMicros/reason | 202 approvalId/specHash/creationIntentId/state=DEPLOY_PENDING |
| POST /admin/candidates/:id/reject | expectedRevision/reasonCode/reason | 200 candidateId/revision/state=REJECTED |
| POST /markets/:id/forecasts | horizonKey/probability/evidenceIds/rationale/agentVersion | 201 submissionId/receivedAt/windowId |
| POST /rfqs | deploymentId/marketId/side/quantity/maxCostMicros | 200 signed quote envelope |
| POST /transactions | deploymentId/txHash/action/quoteId (required for fill) | 202 trackingId/status=UNKNOWN |
| POST /markets/:id/resolution-reports | outcome/evidenceIds/reason | 202 reportId/state=RECEIVED |
| POST /faucet/claims | deploymentId | 202 claimId/intentId/state=QUEUED |

The approval spec is validated and frozen before the 202 is returned. The 202 means "deployment intent submitted". It does not mean the on-chain market exists. The forecast time is generated by the DB at the moment of receipt, and a client-supplied receivedAt is not accepted. horizonKey={horizonType,scheduledAt}. Full uniqueness also includes deployment/market.

transactions accepts only a txHash hint and independently queries the RPC for chain/from/to/function/log. A user body can never mark a transaction INCLUDED. Protect body/query logs from leaking sensitive data.

## RFQ envelope example structure

```text
{
  deploymentId, quoteId, marketId, mode,
  chainId: 84532, verifyingContract,
  domain: {name: "Blink RFQ", version: "0.1", chainId: 84532, verifyingContract},
  types: {Quote: [fixed 11 fields]},
  message: {marketId,specHash,maker,taker,side,quantity,priceBps,validAfter,expiresAt,nonce,epoch},
  signature,
  takerCostMicros, makerCostMicros, expiresAt,
  calldata,
  forecastSnapshotId,
  chainCursor: {blockNumber,blockHash,finality}
}
```

This illustrates the fields and is not a fake signed response. All message integers are strings. The client re-encodes, re-hashes and recovers from the fixed ABI/domain, and checks wallet / manifest / market spec / cost / maxCost / side / quantity / expiry. It must not blindly send the server calldata. Approve covers only this quote's amount. If the quote expires after approve, the client must request a new quote with a new idempotency key and reconfirm the price.

NO_QUOTE returns an error envelope with 409, and details.reason holds the specific reason. A clear STALE_FORECAST / INDEXER_LAG and similar can be used directly as the code. No made-up price is filled in.

## Read model

Market detail returns specHash/specURI/mode, storedState/effectiveState, paused, schedule, resolution, forecastSummary, costSummary, chainCursor, canTrade/reasons. A reason is only a hint for the current moment. A fill is still validated by the contract.

While the forecast window is not closed: an unauthenticated visitor gets empty items + windowStatus=OPEN. An authenticated agent gets only its own forecasts, and not the count, average or rationale of others. They become public only after the close. Withdrawn / contaminated markers are kept.

positions returns yesShares/noShares, payoutMicros (null before FINAL), pending intents and chainCursor. UNKNOWN adds no definite share count. resolution returns the actor / evidence / tx reference of the proposal / challenge / finalization, and distinguishes proposedOutcome from finalOutcome.

GET spec returns the stored original bytes with Content-Type application/json and ETag=specHash. It must not be re-serialized dynamically or have fields injected. Evidence metadata follows accessPolicy. A caller without full-text permission gets only the permitted excerpt and source, and no private object URI / presigned URL is returned to an unauthorized party.

## Error mapping

Common shape {code,message,requestId,retryable,details}. details holds only public data, and never a stack or provider credentials.

| HTTP | code category | Client behavior |
| --- | --- | --- |
| 400 | INVALID_REQUEST / INVALID_SPEC | fix the input |
| 401 / 403 | UNAUTHORIZED / SCOPE_DENIED / WALLET_NOT_VERIFIED | re-authenticate or complete the binding, do not resend the transaction |
| 404 | NOT_FOUND | check the deployment/resource; do not leak private resources |
| 409 | IDEMPOTENCY_CONFLICT / REQUEST_IN_PROGRESS / DEPLOYMENT_MISMATCH / TX_PENDING | check the original intent, poll if needed |
| 409 | MARKET_CLOSED / TRADING_PAUSED / QUOTE_EXPIRED / QUOTE_CANCELLED / QUOTE_CONSUMED | stop or explicitly request a new quote, do not blindly retry the fill |
| 409 | DUPLICATE_CANDIDATE / FORECAST_WINDOW_CLOSED / FORECAST_ALREADY_SUBMITTED | keep the original submission, do not bypass with a new key |
| 409 | BUDGET_EXHAUSTED / PRICE_LIMIT_EXCEEDED / INSUFFICIENT_MAKER_BALANCE / NO_QUOTE / STALE_FORECAST | wait for the condition to change, then create a new request |
| 429 | RATE_LIMITED | obey Retry-After |
| 503 | INDEXER_LAG / CHAIN_UNAVAILABLE / SERVICE_NOT_READY | reads can be retried; for writes, check the intent first |
| 500 | INTERNAL_ERROR | trace by requestId; do not infer that the transaction failed |

Initial rate limits follow the spec: reads 60/IP/min; RFQ 2/key/sec with burst 5, and at most 5 unexpired quotes per taker. A quote that is not yet expired but whose signing state is unknown also counts toward the quota. Before scaling out horizontally, counting/locking against the same DB is required. Each pod must not grant its own separate quota.

## Spec v0.1.1 design

It keeps the v0.1 fields and adds a fixed resolutionPolicy:
- hardDeadlineOutcome="INVALID".
- unfinalizedProposalAtHardDeadline="INVALID".
- invalidPayoutRule="HALF_PER_SIDE_NOT_PURCHASE_REFUND".
- authorityModel="TEAM_OPERATED_WHITELISTED_ROLES".

The version string changes to blink.market.v0.1.1. The existing v0.1 fixture is kept, and its hash must not be changed and then called the same document. At approval, the deterministic serializer runs only once and persists those UTF-8 bytes, the keccak256, the length and the schemaVersion. Later steps only read the original file. There is no real deployment, so M0 can switch new market creation directly to v0.1.1 and keep the legacy reader/schema tests.
