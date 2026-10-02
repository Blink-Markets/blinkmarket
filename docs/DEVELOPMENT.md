# 本機開發與驗證

專案介紹見 [README](../README.md)。本頁集中保存啟動、驗證與基礎設施指令。

## 本機啟動

需求：Node.js 22.23.1、pnpm 11.20.0。版本已寫入 .nvmrc / packageManager；直接使用既有版本相符的工具即可。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:contracts
pnpm test:contracts:seeds
pnpm replay
pnpm dev
```

骨架不需要資料庫、RPC、LLM key、錢包或 .env 即可啟動；不會花費 gas 或模型費用。

| 入口         | 位址                               | 目前行為                                                |
| ------------ | ---------------------------------- | ------------------------------------------------------- |
| Web          | http://127.0.0.1:3000              | JSON 功能分類與未來頁面清單，尚無產品 UI                |
| API 設定     | http://127.0.0.1:3001/v1/config    | 測試網資訊，deployment=null、tradingEnabled=false       |
| 架構清單     | http://127.0.0.1:3001/architecture | 模組與 API 路由清單                                     |
| OpenAPI 契約 | http://127.0.0.1:3001/openapi.json | 從共享 schemas 產生請求／回應／身份契約；業務標註未實作 |
| Worker       | http://127.0.0.1:3002/health/live  | 活性檢查；/jobs 可看規劃工作                            |
| Indexer      | http://127.0.0.1:3003/health/live  | 活性檢查，尚未同步區塊                                  |
| Signer       | http://127.0.0.1:3004/health/live  | 活性檢查，沒有簽章 API                                  |

預設 scaffold 模式：API 格式錯誤回 400，有效業務請求仍回 501。identity 模式接入 PostgreSQL 與兩個 wallet auth endpoint，見 [身份交付](M2_IDENTITY_DELIVERY.md)。preparation 模式另啟用證據 metadata、候選新增／修訂／查詢／拒絕，離線匯入及權限見 [證據與候選交付](M2_PREPARATION_DELIVERY.md)。所有後端 /health/ready 及 API /v1/health 仍回 503，完整交易鏈路尚未 ready。

單獨啟動可用 `pnpm --filter @blink/api dev`，其他 app 同理。Web 建置：`pnpm build`。

後端独立部署產物：`pnpm build:services`；驗證不依賴 workspace／tsx 的 bundle：`pnpm test:service-build`。API 容器範本為 `infra/Dockerfile.api`，build context 使用 repo root；目前尚未完成公開部署驗收。

## 可選本機基礎設施

```sh
pnpm infra:up
```

只啟動本機 PostgreSQL，帳密為開發用，資料存在 Docker named volume。API 尚未接 DB。結束用 `pnpm infra:down`，保留 volume。M0 已有基礎 migration runner；執行前明確指定資料庫：

```sh
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

會建立 domains、group roles、audit/idempotency/outbox/jobs；需要具備建 schema/role 權限的 migration 帳號。業務表與S3 adapter留M2。`pnpm test` 使用隔離的 PGlite PostgreSQL engine，不需要連既有資料庫。

## 目錄

```text
apps/                 web / api / worker / indexer / signer
packages/
  schemas/            wire schema、GM 模板、EIP-712 欄位
  domain/             十二個業務模組的責任與用語
  ports/              DB transaction、queue、storage、RPC、模型與 signer 邊界
  application/        use case 組合位置，目前未接 handler
  adapters/           DB transaction/migrations、spec archive、本機object store、部署驗證
  runtime/            共用 HTTP 啟動、health、錯誤處理
  client/             共用契約驗證的 config/market/RFQ client，業務 API 尚未啟用
contracts/            TestUSD/Market 合約、Foundry tests、生成的 ABI/bytecode artifacts
infra/                本機 PostgreSQL
deployments/          release manifest 範本，沒有真實地址
fixtures/replay/      明示 REPLAY 的 schema fixture
docs/                 架構、資料、營運、ADR、roadmap
tests/                架構安全預設與跨語言協定檢查
```

不要將 REPLAY 當作 LIVE 題目，或將本機測試通過當作已審計／可公開交易。正式部署 manifest 必須有真實 commit、地址與鏈上驗證；template 及 LOCAL_REPLAY_ONLY report 不可用作正式 manifest。
