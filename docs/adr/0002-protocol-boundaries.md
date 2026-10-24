# ADR 0002 — Fixed deployment identity, roles and recovery boundaries

Status: adopted. Original decision date: 2026-09-22; work packages A/B/C were still to be implemented at that time. For the later scope see the [architecture](../ARCHITECTURE.md) and the [acceptance matrix](../ACCEPTANCE_MATRIX.md); this does not mean anything is deployed.

_Status: partially superseded — sections 2 (fixed roles), 4 (restricted signer) and 6 (manual ADMIN pause) are replaced by sections 5.9, 5.10 and 6 of the 2026-10-23 spec (no admin, no pause, no platform signer, immutable roles removed); the last sentence of section 7 (EOA-only wallet verification) is replaced by the wallet-neutral ERC-1271 change (6140708). Sections 1, 3 and 5 still stand (spec section 7 keeps the spec bytes/hash rules and the chain indexer's reorg handling). Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

## 1. Market ID

The previous round's DATA_MODEL made the API path ID an opaque UUID, while the original spec's RFQ and the contracts use a decimal marketId, which makes it easy for a client to put the wrong ID straight into calldata.

Markets are located externally by deploymentId + decimal chain marketId; the DB UUID is renamed marketRecordId. Single-market queries and cross-deployment commands carry deploymentId explicitly; they must not default to the active deployment. This is a design correction to an unpublished skeleton, and no API client needs a migration yet.

## 2. Fixed roles

The original spec states explicitly that roles cannot be rotated. The five on-chain business roles use constructor-immutable addresses, with no grant/revoke/renounceRole. The taker allowlist can be updated by ADMIN, but that is not role management. The token faucet minter is also fixed; changing a role requires a new deployment.

Standard libraries such as ECDSA and SafeERC20 are still used; a full role framework with dynamic management entry points is not introduced just to check fixed addresses. The existing interfaces have no role-management functions, so no published capability is removed.

## 3. Exact spec bytes and the supplementary field

Section 6 of the original spec requires that, if hardDeadline passes without finalization, INVALID is written into the MarketSpec, but the JSON template in section 5.2 has no explicit field for it. v0.1.1 adds a fixed resolutionPolicy that fully commits this existing rule. The original bytes/hash of the old v0.1 are not overwritten; the serializer is used only the first time a new file is produced.

This is a document-schema revision that implements existing semantics; it does not change payout, permissions or deadlines. The new schema is implemented in `packages/schemas/src/core.ts`; for delivery and verification see [M0/M1](../M0_M1_DELIVERY.md). The original "waiting for A2" status applies only to the time of the decision.

## 4. Signer uniqueness

An HTTP timeout or a DB lease does not mean signing did not happen; the sign request, artifact, economic intent and transaction nonce each have their own id and uniqueness constraint. The signer does not accept arbitrary calldata; each time it reloads the trusted intent/policy and encodes it itself. Broadcasting uses only persisted artifacts.

The M0 RestrictedSigner port is a conceptual draft, and A4 must replace it with this protocol; no vague room is kept in which a caller could supply its own authorization payload.

## 5. Chain observations can be withdrawn

v0.1 can use the latest canonical INCLUDED response transactions and provisional accounting, with the block hash and confirmation level attached. After a reorg, quoting must stop first; reopen it only after the affected quotes/reservations/projections are recovered. Mark FINALIZED only when the provider actually supplies finalized evidence.

The quoting-stop threshold follows the original spec: more than 3 blocks or more than 10 seconds without an update, either one. Readiness separates the new-transaction gate from rescue capability; stopping quotes must not stop the keeper from finalizing.

## 6. Limits of manual pause

The previous round's manual ADMIN wallet design is kept: when an announcement comes early, off-chain quoting stops immediately and ADMIN is notified to issue the on-chain pause. This cannot guarantee that an already signed quote is stopped from filling at the same instant; v0.1 states this delay explicitly.

To make up for this delay, no second ADMIN, no automatic unrestricted admin key and no change to the contract roles is added in secret. If an automatic on-chain pause is needed in the future, a separate permission design decision is required.

## 7. Initial operating parameters

An API body of 64 KiB, an EOA wallet binding challenge of 5 minutes, probability with 6 decimal places, a REPLAY challenge of 120 seconds, a job lease of 60 seconds / heartbeat of 20 seconds, and similar values are detailed engineering initial values, not new product guarantees. Record the policy version at deployment; hard on-chain parameters and the original spec cannot be bypassed through environment variables.

Wallet verification for external smart accounts is not designed yet; the v0.1 client path is completed with EOAs first, and the public onboarding documentation must state this limit.
