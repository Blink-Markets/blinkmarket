# 本機開發與驗證

專案介紹見 [README](../README.md)。本頁集中保存啟動、驗證與基礎設施指令。

人工核准最新啟用方式見 [M2 核准交付](M2_APPROVAL_DELIVERY.md#configuration--manual-operations)：approval 模式需要 migration 0004、公開 spec origin、持久化 spec 目錄與唯讀 evidence 目錄。部署登錄 CLI 使用獨立帳號；不代表本機已有真實部署，也不會自動送出交易。

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

未設定環境變數時，API 使用 scaffold，Worker／Indexer 業務功能與 Signer 停用；不需要資料庫、RPC、模型 key 或錢包，不會花費 gas 或模型費用。Web 已是唯讀說明站與虛構 REPLAY 樣本，沒有交易／錢包／管理 UI。下表位址僅供本機開發，沒有公開 API 主機或 Base Sepolia 部署。

| 入口         | 位址                               | 目前行為                                                |
| ------------ | ---------------------------------- | ------------------------------------------------------- |
| Web          | http://127.0.0.1:3000              | Next.js 唯讀網站、文件與虛構 REPLAY 樣本                |
| API 設定     | http://127.0.0.1:3001/v1/config    | scaffold 回 deployment=null、tradingEnabled=false；trading 依部署與 RFQ gate 回報       |
| 架構清單     | http://127.0.0.1:3001/architecture | 模組與 API 路由清單                                     |
| OpenAPI 契約 | http://127.0.0.1:3001/openapi.json | 由共享 schemas 產生契約，enabled 標註依已註冊服務 |
| Worker       | http://127.0.0.1:3002/health/live  | 活性檢查；/jobs 回啟用狀態與工作清單，啟用後消費 queue                            |
| Indexer      | http://127.0.0.1:3003/health/live  | 活性檢查；CHAIN_INDEXER_ENABLED=true 並完整設定後持續同步                                  |
| Signer       | http://127.0.0.1:3004/health/live  | 活性檢查；`SIGNER_ENABLED=true` 才有 /internal/sign     |

API 模式逐層啟用，未註冊的業務路徑維持 fail-closed；各模式與需求以 `apps/api/src/config.ts`、`main.ts` 為準：

- `scaffold`：不接 DB，格式錯誤回 400，有效但未啟用的業務請求回 501；`/v1/config` 為 deployment=null、tradingEnabled=false。
- `identity`／`preparation`／`approval`：依序增加 wallet auth、證據／候選與人工核准；見 [身份](M2_IDENTITY_DELIVERY.md)、[候選](M2_PREPARATION_DELIVERY.md)、[核准](M2_APPROVAL_DELIVERY.md)。
- `markets`：另接公開市場／持倉／結算／交易追蹤、forecast、resolution reports 與公開 evaluation metrics；不接 RFQ signer。與前述模式一樣，API `/v1/health` 與 `/health/ready` 仍回 503，因未注入交易 readiness service。
- `trading`：另接 RFQ、faucet、health 與 admin execution metrics。`/v1/health` 公開回 `{status, tradingEnabled, reasons}`，無 gate reason 才為 200，否則 503；帶有效 admin key 另加 diagnostics，無效／非 admin key 回 401／403。API `/health/ready` 使用相同的公開 readiness 決策。此模式需要 signer、RPC、已登錄 deployment 與完整 DB／archive 設定，並非只切換模式就 ready；見 [健康與指標](M5_HEALTH_METRICS.md)。

Worker 預設停用；設 `WORKER_ENABLED=true` 與專用 DB 登入後執行 queue／outbox／定期排程，research、execution 與 trader 依各自設定組合，readiness 依工作迴圈是否運行。Indexer 的 creation polling、transaction tracking、continuous chain index 各自啟用；全域 `/health/ready` 仍為 503，鏈索引狀態另看 `/health/chain-index`。Signer 預設停用，啟用後 `/health/ready` 依 DB、部署與 RPC 回報。這些程序或 deployment readiness 都不是個別市場／taker 可以成交的保證，也不代表公開部署完成。

單獨啟動可用 `pnpm --filter @blink/api dev`，其他 app 同理。Web 建置：`pnpm build`。

後端独立部署產物：`pnpm build:services`；驗證不依賴 workspace／tsx 的 bundle：`pnpm test:service-build`。API 容器範本為 `infra/Dockerfile.api`，build context 使用 repo root；目前尚未完成公開部署驗收。

## 可選本機基礎設施

```sh
pnpm infra:up
```

只啟動本機 PostgreSQL，帳密為開發用，資料存在 Docker named volume。API 在非 scaffold 模式才使用專用 `API_DATABASE_URL` 連 DB，不由 Compose 自動啟用。結束用 `pnpm infra:down`，保留 volume。M0 已有基礎 migration runner；執行前明確指定資料庫：

```sh
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

會建立 domains、group roles、audit/idempotency/outbox/jobs；需要具備建 schema/role 權限的 migration 帳號。目前 migrations 0001–0019 已含 identity、候選、核准、chain、forecast、signing、trading 與 observability 業務表；S3 adapter 仍未實作。`pnpm test` 使用隔離的 PGlite PostgreSQL engine，不需要連既有資料庫。

## 目錄

```text
apps/                 web / api / worker / indexer / signer
packages/
  schemas/            wire schema、GM 模板、EIP-712 欄位
  domain/             十二個業務模組的責任與用語
  ports/              DB transaction、queue、storage、RPC、模型與 signer 邊界
  application/        已接線的 use cases、jobs、RFQ、health 與 execution 協調
  adapters/           DB transaction/migrations、spec archive、本機object store、部署驗證
  runtime/            共用 HTTP 啟動、health、錯誤處理
  client/             Private 型別化回應、runtime validation、spec／quote 驗證與同 key 重試
contracts/            TestUSD/Market 合約、Foundry tests、生成的 ABI/bytecode artifacts
infra/                本機 PostgreSQL
deployments/          release manifest 範本，沒有真實地址
fixtures/replay/      明示 REPLAY 的 schema fixture
docs/                 架構、資料、營運、ADR、roadmap
tests/                單元、整合、合約協定、PostgreSQL／Anvil／Alpha 與瀏覽器檢查
```

不要將 REPLAY 當作 LIVE 題目，或將本機測試通過當作已審計／可公開交易。正式部署 manifest 必須有真實 commit、地址與鏈上驗證；template 及 LOCAL_REPLAY_ONLY report 不可用作正式 manifest。
