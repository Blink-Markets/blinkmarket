# 資料與證據

責任：來源擷取、不可覆寫 bytes、hash 與公開權限。

資料 ownership：evidence / source_allowlists。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/evidence/`，外部 adapter 放 `packages/adapters/src/evidence/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
