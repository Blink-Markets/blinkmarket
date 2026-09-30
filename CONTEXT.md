# 領域語言

產品規範以 Blink_MVP_v0.1_Base_Sepolia_Spec.md 為準；架構決策位於 docs/adr/。

- **Candidate**：尚待檢查與人工核准的問題；APPROVED 不表示链上已建市。
- **MarketSpec**：人工核准後的精確 UTF-8 bytes；specHash 是 bytes 的 keccak256，不能重新 serialize 取代。
- **Market**：deploymentId + 鏈上 marketId；模式是永久 LIVE 或 REPLAY。
- **Forecast window**：market + horizonType + scheduledAt；相同 agent 只能一筆，撤回仍保留。
- **Baseline**：独立的一次單模型預測，不加入兩個平台 forecaster 的平均。
- **Quote**：maker 對指定 taker 的 EIP-712 報價；簽署不代表成交或鏈上資金保留。
- **Complete set**：一份 YES + 一份 NO，全額抵押 1 bUSD；份數為整數。
- **Reservation**：預留。分為真實研究成本、maker collateral、trader notional/gas，不能混用。
- **Projection**：由 canonical events 重建的讀取資料；不是持倉真相來源。
- **Economic intent**：一次經核准的經濟操作；交易重送或 replacement 不可建立第二次意圖。
- **Finality**：PRECONFIRMED、INCLUDED、FINALIZED 有別；unknown 不等同失敗。
- **INVALID**：YES / NO 每份各付 0.5 bUSD，不是退回購入價。
- **Signer**：隔離金鑰與 policy 的程序；API key 不授權代替外部使用者提款。
- **Public Alpha**：須滿足規格 §17.3。本 repo 已有M0/M1本機契約與帳本，尚未接線或部署公開Alpha。
