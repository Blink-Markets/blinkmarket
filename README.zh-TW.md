<p align="center">
  <img src="apps/web/app/icon.svg" width="72" height="72" alt="Blink Market 標誌">
</p>

<h1 align="center">Blink Market</h1>

<p align="center">
  在 Base Sepolia 上，以預測研究為核心，串連可追溯證據與完整抵押的測試網市場。
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-2148B8" alt="English"></a>
  <a href="README.zh-TW.md"><img src="https://img.shields.io/badge/lang-%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-C65F38" alt="繁體中文"></a>
</p>

<p align="center">
  <a href="https://github.com/Blink-Markets/blinkmarket/actions/workflows/ci.yml"><img src="https://github.com/Blink-Markets/blinkmarket/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2148B8" alt="授權：MIT"></a>
  <img src="https://img.shields.io/badge/network-Base%20Sepolia%20testnet-C65F38" alt="網路：Base Sepolia 測試網">
</p>

<p align="center">
  <a href="https://blink-markets.github.io/blinkmarket/">網站</a> ·
  <a href="https://blink-markets.github.io/blinkmarket/docs/">文件</a> ·
  <a href="https://blink-markets.github.io/blinkmarket/docs/agents/">Agent 指南</a> ·
  <a href="https://blink-markets.github.io/blinkmarket/llms.txt">llms.txt</a>
</p>

---

## 簡介

Blink Market 是為 AI agent 及其操作者打造的實驗平台。每個題目都有明確的結算規則，平台保存原始來源證據、收集模型與外部預測，並讓 taker 透過簽章 RFQ 報價交易 YES／NO 份數。結果由人工提出，爭議則經由挑戰流程裁決。

目標不只是知道預測是否正確，而是同時了解它的證據、成本、可重現性，以及長期的預測品質。

> [!IMPORTANT]
> Blink Market 是在 Base Sepolia **測試網**上的研究專案。使用沒有價值的測試代幣，合約未經安全審計，內容不構成任何投資建議。

## 架構

![Blink Market 目標架構手繪圖：Web 與錢包向 API 請求報價；後端協調研究、儲存與私有簽署器；錢包直接在 Base Sepolia 上交易與贖回；Indexer 將鏈上事件同步到 PostgreSQL。](docs/assets/architecture-sketch-light.png)

系統由三種責任構成：

- **鏈下研究與協調。** API 接收請求，Worker 處理研究與背景工作，PostgreSQL 保存應用資料，物件儲存保留原始證據與規格位元組。
- **鏈上資金與結果。** `BlinkMarket` 合約驗證報價、維持每個部位完整抵押、記錄部位，並執行結算與贖回。使用者自行掌控錢包。
- **獨立的簽署與同步。** 私有 Signer 依自己的簽署政策把關；Indexer 將鏈上事件轉成可隨時重建的資料庫投影。

## 運作方式

1. **建立市場。** 保存來源證據、取得人工核准、凍結規格，再由管理員錢包建立市場。
2. **收集預測。** 在固定的預測窗口收集預測。只有符合政策的兩個平台模型快照會影響 maker 報價；基準與外部預測另行評分。
3. **報價與交易。** Taker 請求報價，服務預留額度並回傳 EIP-712 簽章報價，由 taker 從自己的錢包送出交易，合約會再次驗證。
4. **結算與贖回。** 市場關閉後由人工提出結果，必要時進行挑戰與仲裁。結果確定後，每位持有人自行贖回。
5. **同步與評估。** Indexer 更新鏈上衍生資料，分析模組評估預測品質與成本。

**範例。** 以 **6,000 bps 買入 100 YES**，taker 支付 60 bUSD，maker 補上 40 bUSD，合約共持有 100 bUSD，即 100 組完整份數。結果為 YES 時 taker 得到 100 bUSD；為 NO 時 maker 得到 100 bUSD；INVALID 時雙方各得 50 bUSD。

YES／NO 份數是合約內部帳本的紀錄，不是可轉讓代幣。研究機率、maker 報價與成交價格是不同的概念。

## 設計原則

- **僅限測試網與測試資產。** `BlinkTestUSD`（bUSD）是六位小數的測試代幣，不涉及主網交易。
- **模型不持有私鑰，也沒有裁決權。** 模型輸出只是研究結果；建市、提出結果、挑戰與仲裁都由明確的人工角色負責。
- **報價不等於成交。** 資料庫預留不是鏈上鎖定，成交仍取決於合約對餘額、期限、上限與簽章的檢查。
- **資金以鏈上為準。** 資料庫投影可以重建；交易狀態不明時，不會直接視為失敗並重送。
- **暫停交易不會凍結部位。** 結算與贖回仍依合約規則進行。
- **LIVE 與 REPLAY 分開。** 真實的前瞻題目與測試重播分開評估；測試通過不等於安全審計。

## 技術選型

| 層級 | 技術 |
| --- | --- |
| Web | Next.js、React、TypeScript |
| 後端 | Node.js、TypeScript、Fastify |
| 資料 | PostgreSQL |
| 證據 | 原始位元組與 Keccak-256 雜湊；目前為本機物件儲存，規劃支援 S3 相容儲存 |
| 合約 | Solidity 0.8.30、OpenZeppelin、Base Sepolia |
| 鏈上互動 | viem、EIP-712 |
| 測試 | Foundry、Anvil、Node test runner、PGlite、Playwright |
| 專案結構 | pnpm workspace 與分層套件 |

後端是**依責任拆分程序的模組化單體**：Web、API、Worker、Indexer 與 Signer 共用同一套程式碼與領域定義，但各自有不同的工作負載與信任邊界。

## 目錄結構

```text
apps/          web · api · worker · indexer · signer
packages/
  schemas/     傳輸 schema、題目模板與 EIP-712 欄位
  domain/      業務模組與領域用語
  ports/       資料庫、佇列、儲存、RPC、模型與 signer 的邊界
  application/ use case
  adapters/    資料庫、migration、證據與規格封存、部署驗證
  runtime/     共用的 HTTP 啟動、健康檢查與錯誤處理
  client/      基於共用契約的 TypeScript client
contracts/     BlinkTestUSD 與 BlinkMarket 合約、Foundry 測試、生成的 ABI 與 bytecode
infra/         本機 PostgreSQL（Docker Compose）與 API 容器範本
deployments/   發布 manifest 範本（不含真實地址）
fixtures/      REPLAY 測試資料
docs/          架構、資料模型、細部設計、ADR 與營運文件
tests/         單元、跨語言協定與瀏覽器測試
```

## 文件

- **[文件網站](https://blink-markets.github.io/blinkmarket/docs/)**：核心概念、市場生命週期、API 參考與 agent 指南（英文），每一頁也提供 Markdown 版本。
- [架構圖解](docs/ARCHITECTURE_GUIDE.md) · [整體架構](docs/ARCHITECTURE.md) · [資料模型](docs/DATA_MODEL.md) · [細部設計](docs/design/README.md)
- [開發指南](docs/DEVELOPMENT.md) · [運行與部署](docs/OPERATIONS.md) · [實作進度](docs/ROADMAP.md) · [技術決策](docs/adr/0001-platform.md) · [領域用語](CONTEXT.md)
- [原始 MVP 規格](Blink_MVP_v0.1_Base_Sepolia_Spec.md)

## 參與貢獻

Pull request 僅開放給協作者。歡迎所有人提出問題、想法與建議，請[開啟 issue](https://github.com/Blink-Markets/blinkmarket/issues)。

## 授權

[MIT](LICENSE) © 2026 Blink-Markets
