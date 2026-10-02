# 實作進度

M0契約收尾與M1帳本已完成本機實作及驗證，詳見 [交付記錄](M0_M1_DELIVERY.md)。原始設計與工作分解在 [A–D工作包](design/06-work-packages.md)。

| 階段             | 狀態                   | 成果或下一步                                                                                                                          |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| M0 工程與契約    | 已實作，本機驗證       | schemas、v0.1.1 spec bytes/hash、manifest、ports、DB foundation migration、OpenAPI/client、CI                                         |
| M1 帳本與結算    | 已實作，本機驗證       | TestUSD/Market、EIP-712、caps、完整結算與贖回、24 個合約 tests/invariant（三位 taker、兩市場）、三種 REPLAY                           |
| M2 核心垂直流程  | 進行中：身份、證據與候選已實作 | 已有邀請 key／wallet binding／證據封存與權限／候選修訂及拒絕／冪等與 audit；待接 spec/approval intent、indexer/reorg、reservation/RFQ、signer |
| M3 Agent         | 待實作                 | allowlist fetch、discovery、雙forecaster/baseline、成本、mandate、營運工作                                                            |
| M4 產品介面      | 待實作                 | 七類頁面、錢包、有限approve、價格與研究機率分離、錯誤狀態                                                                             |
| M5 Sepolia Alpha | 待實作                 | 真實roles/manifest、前瞻題目、RPC與備份演練、外部使用者驗收                                                                           |

本機合約測試與 REPLAY 不是公開部署；身份功能可選啟用，但尚無 production signer／真實 indexer，不啟用 API 交易。完整 DB concurrency/recovery、provider 及正式安全檢視仍在後續驗收範圍。身份與部署基礎現況見 [M2.1 交付](M2_IDENTITY_DELIVERY.md)。

證據與候選現況見 [M2.2a 交付](M2_PREPARATION_DELIVERY.md)。下一步：spec／人工核准與建市 intent/outbox → indexer/reorg → RFQ reservation/signer → 交易 client。保持固定 REPLAY、不依賴付費模型。
