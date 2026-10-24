# v0.1 Detailed Design

_Status: historical — v0.1 team-operated design baseline (2026-09-22), largely retired by the autonomous-market redesign of 2026-10-23 (§6). Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

Progress update (Tasks 1–16): A/M0, B/M1 and the backend slices for public reads, indexer, signer, RFQ, research and operations are implemented but not deployed. See [Documentation delivery and status index](../ROADMAP.md), [RFQ](../M2_RFQ.md) and [Research workers](../M3_RESEARCH_WORKERS.md). Local REPLAY only, no paid models; LIVE approval is still rejected. The [internal trader](../M3_INTERNAL_TRADER.md), [SDK / example agent](../M5_CLIENT_SDK.md), [local Alpha harness](../M5_LOCAL_ALPHA.md) and [health/metrics readiness](../M5_HEALTH_METRICS.md) are delivered. For the acceptance scope and remaining limits, see the [matrix](../ACCEPTANCE_MATRIX.md). This does not mean the public Alpha is complete.

Status: design baseline, 2026-09-22. It breaks down the first-version product spec and the existing architecture, and can serve as the basis for later implementation and code review. **The text below is the design baseline. The implemented scope and any differences are defined by the delivery records and the code. It does not mean anything is deployed or that all work packages are complete.**

The scope of this round is the complete design of M0/M1, plus the key integration contracts of M2/M3. Frontend visuals, actual companies, model providers, hosting, RPC and official role addresses are not invented here.

## Reading order

| Document | What to confirm |
| --- | --- |
| [01 Contracts and ledger](01-contracts.md) | constructor, storage, permissions, math, state machine, revert, acceptance |
| [02 API and data contracts](02-api-contracts.md) | identity, IDs, types, idempotency, main request/response, errors |
| [03 Data and transactions](03-data-transactions.md) | migration batches, key columns, unique constraints, lock order, append-only |
| [04 RFQ / Signer / Indexer](04-execution-recovery.md) | quote, signature, resend, reservation, reorg and recovery |
| [05 Research and operations](05-research-operations.md) | evidence, candidates, forecast, budget, keeper, faucet |
| [06 Implementation work packages](06-work-packages.md) | development order, dependencies, acceptance cases, differences from the existing skeleton |

## Decisions made in this round

1. An on-chain market is always located by **deploymentId + marketId**. marketId is the contract uint256 as a decimal string. The DB has a separate internal UUID, which is not mixed into the public marketId. A list may span deployments. A single-market API must name the deploymentId explicitly.
2. The five business roles of the contract are distinct addresses fixed in the constructor. There is no grant/revoke/renounce role and no upgrade path. The external taker allowlist is a separate, adjustable data set.
3. The contract market lifecycle, the transaction receipt state, the quote state and the fund reservation state are kept separate. They do not share one status enum.
4. The original spec bytes are stored once. To meet §6 of the original spec, fixed text and machine-readable rules for a hard-deadline fail-safe are added under a new schema version. The v0.1 bytes are not changed silently.
5. RFQ obtains a restricted signature synchronously. A DB reservation exists before signing. The response is returned only after the signed artifact is persisted. On timeout, reconcile first and do not sign another quote.
6. A job can be rerun, but that does not mean the economic intent can be redone. Intent, sign request, nonce allocation and tx attempts are modeled separately.
7. Model cost, maker collateral, trader notional and gas each have their own ledger. USD micros are never added to bUSD micros.
8. The health check for new quotes is separate from on-chain rescue operations. Stopping quotes still allows reconciliation, result submission, finalize and redeem.

For the design corrections and their reasons, see [ADR 0002](../adr/0002-protocol-boundaries.md). The first-version product spec stays in its original file and is not rewritten in this round. The above is engineering refinement. It does not extend to mainnet, multiple makers, early exit or automatic arbitration.

## Code state when the design was proposed (historical)

When the design was proposed on 2026-09-22 there was only a skeleton, and the API returned 501. This is historical background: deploymentId, spec v0.1.1, persistent signer intent, public reads and the trading modes are now implemented. Modes that are not enabled still fail closed. `tradingEnabled` is controlled by the manifest, deployment, indexer and collateral pool gates. There is no public API host and no trading on the website. Do not treat the design tables as complete go-live acceptance.
