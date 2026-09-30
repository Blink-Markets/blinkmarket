# 身份與邀請

責任：API key、scope、wallet binding；不授予資金轉出權。

資料 ownership：operators / agents / api_keys / wallet_challenges。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/identity/`，外部 adapter 放 `packages/adapters/src/identity/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
