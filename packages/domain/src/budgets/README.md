# 成本與預算

責任：USD 微單位、原子 reservation、unknown cost 保留。

資料 ownership：question_budgets / daily_budgets / cost_entries。

狀態：模組位置與邊界已建立；use cases / repositories 尚未實作。

後續 domain model 放此目錄；application use case 放 `packages/application/src/budgets/`，外部 adapter 放 `packages/adapters/src/budgets/`。其他模組不得直接寫入本模組資料表，跨模組更新經 application orchestration、同一 transaction 與 outbox 完成。
