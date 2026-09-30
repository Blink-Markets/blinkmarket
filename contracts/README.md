# Blink 合約 — M1

已實作非升級 BlinkTestUSD 與 BlinkMarket：固定角色、maker free collateral、完整抵押成交、EIP-712、取消/epoch、內部持倉、提案/挑戰/仲裁/逾時/贖回。鏈 ID 固定 84532；本機測試也使用此 ID。

固定工具：Solidity 0.8.30、OpenZeppelin 5.6.1、Foundry 1.7.1、EVM Cancun、optimizer 200、viaIR。Foundry 經 npm 鎖版，無需全域安裝；第一次 native 編譯需下載固定 solc。

在 repo root 執行：

```sh
pnpm check:contracts
pnpm test:contracts
pnpm test:contracts:seeds
pnpm replay
```

- check:contracts 編譯完整合約，產生 contracts/artifacts/{BlinkMarket,BlinkTestUSD}.json，含 ABI、ABI hash、creation bytecode/hash。Artifacts 可重新產生，不入版控。
- test:contracts 執行行為、fuzz、惡意 token 與 ghost ledger invariants。
- test:contracts:seeds 使用固定 0x01/0x02，每個 128 runs × 64 operations；每個 run 結束強制結算贖回檢查無殘餘 escrow。
- replay 啟動自己的 loopback Anvil，使用公開測試助記詞，驗證三個 REPLAY；結束自動停止，不接受外部 RPC URL。輸出本機 report 與 spec 精確 bytes。

請透過 package scripts 或 scripts/foundry.mjs 執行，避免 npm 原 wrapper 未傳遞 child failure exit code。CI 已使用修正的 runner。

constructor 檢查 collateral code/decimals，正式部署還必須以 manifest、ABI/runtime bytecode hash 與鏈上 getters 核對是正確 BlinkTestUSD，不能只用6位小數辨識資產。Getter 的 proposedOutcome / finalOutcome 必須搭配 state 判斷是否存在，不把 enum 預設值當已公布答案。

沒有 Sepolia 部署、真實資產或外部安全審計。測試矩陣與限制見 [M0/M1 交付記錄](../docs/M0_M1_DELIVERY.md)。
