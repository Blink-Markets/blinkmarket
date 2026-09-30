# 測試資產

責任：邀請地址額度、mint intent 與 gas 限制。

資料 ownership：faucet_claims。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/faucet/`，外部 adapter 放 `packages/adapters/src/faucet/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
