# 架構基線驗證

此文件保留最初架構骨架的歷史結果；最新實作與驗證見 [M0/M1交付記錄](M0_M1_DELIVERY.md)。

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

未驗證：實際 PostgreSQL 運行／migration、object storage、RPC、Foundry 帳本/invariants、鏈上部署、認證、資金與預算並發、模型、UI。這些尚未實作，不能視為規格 §17 驗收通過。

本機服務綁定與依賴下載需要執行環境允許 loopback/network。測試採 node --import tsx，避免 tsx CLI 額外建立 IPC socket。未送出任何鏈上交易或模型請求。
