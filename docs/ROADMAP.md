# 實作進度

M0契約收尾與M1帳本已完成本機實作及驗證，詳見 [交付記錄](M0_M1_DELIVERY.md)。原始設計與工作分解在 [A–D工作包](design/06-work-packages.md)。

| 階段 | 狀態 | 成果或下一步 |
| --- | --- | --- |
| M0 工程與契約 | 已實作，本機驗證 | schemas、v0.1.1 spec bytes/hash、manifest、ports、DB foundation migration、OpenAPI/client、CI |
| M1 帳本與結算 | 已實作，本機驗證 | TestUSD/Market、EIP-712、caps、完整結算與贖回、24 個合約 tests/invariant（三位 taker、兩市場）、三種 REPLAY |
| M2 核心垂直流程 | 待實作 | auth、業務表/outbox、spec API、indexer/reorg、reservation、RFQ、實際signer接線、外部client |
| M3 Agent | 待實作 | allowlist fetch、discovery、雙forecaster/baseline、成本、mandate、營運工作 |
| M4 產品介面 | 待實作 | 七類頁面、錢包、有限approve、價格與研究機率分離、錯誤狀態 |
| M5 Sepolia Alpha | 待實作 | 真實roles/manifest、前瞻題目、RPC與備份演練、外部使用者驗收 |

本機合約測試與REPLAY不是公開部署；尚無auth/production signer/真實indexer，不啟用API交易。完整DB concurrency/recovery、provider及正式安全檢視仍在後續驗收範圍。

下一步依M2垂直切片推進：先身份與業務資料，再indexer/spec，再RFQ reservation/signer，最後接client。先以固定REPLAY重現，保持不依賴付費模型。
