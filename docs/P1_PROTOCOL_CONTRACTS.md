# P1 自治協議合約交付

P1 提供 agent 自助運作的鏈上協議：身份與角色押金、建市挑戰、多 maker RFQ、完整抵押、分層結算、信用、Juror 押金與治理、自助 faucet。既有 v0.1 合約與鏈下服務仍保留；本階段沒有部署、簽署或廣播交易。P2 才接部署工具、正式參數、API／adapters／indexer 與新 ABI；P3 才提供自治 agent 演練。

## 合約與部署順序

所有 constructor 限定 Base Sepolia（84532）。先部署 `BlinkFaucet`（內部建立未修改的 `BlinkTestUSD` 與 `BlinkToken`）、`FixedPriceSource` 及使用 timestamp 快照的 `BlinkGovernor`。faucet 是兩種測試資產的 immutable minter。

每一世代先預測同一 deployer 的四個 CREATE 地址，再依 nonce 順序部署：

| 順序 | 合約 | 職責 |
| --- | --- | --- |
| n | `BlinkRegistry` | 身份、bUSD 角色押金、退出鎖、信用與前世代匯入、部署時固定的 Params |
| n+1 | `BlinkJurors` | 平台幣押金快照、冷卻退出、vote locks、slash／reward、bUSD 七日串流 |
| n+2 | `BlinkMarkets` | 題目模板、建市窗口與押金、maker 抵押、EIP-712 RFQ、費用、持倉與贖回 |
| n+3 | `BlinkResolution` | 提案、建市／結果挑戰、commit/reveal、上訴、逐票結算與 hard deadline |

每個 constructor 檢查自身預測地址，跨合約權限固定於 constructor。沒有 owner、admin、pause、initializer、bind 或 upgrade。結算 hooks 僅允許同世代 resolution 呼叫。治理只能提案 `adoptSuccessor`，通過並等待 adoption delay 後採用下一世代 registry，不能改舊市場規則、結果或託管資產。事故時平台能停止 API 轉發、公告與發布新世代，無法暫停鏈上合約。

## 參數與資產單位

`Params` 存於 registry，部署後沒有 setter；改經濟參數就要部署新世代。測試值在 `ProtocolBase.defaultParams()`，不代表正式參數。bUSD 為 6 位小數、每對完整 YES／NO 以 `UNIT = 1_000_000` 完整抵押；平台幣為 18 位小數。BPS 分母為 10,000。

| 參數群 | 意義 |
| --- | --- |
| `registrationFee`、`minRoleStake`、`roleExitCooldown` | 不退還的註冊費、各業務角色 bUSD 最低押金與退出冷卻；有未完成義務不能提款 |
| `feeBps`、五種 `*ShareBps`、`keeperTipBps` | taker 付款手續費；treasury／creator／resolution／juror／bounty 五份合計 10,000；keeper tip 從 resolution 份額扣除，分配捨入餘額歸 treasury |
| `creationBondBps`、`proposerBondBps`、`challengeBondBps`、`jurorBondCutBps` | 押金以固定的 `maxPairs × UNIT` 計，不隨成交或未平倉量下降；losing bond 的 juror cut 以 bUSD 支付，上訴押金逐次加倍 |
| `maxCreditDiscountBps`、`creditDiscountStepBps`、`creditMultiplierStepBps`、`maxCreditMultiplierBps`、`creatorExposureMultiple` | 信用折扣有下限、放寬 creator 曝險；信用不放大投票權重、不直接發錢 |
| `creationWindow`、`firstUseExtraWindow`、`resultChallengeWindow`、`minResultChallengeWindow`、`challengeWindowStepSeconds` | 三類題目的建市與結果挑戰窗口；未通過審查的模板每個市場都有額外窗口；提案時信用決定該次結果窗口 |
| `commitSeconds`、`revealSeconds`、`appealSeconds`、`maxRounds`、`quorumBps` | commit／reveal／上訴期限；最多四個上訴層級；tie 或無 quorum 在同層重開，`currentRound` 包含重開，`appealRound` 只計上訴 |
| `nonRevealSlashBps`、`incoherentSlashBps`、`roleSlashBps`、`jurorUnstakeCooldown` | 未揭票、非一致投票與敗方業務押金的處罰；Juror 退出冷卻與 vote unlock 條件 |
| `securityMultipleBps`、`maxMarketPairs`、`maxTakerShares`、`maxFillShares` | 建市／退出時的全域安全倍率、各市場／taker／成交上限；`openPayoutTotal × securityMultipleBps <= attackCostMicros × 10000` |
| `creditHalfLife`、`creditUnitMicros`、`creditGainCap`、`creditLossMultiplier` | 以已定案最大賠付計信用，限制每次增益、按期減半並加重損失；不以成交量計分 |
| `classCCreditThreshold`、`roundCreditThreshold`、`phaseInFinalizedMarkets` | C 類建市及各上訴層級的信用門檻；世代完成指定數量市場後啟用 |
| `importDiscountBps`、`replayAllowed` | 前世代信用折扣匯入與部署層級 REPLAY 開關 |

`attackCostMicros` 是有效 Juror 總押金按價格折成 bUSD 後的一半。測試預設價格為每平台幣 1 bUSD、安全倍率 20,000；1,000 枚押金提供 500 bUSD attack cost，因此當下全域 open payout 上限為 250 bUSD。slash 可令這項關係暫時失效，見下方限制。

投票權重是 `min(snapshot stake, 目前 active stake + pending unstake)`；信用只作門檻，不放大權重。快照使用回合開始前一秒，晚加入的押金不算該回合。建市 spec hash 依 creator 去重，不讓其他地址先占同一題目的 hash。

## 信任假設

「在公開列出的假設下，誠實是可證明的最佳策略」。最終安全假設是**快照內的可罰沒 Juror 押金為誠實多數**；押金無法無條件防止場外賄賂或 sybil。需要抗短期操縱、保守的平台幣價格，以及足夠的平台幣價值與流動性。攻擊會傷害市場信任與所押平台幣價值，是經濟假設，並非本機測試證明的價格保證。冷啟動押金少時，市場容量也必須小。詳見[核准設計 §5.12](superpowers/specs/2026-10-23-autonomous-market-design.md#512-信任假設必須公開寫明決定)。

## 測試網範圍

每地址每 24 小時可自助領取 1,000 bUSD 與 1,000 枚平台幣；地址可大量建立，faucet 不是抗 sybil 的資產發行。`FixedPriceSource` 是 immutable 固定測試價格，沒有真實流動性或抗操縱市場報價；測試幣沒有真實價值。尚未進行外部安全審計或主網經濟校準。

## 已知限制

- timeout 前已 slash 的平台幣及分配捨入餘額可能留在 `jurors.undistributedSlashed`，沒有回收政策（Task 7 minor #4）。測試確認保留資產仍足額。
- 每個 vote 的 slash／reward／信用／unlock，以及每個市場的 fee distribution，都需要 permissionless keeper 交易；沒有平台特權 keeper 自動代辦。先結算同層所有 loser，再處理 coherent claims；已提早結算的最後回合 vote 需在定案後再領信用。
- R17 只在 `createMarket` 與 `requestUnstake` 檢查全域安全界線；slash 不能被拒絕，可能令 attack cost 暫低於 open payout 所需值，直到市場關閉。invariant 檢查這兩種操作成功後沒有越界，沒有宣稱 slash 後仍永遠成立。
- 精確 YES／NO 平手會重開，已揭票者不受 slash；約 50% 押金集團可持續拖延至 hardDeadline，再由 `finalizeTimeout` 成為 INVALID。challenger-side bonds 仍被沒收；未改 tie rule（minor #7／R38）。
- quorum 使用 committed weight，包含已 commit 卻未 reveal 的押金；non-revealing whale 可替少數已揭票者湊足 quorum，之後才受 slash（minor #2）。
- sybil 自我爭議仍可付出 losing bond cut／role slash 來替其他地址累積信用；註冊費與不同地址不等同可信身份（minor #5）。
- 重開／上訴的快照是呼叫當下前一秒；呼叫者可在允許時間內選擇快照時機（minor #3）。
- 建市挑戰成立時，held creator bond 依 R9 付給原 challenger，challenger-side appellant 不分這筆 creator bond（minor #1）。
- 衝突檢查使用當下持倉；本版持倉不能轉移、FINAL 前不能 redeem，爭議時也不能再 fill，所以無法靠移轉或提早贖回規避（minor #6）。未來若加入轉倉，必須重審。
- `previousRegistry` 被信任為部署時指定的合約；部署者應使用治理已採用的世代並核對地址。信用匯入本身不查治理投票。
- 零 Juror stake 時的 reward notify，以及 stream 經過零 stake 的時間，歸 treasury（R21），不贈送給下一位 staker。七日串流仍有整數捨入。
- maker credit 延至 P2；現有鏈上訊號無法可靠區分 wash trading。P1 的成交量不增加 creator／maker／taker 信用。

## 驗證

所有多合約新測試使用 `ProtocolBase.deployGeneration`，連接四份真實合約。只有 token callback 對抗測試替換 collateral。lifecycle 包含兩 maker 正常成交與全額 faucet 對帳、爭議上訴、建市挑戰成立、hard deadline INVALID、治理採用真實第二世代與非零信用匯入，以及建市爭議逾時／駁回後的 creator FINAL 帳務。

`ProtocolInvariantTest` 以獨立 ghost ledger 追蹤兩市場的 escrow、maker free、fees、creation／proposal／challenge／appeal bonds 與各地址持倉，並檢查 Juror token 及 bUSD reward 償付能力。隨機呼叫包含註冊、stake／unstake、建市、成交、提案、挑戰、commit／reveal、重開、逐票結算、上訴、時間推進、定案、分潤、贖回與領報酬。每輪結束強制定案、贖回與 vote unlock，避免只測未結清狀態。

對抗測試覆蓋五個 token callback 路徑與 transfer failure rollback、白洗身份、51% 押金攻擊的淨 bUSD 收益界線，以及上列 Task 7 minor #1–#7。ABI 測試依 R6 掃描 privileged function names；Governor 既有測試已拒絕自身 `setVotingDelay` 等設定提案。

```sh
pnpm test:contracts
pnpm test:contracts:seeds
node --import tsx --test tests/protocol-artifacts.test.ts
pnpm check:contracts
pnpm check:boundaries
```

2026-10-24 本機實測：

| 指令 | 結果 |
| --- | --- |
| `pnpm test:contracts` | 16 suites、239/239 tests 通過，0 fail／skip；v0.1 24、P1 215，其中本次新增 21 |
| `pnpm test:contracts:seeds` | Ledger／Protocol 各以 0x01、0x02 執行，四次共 12/12 tests 通過；每個 invariant 128 runs × 64 calls、0 revert，八個 invariant campaigns 合計 65,536 calls |
| `node --import tsx --test tests/protocol-artifacts.test.ts` | 1/1 test file 通過，內含編譯／EIP-170 與 ABI 特權名稱兩項命名檢查；此 host runner 以檔案彙總計數 |
| `pnpm check:contracts` | 通過；八份具體 P1 runtime 全部低於 24,576 bytes，最大 `BlinkResolution` 20,113 bytes（`BlinkMarkets` 18,324） |
| `pnpm check:boundaries` | 通過 |

聚焦的 lifecycle／invariant／adversarial／settlement 回歸為 37/37 tests 通過。依 R31／dispatch，本 worktree 不執行完整 TypeScript `pnpm check`；由 controller 在 main 執行並完成獨立 review。本次只在 `ws/p1-t10` 提交，不 push。P1 合約測試通過不代表 P2–P4 或自治服務演練完成。
