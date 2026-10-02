# M2.1 — 邀請身份與錢包綁定

M2 已開始，但**尚未完成整個垂直交易流程**。本切片先將身份功能接入真實 PostgreSQL adapter 與 HTTP；候選／證據／核准建市、Indexer/reorg、RFQ/reservation、Signer 與交易追蹤仍未接線。沒有外部部署、沒有付費模型呼叫，也沒有新私鑰被注入自動服務。

## 本次交付

| 層                    | 實作                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Schema                | 邀請 scopes、wallet challenge／verification request/response、身份錯誤碼                               |
| Database              | 0002_identity：operators、agents、api_keys、wallet_challenges、wallet_bindings；FK、唯一性與分角色權限 |
| Application           | key 驗證、一次性 EOA 綁定、交易式冪等、audit；依賴 ports，不依賴 SQL 或 viem                           |
| Adapters              | PostgreSQL repository、SHA-256／恆時雜湊比較、viem personal-sign 恢復地址                              |
| API                   | 選擇 identity 模式後啟用兩個 auth endpoint；未啟用的交易端點仍不回假成功                               |
| Admin                 | 受資料庫角色保護的邀請／增發 key／撤銷 CLI；無公開 self-signup 或發 key endpoint                       |
| Client                | createWalletChallenge／verifyWallet，只傳輸與驗證契約，不持私鑰或自動簽名                              |
| Deployment foundation | 四個 Node 服務各自 bundle、獨立 migration/admin bundle、API Dockerfile；API 的 host/port 可設定        |

API key 格式為 `blink_<key UUID>.<256-bit random secret hex>`。只在發行時顯示 secret，DB 存 SHA-256 hash；API key 的高熵隨機值不是使用者密碼。有效期預設 30 天，可縮短至 1–30 天。每次操作／冪等重送都重新驗證有效期與撤銷狀態；admin scope 不等同鏈上 ADMIN，也不授予私鑰或資金權限。

## 啟用與安全預設

預設 `BLINK_API_MODE=scaffold`，保持不需要 DB 即可啟動。只有明確選擇 `identity` 並提供 `API_DATABASE_URL`、`WALLET_BINDING_ORIGIN` 才接入身份功能。未讀取 `.env` 檔；由 shell、容器或部署平台注入各程序需要的環境變數。

API startup 拒絕 superuser／CREATEDB／CREATEROLE、identity admin 或有 identity/operations DDL 權限的 DB 帳號。應使用具有 `blink_api` membership 的独立 LOGIN；遷移與發 key 使用另外的管理身份。範本不會替使用者建立固定密碼。

`/v1/config.stage` 在身份模式為 `m2-identity`；`tradingEnabled=false`、`deployment=null` 不變。`/health/ready`、`/v1/health` 仍回 503：身份功能可測試，不代表完整交易平台已 ready。`/openapi.json` 只將兩個身份路徑標成 enabled，其他維持 not-implemented。靜態 OpenAPI 預設描述 scaffold；是否啟用以 runtime 文件為準。

## 綁定與一致性規則

- Challenge 使用伺服器設定的固定 origin，不讀使用者 Host header；HTTPS 必需，僅允許 localhost/loopback HTTP 作本機開發。
- 簽署訊息明示「只綁身份，不授權交易、token approval 或提款」，包含 chain 84532、origin、address、key、agent、challenge ID、隨機 nonce 與五分鐘有效期。
- 驗證只使用 DB 保存的原始 message，不接受使用者另傳 message 或任意鏈；目前為 EOA personal-sign，不支援 ERC-1271。
- 每個 agent 只允許一個不可覆寫的綁定；同一鏈地址不能綁到另一 agent。更换 key 可沿用 agent 身份，但不能驗證另一把 key 建立的 challenge。自助換綁／復原流程尚未設計，不自動解除已有關係。
- 每把 key 同時最多 5 個未過期、未消耗 challenge。這是狀態配額，不是完整公共流量限流；公開上線前仍需入口 rate limit。
- 冪等 scope 是 operator＋HTTP method/path＋key；payload hash 另含認證 key ID、固定 origin 與標準化 body，防止同 operator 的不同 key 取得別人的綁定結果。更換 JSON key 順序或地址大小寫不新增 challenge。
- 已完成請求回原結果，包括已過期的 challenge；新 key 表示新的業務請求。已消耗 nonce 不能以新的冪等 key 重複使用。簽章驗證失敗亦保存終局結果，不可用同 key 偷換 payload。
- 身份交易的鎖定順序：API key shared lock → idempotency advisory lock/record → agent row → challenge → binding/audit。撤銷會等既有使用該 key 的交易結束；等待資源鎖後重新檢查時間，不因排隊延長有效期。
- 同 scope 的 in-flight 請求以 `pg_try_advisory_xact_lock` 回 409 REQUEST_IN_PROGRESS；交易提交後可重試取得原結果。SQL 錯誤回滾全部狀態，不留下偽成功。
- challenge／綁定／audit／冪等結果在同一 DB transaction；此切片没有外部副作用，因此不需要 outbox job。後續建市意圖才會接 outbox。

## 邀請與外部 client 流程

先以 migration 身份執行既有 `pnpm db:migrate`，建立 0001/0002 與 NOLOGIN group roles；由部署管理者建立分開的 LOGIN 並授予群組。API login 不得同時屬於 `blink_identity_admin`。不要把 migration/admin 連線字串交給 API。

管理者在私有終端，以 `IDENTITY_ADMIN_DATABASE_URL` 注入專用連線：

```sh
pnpm identity:admin invite --operator-name 'Research team' --agent-name 'Agent A' --scopes 'candidate:write,trade:quote' --reason 'Approved invitation'
pnpm identity:admin issue --agent-id '<agent UUID>' --scopes 'trade:quote' --days 7 --reason 'Key rotation'
pnpm identity:admin revoke --key-id '<key UUID>' --reason 'Retired credential'
```

invite/issue 的 stdout **含只顯示一次的秘密**。禁止在共用 CI log 執行、不要提交回應到 Git；透過安全管道交給受邀者。Key rotation 是先 issue 再由管理者 revoke 舊 key，程式不暗自延長或替換舊 key。

外部使用者只需要受邀 key 與自己的錢包：

1. 用 Bearer key 與 Idempotency-Key 呼叫 `POST /v1/auth/wallet-challenges`，body 為 `{ "address": "0x..." }`。
2. 檢查回應訊息中的 origin、鏈、地址、用途與有效期，使用自己的 EOA 錢包簽署**原始 message**。
3. 用同一把 API key、新的 Idempotency-Key 呼叫 `POST /v1/auth/wallet-verifications`，body 為 `{ "challengeId": "...", "signature": "0x..." }`。
4. 收到 wallet/verifiedAt 即完成身份綁定。這不會授權或執行交易，也不代表錢包已進合約 taker allowlist。

HTTP body/header/schema 錯誤回 400，無效 key 回 401，錯 scope 回 403，非自己的 challenge 回 404，過期／已使用／綁定衝突與冪等衝突回 409。未知 DB 錯誤不回傳 SQL 或 credentials。

## 部署產物

```sh
pnpm build:services
pnpm test:service-build
docker build -f infra/Dockerfile.api -t blink-api:local .
```

build 產生 `dist/services/{api,worker,indexer,signer}.mjs` 與 `dist/tools/{migrate,identity-admin}.mjs`，migration SQL 位於 `dist/migrations`。每個服務可獨立啟動，不需 runtime `tsx` 或 workspace symlink。`api-server.mjs` 供 bundle smoke test，不是額外服務。

Docker build context 必須是 repo root。API runtime image 僅含 API bundle，以非 root 使用者執行，不包含發 key/migration 工具或私鑰。Docker healthcheck 只檢查 liveness，不偽稱交易平台 ready。Worker／Indexer／Signer 的輸出仍是停用骨架；不是已完成的私有部署拓樸。TLS、外部入口限流、secret manager、持久化、發布／回滾與網路 ACL 留待部署驗收。

## 測試與限制

2026-10-01 本機驗證：`pnpm check` 通過（21 個 Node tests、TypeScript、依賴邊界與合約編譯）；`pnpm test:contracts` 24 項通過；`pnpm build:services` 與兩個獨立 bundle smoke tests 通過；`pnpm build` Web 建置通過。合約本身未修改。

本切片新增 PGlite＋HTTP＋本機 EOA 簽章測試：雜湊保存、DB role、正確綁定、重送／改 payload、跨 key／agent、錯 signer／origin、過期、撤銷、scope、challenge 配額、audit 失敗全回滾、client 接入。PGlite pool 模擬的是單連線排隊，不宣称驗證真實併發鎖。

`tests/postgres/identity.test.ts` 是獨立的真 PostgreSQL 多連線測試；以 `TEST_POSTGRES_ADMIN_URL` 指向**專用測試 cluster**，建立隨機 `blink_m2_*` DB，結束只刪該 DB；會建立 migration 所需 group roles。測試同 key 並行、同 nonce 並行及兩 agent 競爭同 wallet。CI 已配置 PostgreSQL service 並執行 `pnpm test:postgres`。

本機目前 Docker daemon 不可用，因此真 PostgreSQL 測試與 Docker image build 尚未在本機驗證；不能把新增 CI 工作宣稱為已通過遠端 CI。獨立 bundle smoke test 不需要 Docker。

下一切片：證據來源／存取權、候選 revision、規格封存、人工核准與建市 intent/outbox；之後再接 Indexer 與 RFQ／Signer。
