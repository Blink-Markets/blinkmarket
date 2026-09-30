# RFQ 與交易政策

責任：報價、資金預留、mandate；不託管外部 taker。

資料 ownership：rfqs / quotes / collateral_reservations / mandates / risk_reservations。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/trading/`，外部 adapter 放 `packages/adapters/src/trading/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
