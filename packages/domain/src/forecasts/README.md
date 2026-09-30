# 預測與基準

責任：兩個內部 forecaster、獨立 baseline、外部 agent、窗口封存。

資料 ownership：forecast_windows / forecasts / model_runs。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/forecasts/`，外部 adapter 放 `packages/adapters/src/forecasts/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
