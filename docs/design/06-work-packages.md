# 06 — 開發工作包與設計檢查

進度更新（Tasks 1–16）：A/M0、B/M1 與 C/D 的多個 backend 切片已實作，尚未部署；見 [交付索引](../ROADMAP.md)。本機驗證僅 REPLAY，無付費模型，LIVE 核准仍拒絕。

本文件保留原始工作分解與設計檢查案例，不是逐項驗收記錄。C 已有 identity、候選／核准、公開讀取、indexer、RFQ/signer；D 已有研究、預算、評估、resolution、keeper/faucet。[內部 trader](../M3_INTERNAL_TRADER.md)、[SDK／example agent](../M5_CLIENT_SDK.md)、[本機 Alpha harness](../M5_LOCAL_ALPHA.md) 與 [health/metrics readiness](../M5_HEALTH_METRICS.md) 已交付，驗收對照見 [矩陣](../ACCEPTANCE_MATRIX.md)。公開部署、操作 UI、付費模型與外部驗收仍未完成，不標記整個 C/D 完成。

## A：M0 契約收尾

| ID | 修改位置 | 交付／驗收 | 依賴 |
| --- | --- | --- | --- |
| A1 | packages/schemas | 分開PublicMarketRef/DB ID；deploymentId必填；所有chain integers字串 | 無 |
| A2 | schemas + spec archive port | v0.1.1 resolutionPolicy、一次serialize/存原bytes/hash、保留v0.1 reader | A1 |
| A3 | deployment schema + local script | 真實manifest驗證chain84532/角色/addresses/hashes，TEMPLATE不可載入交易 | A1 |
| A4 | domain/ports | 分離intent、nonce、quote、reservation、sign request/result與role scopes | A1 |
| A5 | adapters/migrations | migration runner、0001、role/append-only/domain constraints測試 | A1 |
| A6 | OpenAPI schemas/client | 完整error/ID/numeric contracts與生成機制；設計中的API先標planned | A1/A2 |

A驗收：bytes多一個空白即不同hash；重serialize不是download；錯deployment/mainnet/placeholder拒絕；數字不經float；新schema和舊fixture可以明確區分。M0通過不是可交易。

## B：M1 合約

| ID | 內容 | 驗收 |
| --- | --- | --- |
| B1 | TestUSD、immutable roles、constructor、防角色輪替 | C14；零/重複地址、錯鏈/資產 |
| B2 | 市場建立、caps、pause、maker deposit/withdraw | C06/C13/C14；不能取escrow/donation |
| B3 | EIP-712、digest、fill/cancel/epoch與內部帳本 | C01–C09；exact vectors、失敗全回滾 |
| B4 | propose/challenge/arbitrate/finalize/timeout/redeem | C10–C13；每個時間邊界 |
| B5 | Foundry handler/fuzz/invariant、reference ledger | C15 + token/reentry/overflow；多seed可重跑 |
| B6 | ABI/hash生成、local REPLAY三種場景 | normal/dispute/timeout皆可成交及兩方贖回 |

B不部署Sepolia，不以演示脚本代替不變量驗收。

## C：M2 垂直交易流程

按identity/evidence/spec → manual approval intent → chain index/reorg → reservation/RFQ/signer → client交易追蹤的順序。先固定fixture，暫不依賴LLM。逐一覆蓋S01/S02/S05/S07/S08/S09/S10/S11/S12。

Signer接線以前必须通過caller隔離、錯role/chain/to/selector/gas/amount拒絕、同sign request回相同artifact。只要DB/RPC/signer未ready就保持停報價；不得用fake success adapter繞過。

## D：M3 研究與營運

先source allowlist/快照，再budget/model gateway、discovery/forecast/baseline、resolution/keeper/faucet與metrics。Provider/費率選定後鎖model/prompt/tool versions。完成S03/S04/S06及截止時間/污染/缺失檢查。

## 與原始骨架的差異清單（歷史）

以下「下一步」描述設計提出時的待辦，不能當成當前缺失；deploymentId、v0.1.1 spec、合約結果欄位、持久化 signer、chain snapshot、transaction handle、jobs lease 與 OpenAPI 已有實作。實際仍未完成的範圍見上方進度與各交付記錄。

| 現有檔案／行為 | 下一步修改 |
| --- | --- |
| schemas MarketSpec僅v0.1、缺hardDeadline fail-safe字段 | A2加入v0.1.1，原fixture不改成假LIVE |
| MarketRef.marketId未區分DB ID | A1統一chain decimal ID；DB用marketRecordId |
| IBlinkMarket.Market只有單一outcome | B4拆提案與最終結果，更新ABI前對齊API |
| RestrictedSigner收quote/intent，回artifactId而無狀態 | A4改成持久化signRequest協定，UNKNOWN明確建模 |
| ChainReader只讀balance/consumed | A4加hash定位snapshot、epoch/cancelled/市場/manifest驗證 |
| TransactionContext只有transactionId | A5 adapter私有transaction handle，不能假稱string能保證同transaction |
| Job只有attempt/nextRunAt | A4/A5加入lease owner/token/state與ACK條件 |
| OpenAPI只列501 | A6/C階段加入完整schemas/security/responses，實作前仍保留501 |
| 沒有角色/環境配置實作 | B1/A3先固定constructor/manifest；C驗證隔離再給secrets |

## 設計層檢查案例

1. 兩部署marketId同為1：查詢與RFQ必須取得各自spec/domain，不可fallback。
2. approve回202、鏈交易遺失：保持同creation intent；不產生第二market。
3. 兩筆quote爭最後抵押：同pool鎖限制reservation，合約仍核對實際free。
4. quote簽好但API timeout：重送同key取得同artifact；不加一筆quote。
5. quote到期但RPC斷線：UI過期，reservation仍HELD。
6. 已觀測fill後reorg：撤回projection及ACCOUNTED標記；重新算free/reservations後才開gate。
7. job lease過期但舊worker繼續：fencing阻擋ACK/新副作用，intent防重複。
8. 模型已呼叫但usage未知、午夜：舊日reservation保留，新日不消除question占用。
9. 無人finalize：hardDeadline起任何人可INVALID並redeem，pause與allowlist撤銷不影響。
10. 公告提前但ADMIN離線：立刻停新quote，揭露鏈上pause延遲，原signed quote按鏈序與原規則處理。
11. 同一錢包試圖用不同API key重領faucet：address guard及pending reservation仍拒絕。
12. 不完整兩模型ensemble：標缺失，不用baseline或外部模型偷偷補位。

這些是設計驗收案例，不是本文件宣稱的測試結果。已實作切片的命令、結果及限制記在各交付文件；本機整合已有 [Alpha harness](../M5_LOCAL_ALPHA.md)，其餘缺口與公開驗收見 [驗收矩陣](../ACCEPTANCE_MATRIX.md)。
