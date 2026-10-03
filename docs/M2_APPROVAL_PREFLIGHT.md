# M2.2b — Approval preflight foundation

**Update:** The transactional approval and unsigned creation-intent integration is now implemented in opt-in approval mode; see [current delivery](M2_APPROVAL_DELIVERY.md). The text below describes the original preflight boundary and the internal helper, which still does not approve by itself.

This is an internal, locally tested prerequisite for approval, **not an enabled approval endpoint**. The previous identity/evidence/candidate slice was pushed as `a878b5d`. No deployment, approval record, capacity reservation, creation intent or outbox event is produced by this preflight.

中文摘要：這一步完成核准政策與規格封存的前置銜接，不代表人工核准或建市已可使用。核准 API 仍回 501。

## Implemented rules

`validateReplayApproval` lives in the domain package and accepts a candidate, approval request, trusted evidence snapshot and database-derived time. It has no database, network, signing or storage side effects.

- Require the exact expected revision and a DRAFT or VALIDATING candidate. Rejected candidates must first be revised.
- Accept REPLAY only. LIVE is rejected explicitly until official entity/source policies are configured.
- Require a future close time and the existing v0.1.1 resolution-policy/time-order constraints.
- Match template, company, fiscal period and threshold exactly against the candidate.
- Require the candidate, spec and loaded evidence to contain the same unique evidence IDs.
- Require enabled, company-matching HTTPS sources with no credentials or fragments.
- Permit PUBLIC or reviewed EXCERPT evidence, not PRIVATE citations in a specification intended for public release.
- Require the spec source allowlist to match the exact set of referenced reviewed source URLs; no extra or duplicated URLs.
- Limit per-question research allocation to 1–2,000,000 USD micros (up to USD 2). This is not a daily budget reservation or a model-spending authorization.
- Produce an unambiguous canonical key and a separate company/period capacity key. Threshold and deployment changes do not bypass the latter.

`prepareReplayApproval` applies that policy before calling the existing immutable spec archive. It returns exact stored bytes, hash and URI with `PREPARED_NOT_APPROVED`. Invalid input never reaches archive storage. A valid archived object is not proof of authorization or approval; it may remain unreferenced if later transactional validation fails.

## Required next transaction

The future HTTP handler must authenticate an admin key and claim persistent idempotency before admitting new work. For a new request it must load a trusted snapshot, perform archive IO outside a long-running SQL transaction, then lock/reload and revalidate the candidate, evidence/source policy, DB clock, verified deployment and capacity. Only then may it atomically write approval, spec reference, company-period slot, creation intent, audit and outbox, plus the idempotent response. No input-provided `verified` boolean is sufficient.

Cached completed responses must be returned only after current authentication and payload matching; they must not require the old close time still to be in the future. Failed/repeated approvals must not allocate duplicate slots or emit duplicate outbox events. Source disable, revision changes, expiration and deployment invalidation during archive IO must prevent commit. Signing and transaction submission remain separate, human-controlled operations.

## Verification

`pnpm check` passes with 28 Node tests, type checks, package-boundary checks and Solidity compilation. New tests cover 23 rejection cases, capacity-key behavior across thresholds/deployments, exact-byte filesystem archive round trips, repeatable hashes and no archive write for rejected input. These tests do not claim approval-transaction or real PostgreSQL concurrency coverage; those parts are not yet implemented.
