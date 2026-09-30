# 候選研究

責任：掃描、GM_LT_V1、驗證、修訂與人工審查。

資料 ownership：candidates / candidate_revisions。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/discovery/`，外部 adapter 放 `packages/adapters/src/discovery/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
