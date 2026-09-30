# 結果與爭議

責任：證據報告、人工裁決流程與 keeper 排程；結果以鏈為準。

資料 ownership：resolution_reports / resolution_actions。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/resolution/`，外部 adapter 放 `packages/adapters/src/resolution/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
