# M2.2 — Human approval and unsigned market creation

Implemented locally, **REPLAY-only and opt-in**. An invited admin can approve a candidate and obtain one durable, unsigned `createMarket` transaction intent. This is not an on-chain deployment or a trading launch. No private key, automatic signer, broadcaster or market-created receipt is involved.

中文摘要：人工核准已接上資料庫交易及未簽署建市資料；由管理員錢包自行檢查並送出。API 不會假造 marketId 或交易成功，也不會自動簽署。

## Flow

```mermaid
sequenceDiagram
  participant O as Deployment operator
  participant R as Registration CLI / RPC
  participant A as Human admin / API
  participant D as PostgreSQL
  participant S as Immutable archive
  O->>R: Manifest + expected deployment ID + reason
  R->>R: Verify chain, bytecode, roles, caps and block stability
  R->>D: Registry + timestamped verification + audit
  A->>D: Authenticate admin, check cached request and load policy snapshot
  A->>S: Verify evidence originals; freeze exact spec bytes
  A->>D: Authenticate again; claim idempotency; lock candidate and sources
  A->>D: Recheck deployment, revision, clock and company/period capacity
  A->>D: Atomic approval + spec reference + slot + intent + audit + outbox
  D-->>A: 202 DEPLOY_PENDING, approvalId, specHash, creationIntentId
  Note over A: Read unsigned calldata; inspect target, sender, chain and public spec
  Note over A: Admin wallet signs/broadcasts separately; indexer integration is still pending
```

The deployment registry holds verified manifests, not input-supplied `verified` flags. Registration invokes the existing verifier against an operator-configured RPC and locally supplied ABI artifacts. A deployment ID cannot be reassigned to a different manifest, and a market contract cannot be registered under multiple IDs. Re-registering the identical enabled deployment adds a new verification record.

For a **new approval**, verification must be no older than ten minutes, the registry entry must be enabled and the manifest must keep trading disabled. Verification is a point-in-time RPC observation, not a promise against later reorganizations; recheck before submitting from a wallet. LIVE approval remains explicitly rejected.

## Transaction guarantees

- Admin scope is checked before archive access and again in the final transaction, including after lock waits. Revoked/expired keys cannot replay completed responses.
- Exact completed idempotent responses are returned before revalidating old market deadlines. A changed payload with the same key returns a conflict. Concurrent preflights may archive the same bytes; they cannot commit duplicate intents.
- Archive IO happens outside the SQL transaction. The final transaction reloads and validates candidate revision, enabled source policies, verified deployment and database time. Edits, source disable, deployment disable or key revocation during IO prevent commit.
- Candidate/spec fields, exact evidence IDs, reviewed source URLs, public/excerpt access and USD 2 per-question research allocation follow the [approval policy](M2_APPROVAL_PREFLIGHT.md).
- Original evidence bytes are read and hash-checked before spec freezing. Losing/corrupting an archive blocks approval. This does not replace archive backup or retention controls.
- A unique company/period slot excludes both threshold changes and deployment changes. Slots and intent references are committed together; a conflict rolls back the entire attempt.
- Approval references the reviewed revision. The candidate receives a new immutable `DEPLOY_PENDING` revision and can no longer be edited/rejected through the preparation service.
- Approval, spec reference, slot, creation intent, audit, `market.creation_requested` outbox event and success idempotency record commit together. Unexpected errors roll back everything; failed attempts may be retried.
- The outbox event is a durable notification, **not authorization to auto-sign**. No current worker dispatches these events.

## API

| Endpoint | Access / result |
| --- | --- |
| `POST /v1/admin/candidates/:id/approve` | Admin + Idempotency-Key; expectedRevision, deploymentId, spec, budgetMicros, reason; 202 intent references |
| `GET /v1/admin/creation-intents/:id` | Admin only; chain 84532, target contract, required admin sender, zero native value, calldata, public spec URI and hash |
| `GET /v1/specs/:specHash` | Public, committed specs only; exact original JSON bytes, never JSON reserialization |

Creation intent state is `AWAITING_ADMIN_SIGNATURE`; candidate state is `DEPLOY_PENDING`. Neither means a market exists on-chain. The unsigned calldata uses REPLAY mode, the reviewed deadlines/challenge duration and current protocol maximum caps (10,000 pairs / 500 taker shares). It is not a signature and includes no nonce or fabricated transaction hash. Client helpers are `approveCandidate` and `getCreationIntent`.

The on-chain `specURI` is the configured public API URL, not a filesystem path or `local-object:` URI. Preserve that hostname and route for the lifetime of the market. A wallet/operator should fetch it, hash the raw bytes, inspect all fields and independently verify chain/target/admin/deadlines before signing. Fetching an intent does not revalidate its execution readiness; an expired intent must not be submitted.

## Configuration / manual operations

1. Apply migrations with the migration account; `0004_approval.sql` adds the registry/approval/intent tables and `blink_deployment_admin` group. Runtime startup does not run DDL.
2. Give the registration CLI a separate login in `blink_deployment_admin`. Never inject this credential into the API; API startup rejects membership in privileged admin groups and schema-create permissions.
3. Verify/register an actual deployment using `DEPLOYMENT_ADMIN_DATABASE_URL`, `BASE_SEPOLIA_RPC_URL` and locally reviewed artifacts:

   ```sh
   pnpm deployment:register ./manifest.json deployment-id 'Reviewed deployment for REPLAY approval'
   ```

   `CONTRACT_ARTIFACT_DIRECTORY` defaults to `contracts/artifacts`. This command **does not deploy contracts**. The repository contains no registered real deployment. Refresh verification with the same command when needed; disabling registry entries is an operator action using the deployment-admin role.

4. For the API, set `BLINK_API_MODE=approval`, normal identity settings, `SPEC_PUBLIC_ORIGIN`, `SPEC_OBJECT_DIRECTORY`, and `EVIDENCE_OBJECT_DIRECTORY`. The spec origin must be canonical HTTPS (loopback HTTP for local tests). Mount evidence originals read-only; mount the spec archive persistently with write permissions for the runtime user. No privileged database credentials or wallet private keys belong in this process.
5. Submit the admin approval request, then inspect its unsigned intent and public spec. Wallet signing/broadcast is a separate human action, not an API call implemented here.

Scaffold remains the default. Identity/preparation modes are unchanged. `tradingEnabled=false`, deployment in `/v1/config` remains null and overall readiness remains 503 because the indexer/trading path is incomplete. The runtime Docker image requires externally configured persistent mounts; it does not include archive contents.

## Verification and limits

CI follow-up (2026-10-03): [run 37099505426](https://github.com/Blink-Markets/blinkmarket/actions/runs/37099505426) passed the real PostgreSQL suite, contract tests, extra invariant seeds and replay. It failed later at the Web build because a TS-source package referenced `approval.js`. Shared source imports were corrected to actual `.ts` files, with a boundary-check guard and local Web-build verification added. Local Docker remains unavailable; the remote PostgreSQL result supersedes the earlier unverified-remote status below.

Verified locally on 2026-10-03: `pnpm check` passed (33 Node tests, TypeScript, module boundaries and Solidity compilation); 24 Foundry tests passed; service bundles and both isolated-bundle tests passed; OpenAPI generation and `git diff --check` passed.

Local tests cover atomic success, exact-byte public retrieval, ABI calldata decoding, admin-only access, duplicate requests, conflicting thresholds/candidates, runtime registration denial, missing verification, corrupt evidence, source/revision/deployment/key changes during archive IO, and audit-failure rollback. Existing multi-user and contract tests remain regression coverage.

The dedicated PostgreSQL suite also exercises four approvals competing on independent pooled connections, expecting one intent/slot/outbox event. Docker was checked on 2026-10-03 and its daemon was unavailable, so this suite and Docker image execution have **not been verified locally**. PGlite's serialized single-session tests are not a substitute for that concurrency check.

Remaining work: canonical `MarketCreated` receipt reconciliation, chain-assigned market IDs, confirmations/reorg handling, intent failure/cancellation and audited slot release, admin wallet UI, RFQ reservations and signer integration. Pending slots are deliberately not auto-expired or released: a delayed transaction could still be mined. For now a pending intent retains its slot; do not bypass this by manually deleting rows. No LIVE market, funded account, remote transaction or paid model was used during implementation.
