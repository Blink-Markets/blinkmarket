# 03 — 資料與交易細部設計

採明確SQL migrations + pg adapter。以下是 migration 藍圖，非已執行DDL。完整table inventory見 ../DATA_MODEL.md。

## Migration 批次

| 批次 | 內容 | 完成標準 |
| --- | --- | --- |
| 0001 | schemas、uint256/address/hash domains、migration role/runtime grants、operations基礎 | 全新DB建立、overflow拒絕、runtime無DDL權 |
| 0002 | operators/agents/keys/challenges/bindings、evidence/allowlists | secrets不可公開、nonce一次性、FK正確 |
| 0003 | candidates/revisions/specs/approvals/creation_intents、markets/active_slots | revision不可覆寫、重複核准與容量併發正確 |
| 0004 | forecast_windows/submissions/annotations、model_runs、budgets/cost reservations | duplicate/window/多worker預算race tests |
| 0005 | deployments/blocks/events/cursors、economic_intents/nonce_allocations/tx_attempts/positions | reorg/replace/unknown可保留歷史 |
| 0006 | rfqs/quotes/collateral & risk reservations、sign_requests/artifacts | atomic reserve、同intent只產生一份有效artifact |
| 0007 | resolution/faucet/evaluation read models、indexes/permissions收尾 | 恢復重建與公開資料過濾 |

0003使用deployment UUID registry先建立deployment基礎表，0005補artifact/cursor細節；FK不得指向尚未存在table。Migration按單一版本序列執行，不由五個service各自開機跑DDL；執行器持advisory lock，成功寫migration checksum。失敗回滾該批，非transactional DDL需另批明示。

## 共用型別與欄位

UUID由application生成；時間TIMESTAMPTZ，created_at預設DB現在時間。uint256 NUMERIC(78,0)加範圍CHECK；shares按uint64再限cap；cost USD/bUSD分column/unit，不共用無單位amount。address BYTEA長度20、hash BYTEA長度32。JSONB僅版本化payload與外部回應，關聯用FK/link table。

每個mutable projection有version bigint作CAS；chain projections附as_of_block_hash。append-only row不附last-write-wins updated_at，註記放新事件。

## 關鍵記錄

| Table | 核心欄位 | Unique / 特殊約束 |
| --- | --- | --- |
| approvals | id,candidate_id,revision,spec_hash,actor_id,reason,budget_id | candidate+revision唯一；核准記錄不改 |
| market_creation_intents | id,approval_id,deployment_id,state,tx_intent_id | approval+deployment唯一 |
| active_market_slots | deployment_id,mode,entity_id,fiscal_period,canonical_key,approval_id,released_at | 未釋放的mode/entity/period唯一；LIVE容量鎖全域 |
| forecast_annotations | submission_id,kind,reason,observed_at,actor | 追加事件，不UPDATE forecast |
| economic_intents | id,deployment_id,kind,actor,resource_id,payload_hash,state | 業務dedupe_key唯一 |
| nonce_allocations | chain_id,sender,nonce,intent_id | chain/sender/nonce唯一；intent的replacement共用此row |
| tx_attempts | id,allocation_id,tx_hash,raw_artifact_ref,replacement_of,status | chain/tx_hash唯一；同nonce允许多attempt |
| maker_pools | deployment_id,maker,balance_micros,cursor_hash,version,trading_gate | deployment+maker唯一；quote/reconcile共用row lock |
| collateral_reservations | id,intent_id,quote_digest,amount_micros,state,accounted_cursor | intent唯一；digest可在簽前NULL |
| sign_requests | id,principal,role,intent_id,request_hash,policy_version,state | role+intent+artifact_version唯一 |
| signed_artifacts | id,sign_request_id,artifact_hash,encrypted_bytes,created_at | request唯一；回傳前persist |
| outbox | id,event_type,aggregate_id,event_version,payload,dispatched_at | aggregate/event_version/type唯一 |
| jobs | id,outbox_id,type,dedupe_key,state,attempt,lease_owner,lease_until,lease_token | dedupe_key唯一；lease_token遞增 |
| idempotency_records | operator_id,endpoint_scope,key,payload_hash,state,response_ref | scope key唯一，不自動過期重用 |

四種語意不要混：economic intent唯一性、nonce slot唯一性、signed artifact唯一性、tx hash唯一性。只在transactions表對nonce設唯一會丟掉replacement；完全不鎖nonce則會兩個intent抢同一slot。

## 鎖定順序

單DB READ COMMITTED + 顯式row/advisory locks + UNIQUE作最後防線。涉及phantom count不能只 SELECT COUNT，必須鎖其共同父record。服務重啟／擴容仍使用同一鎖鍵。

固定先後順序：
1. idempotency record。
2. scope guard：deployment gate/LIVE capacity/agent wallet綁定等。
3. budget day → question，或 maker pool → taker quote quota，或 agent mandate day → open exposure。
4. resource record（candidate/window/quote/intent，按UUID排序）。
5. reservation/sign request/nonce slot（涉及同sender須先sender allocation guard）。
6. audit/outbox append。

同一次交易只用需要的集合；跨流程必須遵守相對順序。Chain reconcile鎖deployment gate → maker pool → reservation/projections，不能反向由quote取得pool。DB call內不發RPC、LLM或簽章。

PostgreSQL仍可能偵測deadlock；40P01/40001只在整個DB交易尚未對外產生副作用時最多重試2次、短隨機退避。外部操作後先查intent。[PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)

## 交易 recipe

**ApproveCandidate**：以out-of-transaction準備並保存spec immutable object；transaction鎖capacity/active slot/candidate，驗expectedRevision、validation version及預算，insert approval/spec ref/creation intent/slot/audit/outbox。衝突回409。不可因API202即建立有chain ID的market row；MarketCreated後才連結。

核准後若要修改，新增revision，禁止把已授權舊建市tx和新revision同時送出。已有signed/submitted/unknown舊intent時先查鏈；確定未成功且不再可執行才取消slot。難以確認時維持pending，不讓修訂產生重複市場。

**SubmitForecast**：鎖window（與close worker相同鎖）、DB clock檢查open<=now<deadline、insert forecast+evidence links+audit；unique(window,agent)拒絕同agent其他key補發。不接受等待鎖之前的now，避免排隊穿過截止。

**ReserveCost**：lock day+question，used=spent+all outstanding reservations；最壞上限available足夠才reserve。未知費用是reservation的子狀態，不再加一次unknown造成雙重計數。

**ClaimJob**：短transaction用SKIP LOCKED領取到期工作，increment fencing lease_token；commit後跑handler。ACK只接受同token且仍有效的owner。Lease失效的舊worker不可再寫結果；副作用由獨立intent/sign request去重，不依賴lease保證exactly-once。

**Outbox**：dispatcher在同DB transaction建立dedupe job與標dispatch；crash前後最多重跑相同job，不會只標dispatch而漏job。

## 保存與權限

api/worker/indexer/signer不同DB users，沒有migration權。DB credentials不是在.env共用。audit、forecast、revision、cost entry、approval僅INSERT/SELECT；註記另外存。mutable狀態表與append-only事件同transaction更新。

signed raw tx可被重播，視為敏感artifact；maker quote只提供所屬taker/admin；不寫general log或公開bucket。原始模型/證據受授權來源限制。錯誤detail清洗，last_error存代碼與requestId，不存整包provider response。

資料保留：Alpha期間不自動purge業務/chain歷史；API secret只hash、signer key不入DB。每日備份與恢復驗收包含outbox pending、unknown cost、未決nonce及reorg markers。
