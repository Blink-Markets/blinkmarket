# 品質與統計

責任：Brier、缺失率、成本與採用統計；排除 INVALID 評分。

資料 ownership：evaluation_runs / score_entries。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/analytics/`，外部 adapter 放 `packages/adapters/src/analytics/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
