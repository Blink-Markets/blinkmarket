# Blink 合約

repo 同時保留兩套不可升級合約；鏈 ID 固定 84532，本機測試也使用此 ID。

- **v0.1：** `src/BlinkMarket.sol` 與 `src/BlinkTestUSD.sol`。固定角色、maker free collateral、完整抵押成交、EIP-712、取消／epoch、內部持倉、提案／挑戰／仲裁／逾時／贖回。鏈下服務目前仍接這套 ABI；歷史 `alpha-2` 部署不代表 P1 已部署。見 [M0/M1 交付記錄](../docs/M0_M1_DELIVERY.md)。
- **P1：** `src/protocol/`。註冊身份、自助角色押金、多 maker RFQ、信用、建市挑戰、快照 commit/reveal 仲裁、加倍押金上訴、手續費分配、七日 Juror 報酬串流、faucet 與下一世代治理。四合約以預測地址依序部署，彼此地址固定於 constructor。沒有 owner、admin、pause、初始化或升級入口；治理只能採用下一世代。完整交付、參數與已知限制見 [P1 交付記錄](../docs/P1_PROTOCOL_CONTRACTS.md)。P1 尚未部署；P2 才接部署工具與鏈下服務。

固定工具：Solidity 0.8.30、OpenZeppelin 5.6.1、Foundry 1.7.1、EVM Cancun、optimizer 200、viaIR。Foundry 經 npm 鎖版，無需全域安裝；第一次 native 編譯需下載固定 solc。

在 repo root 執行：

```sh
pnpm check:contracts
pnpm test:contracts
pnpm test:contracts:seeds
node --import tsx --test tests/protocol-artifacts.test.ts
pnpm check:boundaries
```

`check:contracts` 編譯兩套合約，在 `contracts/artifacts/` 產生 ABI、ABI hash、creation bytecode/hash，並檢查 runtime 不超過 EIP-170 的 24,576 bytes。產物不入版控。ABI 測試掃描所有具體 P1 合約（Governor 另以 proposal 限制測試）；只豁免 markets 的 `setProposed`、`setDisputed` 結算 hooks。

`test:contracts` 包含 v0.1、P1 單元／fuzz、真實世代 lifecycle、惡意 collateral 與獨立 ghost ledger invariants。`test:contracts:seeds` 對 `LedgerInvariantTest` 與 `ProtocolInvariantTest` 各跑 0x01／0x02，每個 invariant 為 128 runs × 64 operations；每輪強制完成剩餘市場、分潤、贖回與 vote unlock，檢查 escrow 歸零與償付能力。

請透過 package scripts 或 `scripts/foundry.mjs` 執行，避免 npm 原 wrapper 未傳遞 child failure exit code。CI 已使用修正的 runner。v0.1 的 `pnpm replay` 仍可啟動自己的 loopback Anvil，執行三種歷史 REPLAY；它不是 P1 的自治 agent 演練。

P1 的 `getDispute` 回傳目前回合；commitment 與 `settleVote(disputeId, round, juror)` 使用 `currentRound`（每次重開與上訴都遞增），`appealRound` 才是 quorum／信用參數索引。先結算同一 appeal level 的所有 loser，再領 coherent juror 的 token reward；最後回合信用需等 `finalizeDispute`。逾時後尚未結算的 vote 只解鎖。bUSD reward 需經七日串流，不能在 notify 當下領完。

正式部署必須核對 manifest、ABI/runtime bytecode hash、地址 getters 與 collateral；不能只靠 6 位小數辨識資產。`proposedOutcome`／`finalOutcome` 必須搭配 state 判斷是否存在。測試參數不代表正式經濟參數，固定價格與 faucet 資產沒有真實價值，也尚未經外部安全審計。
