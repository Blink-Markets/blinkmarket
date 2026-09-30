# 鏈上追蹤與投影

責任：canonical events、reorg 回退、reconciliation、交易狀態。

資料 ownership：deployments / chain_transactions / chain_blocks / chain_events / positions_projection / chain_cursors。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/chain/`，外部 adapter 放 `packages/adapters/src/chain/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
