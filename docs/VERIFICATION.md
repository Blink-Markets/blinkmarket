# 架構基線驗證

此文件保留最初架構骨架的歷史結果；初期交付見 [M0/M1交付記錄](M0_M1_DELIVERY.md)，後續整合與驗收證據見 [本機 Alpha](M5_LOCAL_ALPHA.md) 及 [驗收矩陣](ACCEPTANCE_MATRIX.md)。

日期：2026-09-22；本機 Node.js 22.23.1 / pnpm 11.20.0。

| 檢查 | 結果 |
| --- | --- |
| pnpm install --frozen-lockfile | 通過；esbuild 是唯一允許安裝腳本的依賴 |
| pnpm check | 通過：TypeScript、3 個契約／骨架測試、依賴方向、Solidity 介面編譯 |
| pnpm build | 通過：Next.js production build |
| docker compose -f infra/compose.yaml config --quiet | 通過；只驗 Compose 設定 |
| pnpm dev + 本機 HTTP smoke | 五個程序均啟動成功；檢查後已停止 |
| Web /、API /v1/config | 200，stage=architecture、tradingEnabled=false |
| API /health/ready | 503，未誤報業務就緒 |
| Worker / Indexer / Signer /health/live | 200 |
| POST /v1/rfqs | 501 NOT_IMPLEMENTED，沒有交易副作用 |

三個測試涵蓋：交易停用與 readiness、整數 wire schema/LIVE 挑戰時間、EIP-712 與 Solidity Quote 型別順序。

此歷史檢查未驗證：實際 PostgreSQL 運行／migration、object storage、RPC、Foundry 帳本/invariants、鏈上部署、認證、資金與預算並發、模型、UI。這些在當時尚未實作；後續本機 backend／合約／資料庫整合已有交付，公開部署、付費模型與操作 UI 仍未完成，不能將此歷史紀錄視為規格 §17 全部驗收通過。

本機服務綁定與依賴下載需要執行環境允許 loopback/network。測試採 node --import tsx，避免 tsx CLI 額外建立 IPC socket。未送出任何鏈上交易或模型請求。
