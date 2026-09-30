# 市場與規格

責任：核准後凍結規格、建立市場 intent、LIVE/REPLAY 分離。

資料 ownership：market_specs / markets。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/markets/`，外部 adapter 放 `packages/adapters/src/markets/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
