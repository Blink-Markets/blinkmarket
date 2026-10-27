# Architecture baseline verification

> This is a historical record of the 2026-09-22 architecture skeleton. The current verification commands and their measured results are in [Development](DEVELOPMENT.md) and [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md#verification).

This document keeps the historical results of the initial architecture skeleton. For the initial delivery, see the [M0/M1 delivery record](M0_M1_DELIVERY.md). For later integration and acceptance evidence, see [Local Alpha](M5_LOCAL_ALPHA.md) and the [acceptance matrix](ACCEPTANCE_MATRIX.md).

Date: 2026-09-22; local Node.js 22.23.1 / pnpm 11.20.0.

| Check | Result |
| --- | --- |
| pnpm install --frozen-lockfile | Passed; esbuild is the only dependency allowed to run install scripts |
| pnpm check | Passed: TypeScript, 3 contract/skeleton tests, dependency direction, Solidity interface compilation |
| pnpm build | Passed: Next.js production build |
| docker compose -f infra/compose.yaml config --quiet | Passed; validates the Compose configuration only |
| pnpm dev + local HTTP smoke | All five processes started successfully; stopped after the check |
| Web /, API /v1/config | 200, stage=architecture, tradingEnabled=false |
| API /health/ready | 503; does not falsely report business readiness |
| Worker / Indexer / Signer /health/live | 200 |
| POST /v1/rfqs | 501 NOT_IMPLEMENTED, with no trading side effects |

The three tests cover: trading disabled and readiness, the integer wire schema and the LIVE challenge time, and the order of the EIP-712 and Solidity Quote types.

This historical check did not verify: a running PostgreSQL / migrations, object storage, RPC, the Foundry ledger/invariants, on-chain deployment, authentication, concurrent funds and budget, models, or UI. None of these were implemented at that time. Local backend / contract / database integration has since been delivered, but public deployment, paid models and the operator UI are still not done. Do not treat this historical record as all of spec §17 having passed acceptance.

Binding local services and downloading dependencies require an environment that allows loopback/network. The tests use node --import tsx so that the tsx CLI does not create an extra IPC socket. No on-chain transaction or model request was sent.
