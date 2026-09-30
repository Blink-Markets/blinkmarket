# 運行與部署設計

M0/M1更新：已有本機合約、基礎DB migration、spec file archive及manifest validator，見 [交付記錄](M0_M1_DELIVERY.md)。以下公開服務拓樸仍待M2/M3接線；尚未部署Sepolia。

## 現在可執行

README 的 pnpm dev 啟動五個 loopback HTTP host。API config、route inventory、health 可讀；Worker 不消費 queue；Indexer 不連 RPC；Signer 沒有簽署 endpoint。沒有後端 production artifact/container 或對外部署。

pnpm check：TS typecheck、M0 tests、package boundaries、完整Solidity合約編譯。pnpm test:contracts / pnpm replay驗證本機帳本；pnpm build建置Next Web host。這些不等於Alpha或安全審計。

## 目標 Alpha 拓樸

單區域應用主機部署 API/Worker/Indexer，Web 可同機或託管；一個 managed PostgreSQL、private S3 相容 bucket、主/備 Base Sepolia RPC。Signer 私有主機／container identity、獨立 secrets 與固定 caller allowlist。先不用 Kubernetes。

高可用需求未在 v0.1 定量前，不預付多區基礎設施。成本分 hosting/DB/object/RPC、模型/資料、gas/faucet；USD 20 每日是模型資料上限，不是總 hosting 月費。供應商、實際報價與部署地區待部署前確認，不在此虛構月費。

本機 Compose 只供 PostgreSQL 開發。正式 image 必須更新 patch、鎖 digest、掃描並保存 manifest；目前未選 object storage provider，故不假設本機模擬已驗證 immutable storage。

## 服務身份矩陣

| Identity | DB/網路 | Key |
| --- | --- | --- |
| Web | 只 API | 無 |
| API | 業務 DB 權限、RFQ signer 受驗證通道 | 無 |
| Worker research | job/model/evidence/budget tables、allowlist fetch/model | 無鏈上私鑰 |
| Worker execution | 受限 intent submission；不接受 LLM 任意 calldata | 無私鑰 |
| Indexer | RPC、chain/projection tables | 無 |
| Signer maker/trader/faucet/keeper | 各自 policy/intent/nonce 讀取與鎖、限定 RPC/secret store | 各自角色 key |
| ADMIN/proposer/challenger/arbiter | 手動錢包、受保護 admin API | 不在 worker/signer 的自動流程 |

Worker 初期一個 codebase，但研究與執行在 Alpha 部署時要使用不同 job allowlist / credentials。maker EOA 是固定 signer；管理四角色互異且不同 maker，不可成 taker。

## Release manifest

deployments/base-sepolia/manifest.template.json 是未部署範本，不能作 runtime config。真實部署需 artifact schema 驗證、chainId=84532 硬限制、地址／bytecode／ABI hash、部署 block、commit/compiler/dependencies、角色、caps/價格參數。新部署新 deploymentId；Web/API/signer 全部比對。

`deploymentBlock` 定義為兩份合約的 **inclusive 安全重播下界**，應填兩份部署 receipt 的最早 block number；更早的起點（含 0）安全但會增加掃描成本。Verifier 除核對同一 head 的 code／角色外，也查詢 `deploymentBlock - 1`，要求兩個地址當時都尚無 code，避免漏掉 token 或市場早期事件。此驗證適用於本專案固定、不可升級且無 selfdestruct 的合約；不是通用部署歷史證明。RPC 若無法提供所需歷史 state，驗證失敗，不跳過檢查；需換用支援該歷史區塊的 provider。最後仍核對 head hash，拒絕驗證期間的重組。

禁止主網，即使 env 寫 8453 也拒絕。部署 script 尚未加入；未提供可能誤部署的 placeholder 指令。

## Health 與觀測

- live：程序可回應；ready：DB/queue/RPC、signer policy、manifest 等必要依賴就緒，且 startup reconcile 已完成。
- trace：requestId → jobId → intentId → quote digest → tx hash / replacement → block hash。
- metrics：RFQ latency、queue age/attempt、indexer lag、未知 tx、reservation age、spent/unknown cost、keeper deadlines。
- log 不記 API key、私鑰、完整 provider secrets；audit 記 actor/reason/hashes。
- indexer lag >3 blocks OR 更新停滯 >10 秒停止新報價；期限告警不依賴 keeper 單一 process。
- graceful shutdown 停新 lease、保留未決 intent、釋放已確認可釋放的工作 lease；重啟先 reconcile。

## 事故與備份

新交易 pause 與既有結算／贖回分離。部署不可升級，bug 用新 deployment；舊部位沿既定結算。每日 DB backup，object versioning/retention；Alpha 前演練 DB restore + canonical events 重播、資料核對及重新開啟報價。

未定費率、不明 gas 上界或缺 RPC finality 能力時保持停止／unknown，不能自動假設免費、失敗或 finalized。
