# 實作進度

M0契約收尾與M1帳本已完成本機實作及驗證，詳見 [交付記錄](M0_M1_DELIVERY.md)。原始設計與工作分解在 [A–D工作包](design/06-work-packages.md)。

| 階段             | 狀態                   | 成果或下一步                                                                                                                          |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| M0 工程與契約    | 已實作，本機驗證       | schemas、v0.1.1 spec bytes/hash、manifest、ports、DB foundation migration、OpenAPI/client、CI                                         |
| M1 帳本與結算    | 已實作，本機驗證       | TestUSD/Market、EIP-712、caps、完整結算與贖回、24 個合約 tests/invariant（三位 taker、兩市場）、三種 REPLAY                           |
| M2 核心垂直流程  | 進行中：核准、單筆追蹤與 opt-in 建市輪詢 | 已有身份／證據／核准／未簽署意圖及已驗證交易的持續輪詢、重試與 reorg 撤回；待接全鏈 cursor/indexer、replacement、reservation/RFQ、signer |
| M3 Agent         | 待實作                 | allowlist fetch、discovery、雙forecaster/baseline、成本、mandate、營運工作                                                            |
| M4 產品介面      | 進行中：唯讀展示站，詳見 [交付記錄](M4_WEB_SHOWCASE_DELIVERY.md) | 七類頁面、錢包、有限approve、價格與研究機率分離、錯誤狀態                                                                             |
| M5 Sepolia Alpha | 待實作                 | 真實roles/manifest、前瞻題目、RPC與備份演練、外部使用者驗收                                                                           |

本機合約測試與 REPLAY 不是公開部署；身份功能可選啟用，但尚無 production signer／真實 indexer，不啟用 API 交易。完整 DB concurrency/recovery、provider 及正式安全檢視仍在後續驗收範圍。身份與部署基礎現況見 [M2.1 交付](M2_IDENTITY_DELIVERY.md)。

最新現況見 [建市事件追蹤](M2_CREATION_TRACKING.md) 與 [建市持續輪詢](M2_CREATION_POLLER.md)：操作員先驗證並登記建市交易，opt-in indexer 再持續檢查 receipt、確認數與 reorg。下一步：全鏈 canonical cursor 與完整 projection → RFQ reservation/signer → 交易 client。保持 REPLAY，不依賴付費模型，不自動簽署或廣播管理員交易。

核准 API 可透過 approval 模式啟用，其他模式維持原行為。真 PostgreSQL 多連線測試已於遠端 CI run 37099505426 通過（該 run 隨後因 Web build 引用錯誤失敗）；尚未對外部署，也未確認任何鏈上建市交易。
