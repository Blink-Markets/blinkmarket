# 營運與稽核

責任：工作重試、管理稽核、告警、備份與恢復。

資料 ownership：audit_log / idempotency_records / jobs / outbox。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/operations/`，外部 adapter 放 `packages/adapters/src/operations/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
