# 02 — API 與資料契約

所有 endpoint prefix /v1；目前骨架仍回 501。本文件定義未來接線契約，正式 OpenAPI 由同一批 schemas 產生並驗證，不維護兩份手寫契約。

## ID / 型別 / 版本

- deploymentId：不透明 release ID；同一鏈可存在多部署。marketId：鏈上 uint256 十進位字串，從1開始。DB market UUID 叫 marketRecordId，只供內部 FK。
- GET /markets/:id 及其子路徑要求 query deploymentId；POST 相同子路徑也以 query 指定。RFQ body 及其他跨部署寫入 body 要求 deploymentId。缺少回400，與持有 quote/manifest 不一致回409 DEPLOYMENT_MISMATCH。
- GET /markets 可跨部署，回 items 各含 deploymentId/marketId/mode；accounts positions、transactions 查詢亦要求 deploymentId。未部署的 /config 回 deployment=null、tradingEnabled=false。
- 身份與業務記錄以 UUID，不把 UUID 放進鏈上 marketId。證據／candidate／forecast IDs 不要求十進位。
- 所有鏈整數／份數／微單位 wire 都是無前導零十進位字串，量級驗證到 uint64/uint256。Quote side 為 "0"/"1"，RFQ side 為 "YES"/"NO"，只在共用 mapper 轉換。
- Probability 為有限 JSON number、0..1、最多6位小數；過多精度拒絕，不默默截斷。DB NUMERIC(7,6)，定價轉整數 millionths 後計算，避免 float 的 ceil 誤差。
- timestamp JSON 使用 UTC ISO-8601 Z；供合約簽署的秒數為 decimal string。enum、金額、address、hash 皆有共享 schema。地址解析驗證後 DB 存20 bytes，hash存32 bytes，API回hex。
- 未知 body 欄位拒絕，query filter 有 allowlist；content-type=application/json；預設 body 上限64KiB。Evidence 原文透過受控 storage pipeline，不塞 POST 任意 blob。
- List 回 {items,nextCursor}；limit預設20最大100。cursor封裝排序 createdAt/id、filter hash，防串用篩選條件；依 endpoint 權限再過濾。

上一輪「opaque market ID」設計已被此部署明確的規則取代，見 ADR0002。既有 schema/clients 尚未遷移；沒有已發布 client 相容性包袱。

## 身份

API key：256-bit 隨機 secret，只顯示一次；key ID 可見、secret hash 保存，伺服器恆時比較。key 綁 operator/agent/scopes/expiresAt/revokedAt；預設有效30天、可撤銷，部署 policy 可缩短。邀請發 key 是受稽核管理操作，初期不提供公開 self-signup。

Wallet challenge：已認證 key 請求 address，伺服器產生 nonce、固定 domain、chainId84532、issuedAt、expiresAt（5分鐘）、keyId/agentId；訊息表明「只綁定身份，不授權交易／提款」。只接受伺服器保存的精確 challenge bytes。EOA簽章驗證、nonce在同交易消耗、wallet binding寫入；v0.1 外部 client採EOA，智慧帳戶驗證另行擴充。Challenge本身沒有 approve/fill 語意。

驗證 key → scope → resource owner → wallet → rate limit → idempotency → schema/use case。無效 key401、無權403；private candidate/quote不向他人揭露存在性，回404。每次冪等重送仍重新驗證當前權限，不因曾成功而繞過撤銷。

管理操作以受限 admin key/session；Web後續若使用cookie，必須HttpOnly/Secure/SameSite與CSRF。API bearer key不存公開前端bundle。鏈上 ADMIN 簽署由人的錢包完成，不把 API admin 等同鏈上簽章權。

## Idempotency

所有 POST 必須 Idempotency-Key（1..128 可列印ASCII）。scope=(operatorId, HTTP method+已解析的部署/資源路徑, key)，payload hash含正規化後全部語義 body/query。JSON key order不影響 hash；這個正規化只用於 HTTP request，不用於 spec bytes。

第一次寫 IN_PROGRESS；業務DB交易成功後保存狀態碼／回應或intent reference。相同payload完成後回原結果；處理中409 REQUEST_IN_PROGRESS + Retry-After；不同payload409 IDEMPOTENCY_CONFLICT。RFQ過期重送仍回同一份已過期quote，不自動產生新價格。

有外部副作用的 IN_PROGRESS 不以 lease 過期直接重做；由 intent/sign request/provider ID 查明。v0.1 不自動刪除 mutation keys，避免晚到重試重放。業務拒絕也保存終局結果；暫時性失敗是否可續作依 intent state，不開新意圖。

## 核心寫入

| Endpoint | Request 的業務欄位 | 成功回應 |
| --- | --- | --- |
| POST /candidates | templateId/entityId/fiscalPeriod/thresholdBps/evidenceIds/thesis | 201 candidateId/revision/state=DRAFT |
| POST /admin/candidates/:id/approve | expectedRevision/spec/budgetMicros/reason | 202 approvalId/specHash/creationIntentId/state=DEPLOY_PENDING |
| POST /admin/candidates/:id/reject | expectedRevision/reasonCode/reason | 200 candidateId/revision/state=REJECTED |
| POST /markets/:id/forecasts | horizonKey/probability/evidenceIds/rationale/agentVersion | 201 submissionId/receivedAt/windowId |
| POST /rfqs | deploymentId/marketId/side/quantity/maxCostMicros | 200 signed quote envelope |
| POST /transactions | deploymentId/txHash/action/quoteId（fill必填） | 202 trackingId/status=UNKNOWN |
| POST /markets/:id/resolution-reports | outcome/evidenceIds/reason | 202 reportId/state=RECEIVED |
| POST /faucet/claims | deploymentId | 202 claimId/intentId/state=QUEUED |

approval 的 spec 先驗證與凍結才回202；202是「已提交部署意圖」，不是鏈上市場已存在。forecast時間由DB接收當刻產生，不接受client supplied receivedAt；horizonKey={horizonType,scheduledAt}，完整唯一性還包含deployment/market。

transactions 只接受txHash提示，獨立查 RPC 的 chain/from/to/function/log；不能以使用者 body 將交易標記 INCLUDED。保護 body/query 日誌免洩敏感資料。

## RFQ envelope 範例結構

```text
{
  deploymentId, quoteId, marketId, mode,
  chainId: 84532, verifyingContract,
  domain: {name: "Blink RFQ", version: "0.1", chainId: 84532, verifyingContract},
  types: {Quote: [固定11欄位]},
  message: {marketId,specHash,maker,taker,side,quantity,priceBps,validAfter,expiresAt,nonce,epoch},
  signature,
  takerCostMicros, makerCostMicros, expiresAt,
  calldata,
  forecastSnapshotId,
  chainCursor: {blockNumber,blockHash,finality}
}
```

這是欄位示意，不是假簽章回應。所有message整數用字串。Client從固定ABI/domain重新encode/hash/recover，核對wallet/manifest/市場spec/成本/maxCost/side/quantity/expiry；不能盲送server calldata。Approve只給本筆額度；approve後quote過期需以新idempotency key重新詢價、重新確認價格。

NO_QUOTE以409回錯誤envelope，details.reason包含具體原因；明確的STALE_FORECAST/INDEXER_LAG等可直接作code，不填虛構價格。

## 讀取模型

市場詳情回 specHash/specURI/mode、storedState/effectiveState、paused、schedule、resolution、forecastSummary、costSummary、chainCursor、canTrade/reasons。reason只作當下提示，fill仍以合約驗證。

forecast窗口未截止：未認證訪客回空items+windowStatus=OPEN；認證agent只回自身，不回其他人count/平均/理由。截止後才公開，withdrawn/contaminated保留標記。

positions回yesShares/noShares、payoutMicros（未FINAL為null）、pending intents、chainCursor；UNKNOWN不加確定份數。resolution回proposal/challenge/finalization的actor/evidence/tx reference，區分proposedOutcome/finalOutcome。

GET spec傳回儲存原bytes與Content-Type application/json，ETag=specHash、不可動態重新serialize或注入欄位。Evidence metadata依accessPolicy，無全文權限只回允許摘錄及來源，不返回private object URI/presigned URL給未授權人。

## Error mapping

共通 {code,message,requestId,retryable,details}；details只含可公開資料，不回stack/provider credentials。

| HTTP | code 類別 | Client 行為 |
| --- | --- | --- |
| 400 | INVALID_REQUEST / INVALID_SPEC | 修正输入 |
| 401 / 403 | UNAUTHORIZED / SCOPE_DENIED / WALLET_NOT_VERIFIED | 重新認證或補綁定，不重送交易 |
| 404 | NOT_FOUND | 檢查部署/資源；不洩private資源 |
| 409 | IDEMPOTENCY_CONFLICT / REQUEST_IN_PROGRESS / DEPLOYMENT_MISMATCH / TX_PENDING | 核對原intent，必要時poll |
| 409 | MARKET_CLOSED / TRADING_PAUSED / QUOTE_EXPIRED / QUOTE_CANCELLED / QUOTE_CONSUMED | 停止或明確重新詢價，不盲重試fill |
| 409 | DUPLICATE_CANDIDATE / FORECAST_WINDOW_CLOSED / FORECAST_ALREADY_SUBMITTED | 保留原提交，不以新key繞過 |
| 409 | BUDGET_EXHAUSTED / PRICE_LIMIT_EXCEEDED / INSUFFICIENT_MAKER_BALANCE / NO_QUOTE / STALE_FORECAST | 等條件改變後建立新請求 |
| 429 | RATE_LIMITED | 遵守Retry-After |
| 503 | INDEXER_LAG / CHAIN_UNAVAILABLE / SERVICE_NOT_READY | 可重試讀取；寫入先查intent |
| 500 | INTERNAL_ERROR | requestId追蹤；不能推論交易失敗 |

rate limit初值沿用規格：讀60/IP/min；RFQ2/key/sec burst5，未到期quote<=5/taker；尚未到期但sign未知亦算配額。水平擴容前需同DB計數/鎖，不能每pod各給一次額度。

## Spec v0.1.1 設計

沿用v0.1欄位，增加固定 resolutionPolicy：
- hardDeadlineOutcome="INVALID"。
- unfinalizedProposalAtHardDeadline="INVALID"。
- invalidPayoutRule="HALF_PER_SIDE_NOT_PURCHASE_REFUND"。
- authorityModel="TEAM_OPERATED_WHITELISTED_ROLES"。

版本字串改 blink.market.v0.1.1；已有v0.1 fixture仍保留且不能改其hash後假稱同一文件。核准時deterministic serializer只執行一次，persist該UTF-8 bytes、keccak256、長度、schemaVersion。後續只讀原檔。沒有真實部署，M0可直接將新建市切到v0.1.1並保留舊版reader/schema測試。
