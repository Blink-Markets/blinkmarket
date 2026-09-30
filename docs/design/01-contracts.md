# 01 — 合約與帳本細部設計

依據產品規格 §5–9、§16–17。本文件是實作藍圖，現有 IBlinkMarket 仍為介面草案。

## 合約組成與部署

BlinkTestUSD 採固定版標準 ERC-20，name=「Blink Test USD」、symbol=bUSD、decimals=6。只有固定 faucet minter 可 mint，沒有 upgrade、任意管理提款、transfer fee 或 rebasing。Faucet 的 rolling 24h 限額與受邀地址限制在受限 signer policy/服務執行，不能宣稱 token 自身已提供這些限制。

BlinkMarket 預定使用經版本鎖定的 EIP712、ECDSA、SafeERC20、ReentrancyGuard；不自寫簽章驗證或 token transfer wrapper。M1 安裝時驗證所選 library/compiler 相容性，寫 lock/remapping/artifact。

Constructor 參數：
- collateral、maker、admin、resultProposer、challenger、arbiter。
- 所有地址非零；五個業務角色互異；maker 須符合部署時 EOA 要求。
- collateral 必須有 code、decimals=6；部署腳本核對它是該 release 的 TestUSD artifact，不能只因 decimals 相同就接受其他 token。
- chainId 固定 84532；本機 Foundry/Anvil 設同 chain ID。部署腳本與 constructor 均拒絕主網，無 env bypass。
- 沒有 owner 替換、角色輪替、delegatecall 或升級入口。

角色採 immutable address + 明確函式檢查，外部提供 getters。一般 AccessControl 包含動態 grant/revoke 的能力，不直接繼承其管理介面以免違反固定角色限制。[OpenZeppelin 權限文件](https://docs.openzeppelin.com/contracts/5.x/access-control)

## Storage

| 範圍 | 欄位 | 用途 |
| --- | --- | --- |
| immutable | collateral、五角色 | 固定部署邊界 |
| global | globalTradingPaused、makerFreeBalance、currentMakerEpoch、nextMarketId=1 | 交易開關、maker 可提領抵押 |
| global | usedSpecHashes[hash]、consumed[digest]、cancelled[digest] | 建市與 quote 去重 |
| global | takerAllowed[address] | 只控制新增成交 |
| market | specHash/URI、mode、四個時間欄位、caps | 建市後不可修改 |
| market | state、paused、proposedAt、proposedOutcome、finalOutcome、evidence hashes | 狀態與稽核 |
| market | totalMintedPairs、escrowMicros | 累計 complete sets 與剩餘資金 |
| market/account | yesShares、noShares、cumulativeTakerShares | 可贖回持倉與不可歸零的累計 cap |

Storage 可保留 uint64 份數／時間；乘法先提升 uint256 再算。對外 getter 回傳 proposedOutcome/finalOutcome 是否存在，不能把 enum 預設 YES 顯示成已判定 YES。內部可用 state 判斷存在性。

totalMintedPairs 與 cumulativeTakerShares 不隨 redeem 減少。market ID=0 或尚未建立 ID 一律 MarketNotFound，不靠 enum 的零值 OPEN 判斷存在。

## CreateMarket

ADMIN only；拒絕 zero/重複 specHash、空 URI、非合法 mode。時間需 now < closeAt < proposalDeadline < hardDeadline，且 hardDeadline-proposalDeadline > challengeSeconds。

LIVE challenge=86400；REPLAY 工程 profile 固定 120。maxPairs 為 1..10000，maxTakerShares 為 1..500 且 <=maxPairs；單筆 1..100 是合約常數。文字內容／來源／forecast 規則由核准 API 驗證，不能聲稱合約解析 JSON。

建立市場與 MarketCreated 同一交易完成；映射市場到不可變參數。市場開始 OPEN、unpaused、零帳本；global pause 不影響管理員建市，但影響 fill。

## Quote 簽章

Quote struct 的 11 個欄位順序與現有介面一致，不新增 deploymentId 到 typed message。deployment 身份由 domain 的 chainId/verifyingContract 承諾，API 額外比對部署 manifest。name=「Blink RFQ」、version=「0.1」。

digest = 標準 typed-data hash；maker 必須固定 EOA、signature 恢復地址相同。拒絕非 canonical ECDSA 與錯 domain。nonce 是隨機 uint256，不當作交易 nonce。Replay protection 使用 consumed/cancelled/currentMakerEpoch/期限；EIP-712 不自行提供這些保護。[EIP-712](https://eips.ethereum.org/EIPS/eip-712)

## FillQuote

全程 nonReentrant，按下列順序檢查及變更：

1. global / market 未 pause、market 存在、OPEN 且 now<closeAt。
2. q.maker=固定 maker，q.taker=msg.sender、takerAllowed=true，maker!=taker；管理／裁決角色不允許列入 taker。
3. specHash 相等、side=0/1、quantity 1..100、priceBps 1..9999。
4. totalMintedPairs+q.quantity <= maxPairs；cumulativeTakerShares+quantity <= maxTakerShares。
5. validAfter<=now<expiresAt<=closeAt，且 expiresAt-validAfter<=60。
6. epoch 相等；digest 未 consumed/cancelled；驗證 ECDSA。
7. 以 uint256 計算 notional=q*1000000、takerCost=q*priceBps*100、makerCost=notional-takerCost；free>=makerCost。
8. 設 consumed=true、扣 free、加 escrow/pairs/cumulativeTakerShares，兩方加相反份數。
9. SafeERC20.safeTransferFrom(taker, contract, takerCost)，成功後發 QuoteFilled；transfer revert 時整筆狀態回滾。

可以在 effects 前預檢 taker balance/allowance 以提供錯誤，但真實轉帳成功仍是必要條件，不把預檢當防重入。指定固定標準 TestUSD，不支援奇異 token 行為。

## 抵押與贖回

depositMaker / withdrawMaker 僅 maker，amount>0。deposit 轉入成功後累加 free；withdraw 先檢查 free，先扣帳再轉至 maker。皆 nonReentrant。沒有 beneficiary 參數、escrow rescue、donation sweep。

redeem 僅 FINAL，任何有部位呼叫者均可用，包括移出 allowlist 或 maker。不檢查 pause/交易資格。先讀取兩側，若皆零回 NoPosition；兩側歸零、算 payout、扣 escrow，再轉呼叫者。payout=0 不呼叫外部 token transfer，仍發事件且持倉歸零。

| outcome | 每份 YES | 每份 NO |
| --- | ---: | ---: |
| YES | 1000000 | 0 |
| NO | 0 | 1000000 |
| INVALID | 500000 | 500000 |

例如 100 YES @6000：taker 付60、maker 付40、escrow100。YES 時100/0；NO 時0/100；INVALID 時50/50 bUSD。Maker redeem 直接回錢包，不加 free。

## 狀態與時間边界

| 操作 | 權限／前態 | 有效時間 | 後態／結果 |
| --- | --- | --- | --- |
| proposeOutcome | proposer / OPEN | closeAt<=now<proposalDeadline | PROPOSED；evidenceHash非零 |
| challengeOutcome | challenger / PROPOSED | now<proposedAt+challengeSeconds | DISPUTED；evidenceHash非零 |
| finalizeUnchallenged | anyone / PROPOSED | challengeEnd<=now<hardDeadline | FINAL；沿用提案 evidence/outcome |
| arbitrate | arbiter / DISPUTED | now<hardDeadline | FINAL；decisionEvidenceHash非零 |
| finalizeTimeout | anyone / 非FINAL | now>=hardDeadline | FINAL INVALID；零 evidenceHash |
| redeem | 自己 / FINAL | 無期限 | 清空自己的部位 |

closeAt 當刻已不可 fill；CLOSED 是 OPEN+時間的讀取衍生態。hardDeadline 當刻只能 timeout，未及時 finalize 的未挑戰提案亦變 INVALID。暫停不阻止上述六項或 maker withdraw。

cancelQuote 僅 maker、q.maker=maker、digest 未 consumed；若已 cancelled 可冪等 no-op，不重發事件。無需 quote signature 即可取消自己對特定 payload 的未來簽章。incrementMakerEpoch 僅 maker，checked increment。

## Errors / Views / Events

建議 custom errors：UnauthorizedRole、InvalidAddress、WrongChain、MarketNotFound、InvalidSpec、DuplicateSpec、InvalidSchedule、InvalidCap、TradingPaused、MarketClosed、InvalidTaker、InvalidSide、InvalidQuantity、InvalidPrice、CapExceeded、InvalidQuoteTime、EpochMismatch、QuoteConsumed、QuoteCancelled、InvalidSignature、InsufficientMakerBalance、InvalidState、DeadlineViolation、EmptyEvidence、NoPosition。

精確 selector 在 M1 產生 ABI 時鎖定；API 映射見 02。不得將所有 revert 都變成 retryable。

保留既有 §16 events，補讀取 collateral/roles/global pause/takerAllowed/cumulativeTakerShares 的 getters。Market getter 明確拆提案與最終結果；每個 non-timeout outcome evidence 可由 state 或事件追溯。QuoteFilled 的 cost 由合約算，不接受 calldata 提供成本。

## 驗收

完整 C01–C15；另外驗證：
- constructor 相同角色／零地址／錯鏈／錯資產 metadata 拒絕，無 role mutation selector。
- 收到 donation 後只滿足 >=，無函式可把 donation 或 escrow 提走。
- cap 是累計買入，不因相反 side 或贖回繞過；maker 相反權益不套 taker cap。
- oracle/DB/keeper 全失聯，任何錢包仍可 timeout/redeem。
- ghost ledger invariant 覆蓋 token failure、reentry mock、所有 outcome、任意操作序列。
