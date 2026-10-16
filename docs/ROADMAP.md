# 實作進度

M0契約收尾與M1帳本已完成本機實作及驗證，詳見 [交付記錄](M0_M1_DELIVERY.md)。原始設計與工作分解在 [A–D工作包](design/06-work-packages.md)；剩餘 M2、M3 與 M5 工具的實作計畫見 [2026-10-14 計畫](superpowers/plans/2026-10-14-remaining-milestones.md)。README、網站與文件已於 2026-10-16 更新為 Task 1–16 的實作狀態；一切仍只在本機驗證，未部署。

| 階段             | 狀態                   | 成果或下一步                                                                                                                          |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| M0 工程與契約    | 已實作，本機驗證       | schemas、v0.1.1 spec bytes/hash、manifest、ports、DB foundation migration、OpenAPI/client、CI                                         |
| M1 帳本與結算    | 已實作，本機驗證       | TestUSD/Market、EIP-712、caps、完整結算與贖回、24 個合約 tests/invariant（三位 taker、兩市場）、三種 REPLAY                           |
| M2 核心垂直流程  | 進行中：核准、建市追蹤、共用基礎（[交付](M2_FOUNDATION_SEAMS.md)）、公開讀取與交易追蹤（[交付](M2_PUBLIC_READS.md)）、鏈上索引（[交付](M2_CHAIN_INDEXER.md)）、受限 signer（[交付](M2_SIGNER.md)）、RFQ 與抵押保留（[交付](M2_RFQ.md)） | 已有身份／證據／核准／建市輪詢、route service、`blink.now()`、公開讀取、獨立驗證的交易追蹤、可處理 reorg 的 chain indexer，以及只接受白名單呼叫、先固定 nonce 與費用再簽署的 signer 與 dispatcher，以及 RFQ／報價與做市抵押保留（[交付](M2_RFQ.md)）：報價依 ensemble snapshot 決定價格、保留在列鎖下計算並依 canonical 鏈狀態對帳，signer 只簽有對應保留的報價，以及型別化 client SDK、強制報價驗證與外部 agent 範例（[交付](M5_CLIENT_SDK.md)） |
| M3 Agent         | 進行中：job runtime 與預算（[交付](M3_JOBS_BUDGETS.md)）、allowlist fetch（[交付](M3_EVIDENCE_FETCHER.md)）、預測窗口（[交付](M3_FORECASTS.md)）、評分與指標（[交付](M3_EVALUATION.md)）、結算回報與草稿（[交付](M3_RESOLUTION.md)） | 已有 durable job/outbox、USD 預算、fixture 模型 gateway、SSRF 防護抓取、DAILY/PRE_CLOSE 窗口與 ensemble snapshot、精確 Brier 與 `/v1/metrics`、結算回報、GAAP 毛利率解析建議、截止提醒與未簽署的角色交易草稿；discovery、雙 forecaster 與 baseline worker（[交付](M3_RESEARCH_WORKERS.md)）經公開 API 運作；keeper 定時結算與測試資產 faucet（[交付](M3_KEEPER_FAUCET.md)）只經受限 signer 與 dispatcher 送出交易；mandate 下的內部 trader（[交付](M3_INTERNAL_TRADER.md)）只在自身機率超過賣價 500 bps 時買入，於 mandate 鎖下逐步檢查限額，只在確定失敗時釋放風險預留；每個部署限一個 trader |
| M4 產品介面      | 進行中：唯讀展示站與文件系統（12 頁 Markdown），詳見 [交付記錄](M4_WEB_SHOWCASE_DELIVERY.md) | 七類頁面、錢包、有限approve、價格與研究機率分離、錯誤狀態                                                                             |
| M5 Sepolia Alpha | 進行中：部署工具（本機 Anvil 驗證），詳見 [交付記錄](M5_DEPLOYMENT_TOOLING.md)；health／readiness 與管理執行指標（[交付](M5_HEALTH_METRICS.md)）；§17.1／§17.2 驗收對照表（[矩陣](ACCEPTANCE_MATRIX.md)）；一鍵本機 Alpha（`pnpm alpha:local`，[交付](M5_LOCAL_ALPHA.md)）以真實 API／signer／worker／indexer 跑完三種 REPLAY 結果、外部 agent 範例與 keeper 結算，並含兩種還原演練；整體審查後強化：公開 health 端點限流並共用 2 秒快照、所有服務檢查正式時鐘、服務登入只允許單一 runtime 群組、鏈 ID 每次讀取檢查，migration 0020 撤銷 PUBLIC 函式執行權 | 真實roles/manifest、前瞻題目、RPC與備份演練、外部使用者驗收；實際部署需使用者授權                                                     |

本機合約測試與 REPLAY 不是公開部署；身份功能可選啟用，但尚無 production signer／真實 indexer，不啟用 API 交易。完整 DB concurrency/recovery、provider 及正式安全檢視仍在後續驗收範圍。身份與部署基礎現況見 [M2.1 交付](M2_IDENTITY_DELIVERY.md)。

最新現況見 [建市事件追蹤](M2_CREATION_TRACKING.md) 與 [建市持續輪詢](M2_CREATION_POLLER.md)：操作員先驗證並登記建市交易，opt-in indexer 再持續檢查 receipt、確認數與 reorg。下一步：全鏈 canonical cursor 與完整 projection → RFQ reservation/signer → 交易 client。保持 REPLAY，不依賴付費模型，不自動簽署或廣播管理員交易。

核准 API 可透過 approval 模式啟用，其他模式維持原行為。真 PostgreSQL 多連線測試已於遠端 CI run 37099505426 通過（該 run 隨後因 Web build 引用錯誤失敗）；尚未對外部署，也未確認任何鏈上建市交易。
