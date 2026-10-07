# 架構圖解與運行方式

先記住一句話：**鏈下系統負責研究、報價與工作協調；鏈上合約負責資金、持倉及最終結果。** 網頁不是帳本，資料庫也不能修改鏈上的持倉。

以下使用 Mermaid 圖，支援 Mermaid 的 Markdown 預覽器可直接顯示。技術細節見 [架構設計](ARCHITECTURE.md)、[細部設計](design/README.md)。

## 1. 現在已經做到哪裡？

M2 最新範圍見 [人工核准](M2_APPROVAL_DELIVERY.md#flow) 與 [建市觀測](M2_CREATION_TRACKING.md#flow-and-states)：證據與候選 → 核准／容量鎖 → 未簽署意圖 → 管理員自行送出 → 操作員觸發 receipt 驗證與確認數／reorg 觀測。錢包 UI 與持續 Indexer 尚未接線。

這張圖只畫**目前真的存在的能力**。實線代表已存在的呼叫或驗證路徑，不代表已對外部署。

```mermaid
flowchart TB
    User["開發者／本機使用者"]
    subgraph Hosts["程序骨架：身份可選啟用，其餘業務尚未接線"]
        Web["Web :3000<br/>目前回傳功能清單 JSON"]
        API["API :3001<br/>config／OpenAPI／請求格式驗證<br/>identity 模式啟用 wallet auth"]
        Other["Worker :3002／Indexer :3003／Signer :3004<br/>活性與工作分類，沒有業務執行"]
    end
    subgraph M0["M0：已實作，可獨立測試的基礎元件"]
        Schemas["schemas／client<br/>資料格式、部署清單、API 契約"]
        Adapters["adapters<br/>交易封裝、migration、規格封存、部署驗證"]
        Storage["測試用 PGlite／本機暫存物件目錄<br/>不連使用者的業務資料庫"]
    end
    subgraph M1["M1：已實作，僅本機驗證"]
        Tests["Foundry<br/>單元／fuzz／多使用者 invariant"]
        Replay["local-replay.ts<br/>啟動一次性 Anvil"]
        Contracts["BlinkTestUSD ＋ BlinkMarket<br/>抵押、成交、結算、贖回"]
    end
    User --> Web
    User --> API
    User --> Other
    API --> Schemas
    API --> Identity["M2.1 identity application<br/>key／wallet／idempotency／audit"]
    Identity --> PG[("明確設定的 PostgreSQL<br/>runtime role 無 DDL／發 key 權限")]
    NodeTests["Node 測試"] --> Adapters
    NodeTests --> Schemas
    Adapters --> Storage
    Tests --> Contracts
    Replay --> Contracts
```

Web 現在還不會呼叫 API 完成交易。API、Worker、Indexer、Signer 的 readiness 都不代表業務就緒；沒有正式部署地址、持續同步或自動簽章。M0 元件可用，但尚未串成線上產品。

身份流程與啟用方式見 [M2.1 交付](M2_IDENTITY_DELIVERY.md)。預設仍是 scaffold，不會因存在共用 DATABASE_URL 就自行連接業務資料庫。

## 2. 完整系統將如何分工？

以下是**目標架構**。所有虛線都是後續 M2/M3 要接的業務路徑；實線僅表示兩份已實作合約之間的 token 呼叫。Signer 私有隔離是部署要求，尚未落實為可用服務。

```mermaid
flowchart TB
    User["使用者／外部 agent"]
    Wallet["使用者錢包<br/>私鑰由本人持有"]
    Manual["人工管理錢包<br/>ADMIN／提案者／挑戰者／裁決者"]
    subgraph App["TypeScript／Node.js：共用程式碼，按責任拆程序"]
        Web["Web／Next.js<br/>瀏覽、研究、交易、管理畫面"]
        API["API／Fastify<br/>身份、查詢、RFQ、命令入口"]
        Worker["Worker<br/>研究、預測、背景工作、keeper 排程"]
        Indexer["Indexer<br/>事件同步、重組處理、帳本投影"]
        UseCases["Application 業務用例<br/>透過 ports 協調領域與外部系統"]
    end
    subgraph Private["私有簽署邊界：不得對公網或模型開放"]
        Signer["Signer<br/>重新驗證 intent、policy、nonce"]
        Keys["分角色私鑰<br/>maker／內部 trader／faucet／keeper"]
    end
    subgraph Data["鏈下持久資料"]
        DB[("PostgreSQL<br/>業務資料、audit、outbox、jobs、鏈上投影")]
        Objects[("物件儲存<br/>目前本機 adapter；正式目標 S3<br/>保存原始規格與證據 bytes")]
    end
    External["外部資料來源與模型 API<br/>allowlist、成本預算、輸出驗證"]
    subgraph Chain["Base Sepolia：目標部署，目前只有本機驗證"]
        Market["BlinkMarket<br/>free balance／escrow／持倉／結果"]
        Token["BlinkTestUSD<br/>6 位小數測試資產"]
    end
    User -.-> Web
    User -.-> API
    User -.-> Wallet
    Web -.-> API
    API -.-> UseCases
    Worker -.-> UseCases
    UseCases -.-> DB
    UseCases -.-> Objects
    Worker -.-> External
    UseCases -. "受限 signRequestId" .-> Signer
    Signer -. "載入意圖與政策" .-> DB
    Signer -.-> Keys
    Signer -. "簽章 artifact" .-> UseCases
    Worker -. "提交已保存的受限交易" .-> Market
    Worker -. "核准的 faucet mint" .-> Token
    Wallet -. "approve" .-> Token
    Wallet -. "fillQuote／redeem" .-> Market
    Manual -. "建市／暫停／提案／挑戰／裁決" .-> Market
    Market --> Token
    Market -. "RPC logs／state" .-> Indexer
    Token -. "RPC logs／state" .-> Indexer
    Indexer -. "事件與投影" .-> DB
```

### 功能模組不是十二個微服務

| 功能分類   | 領域模組                     | 負責什麼                                 |
| ---------- | ---------------------------- | ---------------------------------------- |
| 接入與管理 | identity、operations         | 身份、權限、audit、冪等、工作與故障恢復  |
| 研究與建市 | evidence、discovery、markets | 來源、快照、候選、人工核准、凍結規格     |
| 預測與成本 | forecasts、budgets           | 預測窗口、模型／外部預測、預算及實際成本 |
| 交易與資產 | trading、chain、faucet       | RFQ、風險預留、交易追蹤、測試幣領取      |
| 結算與評估 | resolution、analytics        | 結果建議、爭議工單、績效與品質統計       |

它們共用同一套 domain/application 程式碼，依工作型態放在 API 或 Worker；不需要替每個模組維護一套部署。Indexer 專門同步鏈，Signer 專門控制簽署風險。

程式依賴方向：`apps → application → ports/domain → schemas`，`adapters` 實作 `ports`。業務邏輯不直接依赖 Fastify、SQL 或 RPC；見 [完整依賴圖](ARCHITECTURE.md#程式依賴)。

## 3. 從題目到成交：錢何時真正移動？

以下是**目標端到端流程**；規格封存元件與合約已實作，其餘協調路徑尚未接線。

```mermaid
sequenceDiagram
    actor Admin as 人工管理者
    participant W as Worker／研究
    participant A as API／業務用例
    participant D as DB／物件儲存
    participant S as 私有 Signer
    actor T as Taker 錢包
    participant C as 鏈上合約
    participant I as Indexer
    W->>D: 保存來源證據、候選題目
    Admin->>A: 核准候選與固定規則
    A->>D: 先保存原始 spec bytes，再提交 hash／intent／audit／outbox
    Admin->>C: 自己簽署 createMarket
    C-->>I: MarketCreated 事件
    I->>D: canonical 市場投影
    W->>D: 預算預留、模型預測、窗口截止後的合格快照
    Note over A,C: Maker 必須事先 approve 並 depositMaker；報價不會在鏈上鎖定 free balance
    T->>A: RFQ：市場、方向、數量、身份與冪等 key
    A->>C: 讀同區塊市場／epoch／maker free
    A->>D: 鎖定資金池與 cursor，保存 reservation／quote draft
    A->>S: signRequestId
    S->>D: 重新載入 intent／policy／reservation
    S->>C: 重驗部署、期限與鏈上狀態
    S->>D: 保存 signed artifact
    S-->>A: artifactId
    A-->>T: EIP-712 signed quote
    T->>C: 對 token approve，並呼叫 Market.fillQuote
    Note over T,C: 合約驗簽、期限、cap、餘額；收取 taker 成本並扣除 maker free，建立完整抵押
    C-->>I: QuoteFilled 事件
    I->>D: 同一交易更新雙方持倉／資金投影／reservation／cursor
```

例：買入 **100 YES、價格 6000 bps**，taker 付 60 bUSD，maker 的 free balance 扣 40 bUSD，市場 escrow 增加 100 bUSD；taker 取得 100 YES，maker 取得 100 NO。這些份數是 `BlinkMarket` 內部帳本，不是可轉讓的 YES/NO ERC-20。

DB reservation 防止服務重複承諾額度，但不能保證 quote 一定成交。鏈上執行時仍可能因過期、cap、提款、取消或 epoch 改變而拒絕；以合約執行結果為準。

## 4. 到期後，誰決定結果？

這張圖對應**已實作的合約狀態機**。研究模型只能提出建議，沒有裁決權。

```mermaid
stateDiagram-v2
    [*] --> OPEN: ADMIN 建市
    OPEN --> PROPOSED: closeAt 後、proposalDeadline 前，人工提案
    PROPOSED --> DISPUTED: 挑戰期內，CHALLENGER 挑戰
    PROPOSED --> FINAL: 挑戰期結束且未達 hardDeadline，任何人 finalize
    DISPUTED --> FINAL: hardDeadline 前，ARBITER 裁決
    OPEN --> FINAL: 達 hardDeadline，任何人 timeout 為 INVALID
    PROPOSED --> FINAL: 達 hardDeadline，任何人 timeout 為 INVALID
    DISPUTED --> FINAL: 達 hardDeadline，任何人 timeout 為 INVALID
    FINAL --> FINAL: 各持倉人分別 redeem；已清空部位不可重領
```

| 最終結果 | 每份 YES |  每份 NO |
| -------- | -------: | -------: |
| YES      |   1 bUSD |        0 |
| NO       |        0 |   1 bUSD |
| INVALID  | 0.5 bUSD | 0.5 bUSD |

LIVE 挑戰期為 86400 秒，REPLAY 為 120 秒。`closeAt` 到後不能再成交；即使交易暫停或 taker 被取消交易資格，既有持倉仍可依規則結算、贖回。Maker 贖回所得回到錢包，不自動成為新的 free balance。

## 5. 為什麼需要 Indexer？故障後如何恢復？

以下是**後續要實作的同步流程**。鏈是資金與結果的真相來源；DB 的投影讓 API 快速查詢，也可在事故後重建。

```mermaid
flowchart TD
    Start["啟動：關閉新報價 gate"] --> Verify["驗證 deploymentId／chainId／code／角色<br/>deploymentBlock 必須是安全重播下界"]
    Verify --> Cursor["載入可信 checkpoint<br/>沒有 checkpoint 則從 deploymentBlock 開始"]
    Cursor --> Header["取得下一段區塊與指定合約 logs"]
    Header --> Parent{"parent hash 與 cursor 相符？"}
    Parent -- "是" --> Apply["同一 DB transaction<br/>保存事件、更新投影與 cursor"]
    Apply --> Reconcile["同區塊核對 free／escrow／持倉<br/>對帳 quote／交易／reservation"]
    Reconcile --> Fresh{"同步新鮮且對帳完成？"}
    Fresh -- "是" --> Ready["允許新的 RFQ"]
    Ready --> Header
    Fresh -- "否" --> Closed["保持 gate 關閉<br/>保留未決風險，不盲目重送"]
    Closed --> Header
    Parent -- "否：reorg" --> Reorg["關 gate、找共同祖先<br/>標記舊事件 noncanonical 並保留"]
    Reorg --> Rebuild["由可信 checkpoint／安全起點<br/>重建投影並重播新分支"]
    Rebuild --> Reconcile
```

最新 head 落後超過 3 blocks，**或**超過 10 秒未成功更新，任一成立就停止新報價。簽署或送交易逾時不等於失敗；到期也不能只看本機時鐘就釋放 reservation。跨越已 finalized checkpoint 的矛盾要停下來人工調查。

此次修正保護了三個基礎環節：

- DB 的 `COMMIT` 若實際回覆 `ROLLBACK`，用例必須失敗，不能回報成功。
- 本機物件先寫完整暫存檔，再原子發布 hash 路徑；並行操作不會讀到發布中的半份內容。
- 部署驗證會檢查 `deploymentBlock - 1` 時兩份合約均尚無 code，避免未來從過晚的起點漏同步事件。

## 建議閱讀順序

先看本頁第 1、2 圖掌握現況與目標，再看第 3、4 圖理解交易與結算；要實作下一階段時，再讀 [工作包](design/06-work-packages.md) 與 [恢復細節](design/04-execution-recovery.md)。
