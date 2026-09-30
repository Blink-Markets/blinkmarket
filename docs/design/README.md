# v0.1 細部設計

進度更新：工作包A/M0與B/M1已完成本機實作，詳見 [交付與驗證](../M0_M1_DELIVERY.md)。下文「尚未實作」描述設計提出時的狀態；API業務接線仍未啟用。

狀態：設計基線，2026-09-22。依第一版產品規格與既有架構拆解，可作後續實作與 code review 的依據；**文件中的 API、SQL、狀態與服務協定尚未接線**。

本輪範圍是 M0/M1 的完整設計，以及 M2/M3 關鍵整合契約。前端視覺、實際公司、模型供應商、hosting、RPC 及正式角色地址不在此虛構。

## 閱讀順序

| 文件 | 要確認的內容 |
| --- | --- |
| [01 合約與帳本](01-contracts.md) | constructor、storage、權限、數學、狀態機、revert、驗收 |
| [02 API 與資料契約](02-api-contracts.md) | 身份、ID、型別、idempotency、主要 request/response、錯誤 |
| [03 資料與交易](03-data-transactions.md) | migration 分批、關鍵欄位、唯一約束、lock order、append-only |
| [04 RFQ／Signer／Indexer](04-execution-recovery.md) | 報價、簽章、重送、reservation、reorg 與恢復 |
| [05 研究與營運工作](05-research-operations.md) | evidence、候選、forecast、budget、keeper、faucet |
| [06 實作工作包](06-work-packages.md) | 開發順序、依賴、驗收案例、現有骨架差異 |

## 本輪具體決定

1. 鏈上市場一律用 **deploymentId + marketId** 定位。marketId 是合約 uint256 十進位字串；DB 另有內部 UUID，不混在公開 marketId。列表可跨部署，單一市場 API 必须明確指定 deploymentId。
2. 合約五個業務角色為 constructor 固定且不同的地址。沒有 grant/revoke/renounce role 或 upgrade 路徑；外部 taker allowlist 是另外一個可調整資料集合。
3. 合約市場生命週期、交易 receipt 狀態、quote 狀態、資金 reservation 狀態分開，不共用一個 status enum。
4. 原始 spec bytes 保存一次；為滿足原規格 §6，增加 hard-deadline fail-safe 的固定文字／機器可讀規則，使用新 schema version，不暗改 v0.1 bytes。
5. RFQ 同步取得受限簽章，簽章前已有 DB reservation；signed artifact 落庫後才回應。timeout 先對帳，不重新簽另一份 quote。
6. 一個 job 可重跑，不等於經濟意圖可以重做。intent、sign request、nonce allocation、tx attempts 分別建模。
7. 所有模型費用、maker collateral、trader notional、gas 各有獨立帳；USD micros 不和 bUSD micros 相加。
8. 新報價健康檢查與鏈上救援操作分開。停止報價仍允許核對、結果提交、finalize 與贖回。

選型修正與理由見 [ADR 0002](../adr/0002-protocol-boundaries.md)。第一版產品規格維持原檔，不在本輪改寫。上述是工程細化，未擴張到主網、多 maker、提前退出或自動裁決。

## 設計提出時的程式狀態（歷史）

本輪只新增／修正文檔，沒有改 API 行為、schema、合約或資料庫。原骨架仍回 501、tradingEnabled=false。尤其新 deploymentId 規則、spec v0.1.1、Signer intent 協定尚未寫入程式；差異逐項列在工作包，不能用設計文件宣稱它們已生效。
