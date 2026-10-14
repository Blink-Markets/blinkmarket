# M3 resolution reports and human role drafts

中文摘要：新增結算報告與管理員分流、毛利率解析建議、期限提醒及唯讀未簽署角色交易草稿。

This delivery completes Task 11's backend slice. It does not complete M3 as a whole or add the deferred admin web UI.

## Delivered scope

- Migration `0014_resolution.sql` creates immutable reports, report events, parser suggestions and deadline deduplication keys. API and worker grants are separate. A monotonic event sequence provides deterministic latest-state ordering even when timestamps tie.
- `POST /v1/markets/:id/resolution-reports?deploymentId=...` requires `report:write`, a visible evidence set and an indexed market. It atomically saves the report, RECEIVED event, audit and idempotent 202 response. It does not change chain state.
- `GET /v1/admin/resolution-reports?deploymentId=...` requires `admin`; optional `marketId` and `state` filters, `limit` and UUID `cursor` provide pagination. `POST /v1/admin/resolution-reports/:id/triage` requires `admin`, an Idempotency-Key and `{state, reason}`. TRIAGED, DISMISSED and ACTIONED append events; existing reports and events are never updated.
- The deterministic `parseGrossMargin` recognizes GAAP gross margin percentages within 80 characters, including `percent` and Unicode `％`, preserves a text locator and accepts signed values with at most two decimal places. Conflicting values, excess precision, missing values and non-GAAP-only text require manual review. Suggestions use strict `< thresholdBps`; equality suggests NO.
- `resolution.parse` scans every 60 seconds for approved indexed markets after close, joining the exact approved candidate revision and entity evidence observed after close. The approval policy already guarantees candidate/spec entity and threshold equality. Stored object bytes are hash-verified before parsing; unreadable objects are isolated per record (see limits). Suggestions are unique by market/evidence/parser version; ambiguous results get a deduplicated `resolution.manual_required` audit record. Neither path proposes a chain result.
- `resolution.alerts` scans projections every 60 seconds. It atomically inserts an `alerts_sent` key and `alert.deadline` outbox event for each reached, still-future challenge-end or hard-deadline threshold: LIVE 86400/3600/600 seconds; REPLAY 60/30/10 seconds. FINAL markets and challenge windows outside PROPOSED are excluded. New proposals are discovered from periodic projection reads, independent of `market.indexed`.
- `resolution:draft` validates the registered deployment manifest, refuses mainnet, and prints unsigned role-specific calldata. Propose/challenge/arbitrate select RESULT_PROPOSER/CHALLENGER/ARBITER addresses from the manifest. Timing and state warnings use DB time and indexed block time; absent, stale or gated cursors are flagged. A challenge encodes only the evidence hash because that contract function has no outcome argument; the output explicitly warns about this.

## Operation

Apply migrations with the existing migration tool. Enable the existing API markets mode and worker. Set worker `EVIDENCE_OBJECT_DIRECTORY` to the evidence object archive; no remote fetching occurs in resolution jobs. Missing archive configuration fails parsing when evidence is encountered rather than manufacturing a suggestion.

Use a read-capable database login (the existing `blink_api` group has the required SELECT grants):

```sh
RESOLUTION_DATABASE_URL='postgresql://…' pnpm resolution:draft \
  --deployment local --market 1 --action propose --outcome YES \
  --evidence-hash 0x1111111111111111111111111111111111111111111111111111111111111111
```

The CLI enforces read-only database transactions and prints `{chainId:84532,to,requiredSender,data,value:"0",warnings[]}`. It has no private-key, signer, RPC or broadcast path. The service build also emits `dist/tools/resolution-draft.mjs`.

## Verification

- RED evidence: parser/API modules initially absent; alert and parse handlers initially absent; draft module initially absent. A conflicting-values-in-one-phrase vector failed before the parser was extended. A binary (non-UTF-8) evidence record initially threw a `TypeError` that would have failed the whole parse scan; the evidence reader now returns no text so the parser reports `NONE` and an auditor reviews it.
- `pnpm check`: PASS (TypeScript, contract checks, 333 unit/integration tests, package boundaries).
- `pnpm build`: PASS.
- `pnpm build:services && pnpm test:service-build`: PASS (3 smoke tests; the bundle includes `resolution-draft`).
- `TEST_POSTGRES_ADMIN_URL=… pnpm test:postgres`: PASS (14 tests, including 3 new in `tests/postgres/resolution.test.ts`): migration 0014 and least-privilege `blink_api` reports/triage on real PostgreSQL, four concurrent workers emitting each deadline alert once, and four concurrent parse scans storing one suggestion and one manual-review audit (removing the advisory lock makes the last test fail).
- Anvil: not applicable (no chain transactions or Anvil tests in this slice).

## Remaining limits

The requested 60-second polling interval is coarse relative to REPLAY's 30/10-second thresholds. Reached thresholds are caught up once while their deadline remains future; a worker outage or a poll after expiry cannot deliver a timely reminder. Alerts are durable outbox events only; this slice does not add notification delivery. Reorgs may invalidate suggestions or deadlines already reviewed: drafts flag stale/gated projections, but a human must recheck current evidence and chain state before signing. The parser is intentionally conservative and does not establish fiscal-period or accounting-context correctness. Human review remains mandatory. A missing evidence object, a corrupt object or a stored-bytes hash mismatch never fails the scan or discards other records' suggestions: that record is skipped, never parsed, and gets one `resolution.evidence_unreadable` audit row per evidence/code/parser version for an operator to repair. Every scan retries the read, so a repaired object produces its suggestion on the next poll. Cancellation, a missing archive configuration and unexpected read or database errors still fail the job.
