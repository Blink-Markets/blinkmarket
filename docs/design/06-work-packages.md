# 06 — Development Work Packages and Design Checks

_Status: historical — v0.1 team-operated design baseline (2026-09-22), largely retired by the autonomous-market redesign of 2026-10-23 (§6). Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

Progress update (Tasks 1–16): A/M0, B/M1 and several backend slices of C/D are implemented but not deployed. See the [delivery index](../ROADMAP.md). Local verification is REPLAY only, with no paid models, and LIVE approval is still rejected.

This document keeps the original work breakdown and the design check cases. It is not an item-by-item acceptance record. C already has identity, candidate / approval, public reads, indexer and RFQ/signer. D already has research, budget, evaluation, resolution and keeper/faucet. The [internal trader](../M3_INTERNAL_TRADER.md), [SDK / example agent](../M5_CLIENT_SDK.md), [local Alpha harness](../M5_LOCAL_ALPHA.md) and [health/metrics readiness](../M5_HEALTH_METRICS.md) are delivered. For the acceptance mapping see the [matrix](../ACCEPTANCE_MATRIX.md). Public deployment, the operations UI, paid models and external acceptance are still not done, so all of C/D is not marked complete.

## A: M0 contract wrap-up

| ID | Where to change | Delivery / acceptance | Depends on |
| --- | --- | --- | --- |
| A1 | packages/schemas | separate PublicMarketRef/DB ID; deploymentId required; all chain integers are strings | none |
| A2 | schemas + spec archive port | v0.1.1 resolutionPolicy, serialize once / store original bytes / hash, keep the v0.1 reader | A1 |
| A3 | deployment schema + local script | a real manifest validates chain 84532 / roles / addresses / hashes, a TEMPLATE cannot be loaded for trading | A1 |
| A4 | domain/ports | separate intent, nonce, quote, reservation, sign request/result and role scopes | A1 |
| A5 | adapters/migrations | migration runner, 0001, role / append-only / domain constraint tests | A1 |
| A6 | OpenAPI schemas/client | complete error / ID / numeric contracts and a generation mechanism; APIs in the design are marked planned first | A1/A2 |

A acceptance: one extra space in the bytes gives a different hash. Re-serialization is not a download. A wrong deployment / mainnet / placeholder is rejected. Numbers do not pass through float. The new schema and the old fixture can be told apart explicitly. Passing M0 does not mean it is tradable.

## B: M1 contracts

| ID | Content | Acceptance |
| --- | --- | --- |
| B1 | TestUSD, immutable roles, constructor, anti role rotation | C14; zero / duplicate addresses, wrong chain / asset |
| B2 | market creation, caps, pause, maker deposit/withdraw | C06/C13/C14; cannot take escrow/donation |
| B3 | EIP-712, digest, fill/cancel/epoch and the internal ledger | C01–C09; exact vectors, full rollback on failure |
| B4 | propose/challenge/arbitrate/finalize/timeout/redeem | C10–C13; every time boundary |
| B5 | Foundry handler/fuzz/invariant, reference ledger | C15 + token/reentry/overflow; reproducible across multiple seeds |
| B6 | ABI/hash generation, local REPLAY three scenarios | normal/dispute/timeout can all fill and both sides redeem |

B does not deploy to Sepolia, and a demo script does not replace invariant acceptance.

## C: M2 vertical trading flow

In the order identity/evidence/spec → manual approval intent → chain index/reorg → reservation/RFQ/signer → client transaction tracking. Fix the fixtures first, with no dependency on an LLM for now. Cover S01/S02/S05/S07/S08/S09/S10/S11/S12 one by one.

Before the signer is wired, it must pass caller isolation, rejection of a wrong role/chain/to/selector/gas/amount, and the same sign request returning the same artifact. Whenever the DB/RPC/signer is not ready, keep quotes stopped. A fake success adapter must not be used to get around it.

## D: M3 research and operations

First the source allowlist/snapshot, then budget/model gateway, discovery/forecast/baseline, resolution/keeper/faucet and metrics. After the provider / rates are chosen, lock the model/prompt/tool versions. Complete S03/S04/S06 and the deadline / contamination / missing-data checks.

## Differences from the original skeleton (historical)

The "next step" entries below describe the to-do at the time the design was proposed. They must not be read as current gaps. deploymentId, the v0.1.1 spec, the contract result fields, the persistent signer, the chain snapshot, the transaction handle, the jobs lease and OpenAPI are implemented. The scope that is actually still not complete is in the progress above and in the delivery records.

| Existing file / behavior | Next change |
| --- | --- |
| schemas MarketSpec has only v0.1 and lacks the hardDeadline fail-safe fields | A2 adds v0.1.1, and the original fixture is not turned into a fake LIVE |
| MarketRef.marketId does not distinguish the DB ID | A1 unifies on the chain decimal ID; the DB uses marketRecordId |
| IBlinkMarket.Market has only a single outcome | B4 splits the proposal and the final outcome, aligning with the API before updating the ABI |
| RestrictedSigner takes a quote/intent and returns an artifactId with no state | A4 changes it to a persistent signRequest protocol, modeling UNKNOWN explicitly |
| ChainReader reads only balance/consumed | A4 adds hash-located snapshots, epoch/cancelled/market/manifest verification |
| TransactionContext has only a transactionId | A5 uses an adapter-private transaction handle; a string cannot be claimed to guarantee the same transaction |
| Job has only attempt/nextRunAt | A4/A5 add lease owner/token/state and the ACK condition |
| OpenAPI lists only 501 | the A6/C stage adds complete schemas/security/responses, and 501 is kept until implementation |
| no role / environment configuration implementation | B1/A3 fix the constructor/manifest first; C verifies isolation before secrets are given |

## Design-level check cases

1. Two deployments with the same marketId of 1: queries and RFQ must obtain their own spec/domain, with no fallback.
2. approve returns 202 and the chain transaction is lost: keep the same creation intent; do not produce a second market.
3. Two quotes compete for the last collateral: the same pool lock limits the reservation, and the contract still checks the actual free.
4. A quote is signed but the API times out: resending with the same key gets the same artifact; no quote is added.
5. A quote expires but the RPC is down: the UI shows expired, and the reservation stays HELD.
6. A reorg after an observed fill: withdraw the projection and the ACCOUNTED marker; recompute free/reservations before opening the gate.
7. A job lease expires but the old worker continues: fencing blocks the ACK / new side effects, and the intent prevents duplication.
8. A model was called but usage is unknown, at midnight: the old day's reservation stays, and the new day does not remove the question's occupation.
9. Nobody finalizes: from the hardDeadline anyone can set INVALID and redeem, and neither pause nor allowlist revocation affects it.
10. An early announcement but the ADMIN is offline: stop new quotes immediately, disclose the on-chain pause delay, and the original signed quotes are handled by chain order and the original rules.
11. The same wallet tries to claim the faucet again with a different API key: the address guard and the pending reservation still reject it.
12. An incomplete two-model ensemble: mark it missing, and do not quietly fill in with the baseline or an external model.

These are design acceptance cases and not test results claimed by this document. The commands, results and limits of the implemented slices are recorded in each delivery document. The local integration already has the [Alpha harness](../M5_LOCAL_ALPHA.md). For the remaining gaps and public acceptance, see the [acceptance matrix](../ACCEPTANCE_MATRIX.md).
