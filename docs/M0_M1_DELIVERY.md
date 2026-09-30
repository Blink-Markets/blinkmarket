# M0 / M1 交付與驗證

M0 契約收尾與 M1 帳本已實作於本機；沒有部署外部鏈，也未啟用 API 業務 handler。原產品規格不變。詳細設計的後端業務接線屬 M2/M3。

## M0 工作包

| 工作 | 已交付 |
| --- | --- |
| A1 | PublicMarketRef 必填 deploymentId、十進位 chain marketId；MarketRecordId 為內部 UUID brand；uint64/256 範圍檢查 |
| A2 | v0.1.1 resolutionPolicy、保留 v0.1 reader、deterministic 一次編碼與 keccak256、讀原bytes驗hash、local object store 暫存完成後原子發布 |
| A3 | 非placeholder manifest schema、鏈ID/部署ID/角色檢查、offline validator；read-only RPC verifier 核對同區塊 code/ABI hashes、roles、asset、caps、安全重播下界，重組即拒絕 |
| A4 | economic intent / nonce allocation / quote / reservation / sign request/result、caller scope 型別；chain hash snapshot、queue fencing ACK、opaque transaction handle |
| A5 | PostgreSQL migration runner + checksum/advisory lock/transaction，0001 domains/roles/audit/idempotency/outbox/jobs；UnitOfWork 綁定真實 connection |
| A6 | 22 個業務 endpoint 的共用 request/response schemas、OpenAPI生成、decimal/ID/error契約、client schema validation；API malformed400、有效但未接線501 |

Int domain 使用 NUMERIC 加整數/uint256 CHECK，而非 NUMERIC(78,0) 自動把小數四捨五入後才檢查；這能明確拒絕 1.5。概率限制6位小數，不用浮點金額。

新規格 freeze 接受 v0.1.1；v0.1仍可讀驗。LIVE placeholder、過期closeAt拒絕；來源是否真正官方、公司allowlist與人工核准仍需M2用例，schema不取代這些判斷。

## M1 工作包

| 工作 | 已交付 |
| --- | --- |
| B1/B2 | BlinkTestUSD固定minter、BlinkMarket五個固定且不同角色、主網拒絕、建市/caps/pause/allowlist/maker抵押 |
| B3 | 標準 EIP-712/ECDSA、整筆YES/NO成交、consumed/cancelled/epoch、兩方相反份數、全額抵押 |
| B4 | proposal/challenge/arbitrate、permissionless finalization/timeout、YES/NO/INVALID贖回、獨立proposed/final outcome |
| B5 | 行為/fuzz/adversarial測試、ghost ledger stateful invariant、固定seed重跑及每run最終清算 |
| B6 | 生成ABI/bytecode與hash；一次性Anvil正常/爭議/逾時重播，TS/合約digest一致、兩方贖回後escrow=0 |

編譯器/依賴：solc0.8.30、OpenZeppelin5.6.1、Foundry1.7.1、viaIR、optimizer200、Cancun。版本與lockfile已保存。標準函式庫提供簽章/token呼叫機制，不代表Blink本身已完成安全審計。

## 驗證命令

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:contracts
pnpm test:contracts:seeds
pnpm replay
pnpm api:spec
pnpm build
```

Review 修正後：TypeScript 與基本依賴方向檢查通過；14 個 Node tests 通過；24 個 Foundry tests/invariant 通過。三個 fuzz test 各 256 cases，stateful invariant 每次 128 runs × 64 calls；額外固定 0x01/0x02 各 8192 calls 與多使用者 settlement fuzz 通過，每 run 結束清算所有剩餘部位。

PGlite 測試使用真正的 PostgreSQL engine（WASM 單 session）：實測 migration 重跑、checksum 不一致拒絕、最大 uint256 精度、小數/負數/overflow 拒絕、角色無 DDL 與 audit 修改權、trigger 拒絕 truncate；並驗證 UnitOfWork 捕捉 SQL 錯誤後的隱式 ROLLBACK 必須回報失敗，以及 savepoint 恢復後可正常 COMMIT。**未測正式 PostgreSQL 多 connection／部署環境**；連線生命週期另以 fake pool 測試，M2 需加真實 DB 併發 race/recovery 驗收。

部署驗證器的錯 code/role/ABI/reorg 測試使用 mock RPC；新增部署起點過晚、兩份合約不同部署高度、genesis／提前起點、未來區塊及歷史 state 無法查詢的案例。沒有任何真實 Sepolia deployment 可驗證。Local replay 以真實 Anvil EVM 與本次編譯 bytecode 運行，資產 metadata、typed digest、交易 receipt 及持倉／escrow 均查鏈斷言。

本機 object store 實際磁碟測試：16 個並行 writer 寫入相同 1 MiB 內容，每次成功後立即讀回驗證；另模擬遺留半份 staging 檔，確認重試不受影響，既有損壞 final object 不會被覆寫。未做程序 kill／斷電故障注入。

| REPLAY | 最終結果 | Taker payout | Maker payout | 剩餘escrow |
| --- | --- | ---: | ---: | ---: |
| normal | YES | 100 bUSD | 0 | 0 |
| dispute | NO | 0 | 100 bUSD | 0 |
| timeout | INVALID | 50 bUSD | 50 bUSD | 0 |

每場皆100 YES@6000bps，taker支付60、maker抵押40。Report和spec bytes輸出contracts/artifacts，明示LOCAL_REPLAY_ONLY；程序結束後測試鏈銷毀，地址不可當正式部署地址使用。

## C01–C15 對應

- C01/C02：yesAccounting/noAccounting與整數cost fuzz。
- C03/C04：wrongPayloadAndDomain、consumedCancelledEpoch、high-s簽章拒絕；本機TS digest交叉核對。
- C05/C06：quoteBoundaries、badAmountsCapsAndLifetime、跨帳戶market cap、累計兩側份數。
- C07/C08/C09：balance/allowance與惡意token rollback、competingQuotes、cancel/fill先後與epoch。
- C10/C11/C12：三outcome fuzz、雙側redeem、三種非FINAL timeout、proposal/challenge/hardDeadline邊界。
- C13/C14：global/market pause、撤銷allowlist後拒新成交但可贖回、權限矩陣、錯鏈/資產/角色、donation不可提領。
- C15：三位 taker 加 maker、兩個市場的獨立 ghost free/pairs/positions/cumulative/wallet 帳本；每 run 先建立每位 taker 的雙側部位，再隨機交錯 deposit/fill/cancel/epoch/pause/time/outcome/redeem/donation。核對每人累計 cap、跨使用者市場 cap、所有未贖回部位、錢包餘額與含 donation 的完整資金守恆，最後全清算。新增 256-case fuzz，抽樣四人 24 種贖回排列與 YES/NO/INVALID 結果，每次贖回後核對帳本並拒絕重複領取；fill/deposit/withdraw 不再 catch-all 吞掉非預期錯誤。
- 附加：reentry確定回ReentrancyGuard錯誤，轉帳失敗時redeem/withdraw狀態回滾，mint權限與不存在市場拒絕。

## 實作限制與下一階段

沒有認證、服務端reservation/quote策略、indexer同步、production signer、S3、LLM、產品UI或公開交易。TypeScript ports/scopes是接線契約，不是已落實的network/security isolation。Client requestQuote只驗證wire schema，不提供自動執行交易；M2應在送單前核對manifest/signature/calldata/policy。

FileObjectStore提供本機put-if-absent與hash核對，不提供雲端WORM或抵抗檔案owner竄改的保證；篡改會在讀取時被偵測。DB immutable audit是runtime role/trigger保護，DB owner依然屬受信任管理者。

Review 三項 P2 已修正：UnitOfWork 檢查 COMMIT command；object store 使用同 filesystem 暫存檔、file sync、hard link 不覆蓋發布與目錄 sync；deploymentBlock 為 inclusive 安全重播下界，驗證其前一區塊兩地址均無 code。異常退出可能留下 `.pending-*` 孤立目錄，不污染正式 hash 路徑；已存在的損壞正式檔案仍 fail closed，需人工調查，不自動覆寫。歷史 RPC 要求與起點定義見 [營運說明](OPERATIONS.md)。

整個repo目前尚無初始Git commit，因此不虛構release gitCommit或正式manifest。下一階段為M2：身份、業務表、outbox、spec保存接API、鏈上索引及RFQ reservation；本輪沒有進行外部部署。
