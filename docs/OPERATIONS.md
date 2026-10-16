# 運行與部署設計

目前 backend 已有 API／Worker／Indexer／Signer 業務接線與 migrations 0001–0019；交付範圍見 [整體架構](ARCHITECTURE.md)、[本機 Alpha](M5_LOCAL_ALPHA.md) 及 [驗收矩陣](ACCEPTANCE_MATRIX.md)。以下公開服務拓樸是部署目標，並非未實作的 backend：尚無公開 API 主機或 Base Sepolia 部署，沒有付費模型，LIVE 核准仍拒絕；託管服務與外部使用者驗收仍未完成。

## 現在可執行

`pnpm dev` 啟動五個 loopback host；Web 是唯讀說明、文件與虛構 REPLAY 樣本。API 預設 scaffold，Worker／Indexer 業務功能與 Signer 預設停用，避免未設定就連 DB／RPC 或簽章；啟用方式見 [本機開發](DEVELOPMENT.md)。設定完整後，已實作的接線包括：

- API 依模式逐層啟用身份、候選、核准與公開讀取；trading 模式另接 RFQ、faucet、health/admin metrics，並經 caller token 呼叫受限 signer。
- Worker 在 `WORKER_ENABLED=true` 與專用 DB 登入下消費持久 queue、dispatch outbox 與排程；research、execution、trader 依各自設定組合，涵蓋 fixture 預測、評估、resolution jobs、reservation 對帳、keeper、faucet 與受限交易提交。未設定的可選功能不會自動啟用；`alert.*` outbox 事件由獨立的 `alert.deliver` worker loop 以 stdout／檔案／webhook sink 至少一次傳送（見 [告警傳送](M5_ALERTS.md)）；告警由 `alert.evaluate`（每分鐘，主 worker loop，不需 keeper／signer／execution 設定）自真實條件產生：預算（日／問題閘門、signer gas 上限拒絕）、暫停（全域／市場／maker pool）、RPC 故障（沿用 `BASE_SEPOLIA_RPC_URL`；未設定則不評估）、indexer 落後、keeper 逾時（due 超過 600 chain 秒）與 DEAD job；每個條件為一個 episode，送出 OPEN、每 60 分鐘 STILL_OPEN、結束時 CLEARED。期限告警 `alert.deadline` 不變。
- Indexer 在 `CHAIN_INDEXER_ENABLED=true` 與專用 DB／RPC／deployment 設定下持續同步 canonical 區塊、事件與投影並處理 reorg；creation receipt polling 與交易追蹤另有各自開關。
- Signer 在 `SIGNER_ENABLED=true`、key 檔、DB 登入、RPC 與 caller 白名單完整時提供 `POST /internal/sign`，已接 trading API 與 execution/trader Worker；私鑰只在 signer，caller 驗證不等於正式網路隔離已完成，見 [Signer](M2_SIGNER.md)。

`pnpm build:services` 產生 `dist/services/{api,worker,indexer,signer}.mjs`、管理工具 bundles 與 migrations，`pnpm test:service-build` 驗證獨立 bundle。`infra/Dockerfile.api` 已有 API 多階段容器範本，以非 root 使用者執行 API bundle，healthcheck 只測 liveness；尚未驗收公開部署、完整服務容器拓樸或供應鏈發布流程。

`pnpm check` 執行兩個 TS typecheck、Node 單元／整合測試、package boundaries 與 Solidity 合約編譯。`pnpm test:contracts`／`pnpm replay` 驗證本機帳本；`pnpm build` 建置 Next.js Web；`pnpm alpha:local` 使用專用本機 PostgreSQL 與 Anvil 驗證三種 REPLAY 結算及投影恢復。這些不等於公開 Alpha、公開網路 finality、完整營運 restore drill 或安全審計。

## 目標 Alpha 拓樸

單區域應用主機部署 API/Worker/Indexer，Web 可同機或託管；一個 managed PostgreSQL、private S3 相容 bucket、主/備 Base Sepolia RPC。Signer 私有主機／container identity、獨立 secrets 與固定 caller allowlist。先不用 Kubernetes。

高可用需求未在 v0.1 定量前，不預付多區基礎設施。成本分 hosting/DB/object/RPC、模型/資料、gas/faucet；USD 20 每日是模型資料上限，不是總 hosting 月費。供應商、實際報價與部署地區待部署前確認，不在此虛構月費。

本機 Compose 只供 PostgreSQL 開發。正式 image 必須更新 patch、鎖 digest、掃描並保存 manifest；目前未選 object storage provider，故不假設本機模擬已驗證 immutable storage。

## 服務身份矩陣

| Identity | DB/網路 | Key |
| --- | --- | --- |
| Web | 目前靜態網站不接 backend；未來操作 UI 僅經 API | 無 |
| API | 業務 DB 權限、RFQ signer 受驗證通道 | 無 |
| Worker research | job/model/evidence/budget tables、allowlist fetch/model | 無鏈上私鑰 |
| Worker execution | 受限 intent submission；不接受 LLM 任意 calldata | 無私鑰 |
| Indexer | RPC、chain/projection tables | 無 |
| Signer maker/trader/faucet/keeper | 各自 policy/intent/nonce 讀取與鎖、限定 RPC／key-file；secret store 為部署目標 | 各自角色 key |
| ADMIN/proposer/challenger/arbiter | 手動錢包、受保護 admin API | 不在 worker/signer 的自動流程 |

Worker 初期一個 codebase，但研究與執行在 Alpha 部署時要使用不同 job allowlist / credentials。maker EOA 是固定 signer；管理四角色互異且不同 maker，不可成 taker。

## Release manifest

deployments/base-sepolia/manifest.template.json 是未部署範本，不能作 runtime config。真實部署需 artifact schema 驗證、chainId=84532 硬限制、地址／bytecode／ABI hash、部署 block、commit/compiler/dependencies、角色、caps/價格參數。新部署新 deploymentId；Web/API/signer 全部比對。

`deploymentBlock` 定義為兩份合約的 **inclusive 安全重播下界**，應填兩份部署 receipt 的最早 block number；更早的起點（含 0）安全但會增加掃描成本。Verifier 除核對同一 head 的 code／角色外，也查詢 `deploymentBlock - 1`，要求兩個地址當時都尚無 code，避免漏掉 token 或市場早期事件。此驗證適用於本專案固定、不可升級且無 selfdestruct 的合約；不是通用部署歷史證明。RPC 若無法提供所需歷史 state，驗證失敗，不跳過檢查；需換用支援該歷史區塊的 provider。最後仍核對 head hash，拒絕驗證期間的重組。

禁止主網，即使 env 寫 8453 也拒絕。部署工具 `pnpm contracts:deploy` 預設 dry run，只有加上 `--broadcast` 才讀取部署金鑰並送出交易；用法、檢查與限制見 [M5 部署工具](M5_DEPLOYMENT_TOOLING.md)。目前只在本機 Anvil（chainId 84532）驗證，尚未部署到 Base Sepolia。

## Health 與觀測

- live 只表示程序可回應。API scaffold 至 markets 的 `/v1/health` 與 `/health/ready` 仍為 503；trading 模式才注入部署 health reader 與 signer probe，兩條路徑採相同公開 readiness 決策，ready 為 200、否則 503。
- `/v1/health` 公開回 status／tradingEnabled／reasons；有效 admin key 另加 queue／cursor／budget／maker pool 等診斷，無效／非 admin key 回 401／403。`/v1/admin/metrics` 提供 admin-only 執行延遲、持久化狀態／錯誤計數及 role/day gas，與公開 forecast evaluation metrics 分開。Readiness 不保證個別市場或 taker 可成交，見 [健康與指標](M5_HEALTH_METRICS.md)。
- Worker readiness 只看工作迴圈是否運行；Indexer 全域 `/health/ready` 仍為 503，鏈索引狀態另由 `/health/chain-index` 回報；Signer 啟用後依 DB／部署／RPC 即時回報。不能將不同程序的 readiness 當成同一份完整營運驗收。
- trace：requestId → jobId → intentId → quote digest → tx hash / replacement → block hash。
- 目標監控項目還包括 queue age／attempt、indexer lag、未知 tx、reservation age、spent／unknown cost 與 keeper deadlines；不代表 admin metrics 已逐項輸出，實際欄位以 [健康與指標](M5_HEALTH_METRICS.md) 為準。
- log 不記 API key、私鑰、完整 provider secrets；audit 記 actor/reason/hashes。
- indexer lag >3 blocks OR 更新停滯 >10 秒停止新報價；期限告警不依賴 keeper 單一 process；`alert.evaluate` 在任何啟用的 Worker 都會執行，keeper 未設定時也一樣；建議仍另開一個關閉 execution 的 Worker 以免被 keeper job 拖住。
- Worker shutdown 停止排程與工作迴圈、等待既有工作並關閉 pool；Indexer 停各觀測迴圈。未決交易與 reservations 由持久記錄恢復／對帳，不能因程序重啟就假設失敗或釋放風險；完整營運 shutdown／recovery 仍需部署演練。

## 事故與備份

新交易 pause 與既有結算／贖回分離。部署不可升級，bug 用新 deployment；舊部位沿既定結算。每日 DB backup，object versioning/retention；Alpha 前演練 DB restore + canonical events 重播、資料核對及重新開啟報價。

未定費率、不明 gas 上界或缺 RPC finality 能力時保持停止／unknown，不能自動假設免費、失敗或 finalized。
