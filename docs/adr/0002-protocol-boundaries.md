# ADR 0002 — 固定部署身份、角色與復原邊界

狀態：採用於細部設計，待工作包A/B/C實作。日期：2026-09-22。

## 1. Market ID

上一輪DATA_MODEL將API path ID設為opaque UUID，原規格RFQ與合約則使用十進位marketId，容易使client直接把錯ID傳入calldata。

採deploymentId + decimal chain marketId對外定位；DB UUID改叫marketRecordId。單市場query與跨部署command明確帶deploymentId；不得默認換到active deployment。這是未发布骨架的設計修正，尚無API client需要migration。

## 2. 固定角色

原規格明定不可輪替。五個chain業務角色採constructor immutable address，無grant/revoke/renounceRole。Taker allowlist可由ADMIN更新，但不等於角色管理。Token faucet minter也固定；換角色需新部署。

標準ECDSA/SafeERC20等library仍使用；不為固定地址檢查引入帶動態管理入口的完整角色框架。已有介面尚無角色管理函式，因此不移除任何已發布能力。

## 3. 精確規格 bytes 與補充欄位

原規格§6要求hardDeadline未finalize則INVALID寫入MarketSpec，但§5.2 JSON模板沒有明確欄位。採v0.1.1新增固定resolutionPolicy，完整承諾此既有規則。舊v0.1原bytes/hash不覆寫，serializer只用於新檔首次產生。

這是落實既有語意的文件schema修訂，不修改payout、權限或期限。新schema尚未實作，仍需A2驗收。

## 4. Signer 的唯一性

HTTP timeout與DB lease不代表簽署未發生；sign request、artifact、economic intent、transaction nonce分別有id與唯一約束。Signer不接受任意calldata；每次重載受信intent/policy並自行編碼。廣播只使用已持久化artifact。

M0的RestrictedSigner port是概念草案，A4需以此協定取代；不保留可能允許caller自行傳授權payload的模糊空間。

## 5. Chain 觀測可撤回

v0.1可用最新canonical INCLUDED回應交易與暫時accounting，附block hash與確認層級。Reorg需先停報價，恢復受影響quote/reservation/projection後再重新開啟。只在provider實際提供finalized證據時標FINALIZED。

依原規格停報價門檻：>3blocks或>10秒未更新，任一成立。Readiness分新交易gate與救援能力；停報價不應讓keeper無法finalize。

## 6. 人工 pause 的限制

保持上一輪人工ADMIN錢包設計，公告提前時立刻停鏈下報價、通知ADMIN發鏈上pause。這無法保證同一瞬間阻止已簽quote成交；v0.1明示此延遲。

不為了補此延遲偷偷加第二ADMIN、自動無限制管理key或改合約角色。未來若需自動鏈上pause，需要另立權限設計決策。

## 7. 初期運作參數

API body64KiB、EOA wallet binding challenge5分鐘、probability6位decimal、REPLAY challenge120秒、job lease60秒/heartbeat20秒等是細部工程初值，不是新增產品保證。部署時記policy version；硬性鏈上參數與原規格不可由環境變數繞過。

外部智慧帳戶wallet驗證尚未設計；v0.1 client路徑先以EOA完成，公開接入文件必須明示限制。
