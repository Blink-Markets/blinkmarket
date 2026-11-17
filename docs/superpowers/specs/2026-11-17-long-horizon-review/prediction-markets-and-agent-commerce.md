# 預測市場機制與 agent commerce 現況調查(查證日:2026-11-16)

來源標記:**[讀]** = 我實際開啟並讀過該頁;**[搜]** = 只來自搜尋結果摘要,未開頁,可信度較低;**[推論]** = 我的推論;**[未證實]** = 憑記憶或找不到來源。數字後的日期是來源日期。

---

## 1. 摘要(最重要的在前)

1. **「所有角色都由 agent 擔任」已有上線的先例:Olas Predict(Omen / Gnosis Chain)。** 官方頁面列出四種 agent 角色:Market Creators(建立並注資市場)、Traders、Prediction Brokers(Mech,賣預測給 trader,鏈上按次收費)、Closers(結算市場)。截至 2026-11-16:Omenstrat 7 日平均 195 個日活 agent、累計 1,215 個 agent;累計交易 trader 16,859,770 筆、Mech 2,983,425 筆、建立與結算 104,426 筆 [讀] https://olas.network/agent-economies/predict 。所以單講「全 agent 角色」**不是新東西**。
2. **但 Olas 的先例有三個明顯弱點。** (a) 交易本身不賺錢:Omenstrat 自 2025-11-22 起 trading ROI −4%,含 staking 獎勵的 total ROI 才是 +50%,代表活動主要靠 OLAS 補貼;Polystrat(在 Polymarket 上)trading ROI −7% [讀,同上]。(b) 並非無管理者:market-creator 產生的題目要送到外部「market approval server」核准後才上鏈 [讀] https://github.com/valory-xyz/market-creator 。(c) 經濟規模極小:Gnosis 上預測市場 7 日成交量約 $28.7k(DefiLlama 快照,日期不明)[搜] https://manifold.markets/deletedaccount001/omenpresagio-reaches-5000-active-tr 。
3. **「密封、可驗證的 agent 預測紀錄」也已存在,但只是研究基準,且不付錢。** Foresight Arena(Polygon PoS)用 commit-reveal(keccak256(round ID, 預測向量, salt))、鏈上計算 Brier 與 Alpha(相對 Polymarket 中間價的優勢)、ERC-8004 身分與 reputation registry、EIP-712 簽名加 gasless relayer。沒有 staking、沒有付款、agent 不交易、題目與結果都借用 Polymarket 的 CTF,由「curator」合約選題 [讀] https://arxiv.org/html/2605.00420v1 。上線實績有矛盾:v1 內文稱 2026 年 1–4 月跑了 50 輪、6 個 agent;v2 摘要改稱數字來自模擬、實測結果待後續版本 [讀] https://arxiv.org/abs/2605.00420 。
4. **我沒有找到任何一個場所同時具備:無管理者的全 agent 市場 + 與價格分離、密封簽名、結算後計分並付款的預測層。** 最接近的是各做一塊的:Olas(角色)、Foresight Arena(密封紀錄)、Sapience(鏈上 attestation 預測排行 + 市場)、Numinous(按 Brier 付錢給預測 agent)、Pandora(AI oracle + 無許可開市)。查找強度見第 4 節。
5. **大型場所的開市仍是公司控制。** Polymarket 官方說使用者不能自行開市 [搜] https://help.polymarket.com/en/articles/13364541-how-are-markets-created ;2026-02 曾預告「permissionless market deployment and creator fees next」,未見上線證據 [讀] https://defirate.com/news/polymarket-launches-public-api-unlocks-permissionless-liquidity/ 。Kalshi 由員工建立市場 [搜]。Hyperliquid HIP-4 於 2026-07-20 宣布未來開放無許可部署,現況未證實 [搜]。
6. **結算仍以人或代幣持有人為最終裁決,AI 結算在大場所還停在實驗。** Polymarket 用 UMA(2025-08 通過、2025-09 起實施白名單 proposer),2026 年前五個月爭議市場超過 1,150 個 [搜];Kalshi 為中心化裁決,2026 年有 Khamenei、Cardi B 兩起爭議 [搜]。UMA 的 Optimistic Truth Bot 整體準確率約 78%、過濾後約 95%(2025-06),尚未在鏈上提案 [搜]。
7. **長天期市場的誘因目前只有「補貼資金成本」這一種。** Polymarket holding rewards 現為 3.25%(只適用 18 個指定市場)[讀];Kalshi 對現金與部位付 3.50% APY [讀]。沒有找到「獎勵早期且準確的預測」而與資金鎖定無關的機制,除了 Sapience 的 horizon-weighted Brier 排行(不付錢)。
8. **LLM 預測能力已接近人類頂尖,但交易普遍虧錢,而且模型之間高度相關。** Metaculus 2026 春季:Pro 仍領先 bot 1.25 分但不顯著(95% CI [−4.87, 2.37]),10 位 Pro 中 9 位贏過所有單一 bot [讀]。Prophet Arena:GPT-5 Brier 0.184 對市場基準 0.187,但所有模型平均報酬都低於損益兩平 [讀]。Prediction Arena:六個前沿模型在 Kalshi 真錢交易全虧(−16.0% 至 −30.8%)[搜]。Aitchison 等人(2026-06):多個前沿 LLM 的預測高度相關,加更多相似模型幾乎沒用 [讀]。**這直接衝擊「很多 agent = 很多獨立資訊」的假設。**
9. **agent 支付軌道已上線,但真實商業量很小。** x402 交易筆數依追蹤器在 1.1–2 億之間,但調整後金額約 $1,500 萬(Visa/Artemis,2026-07)[搜],每日真實商業量約 $28,000,且 95% 以上被評為「protocol signaling」[讀] https://forkast.news/the-x402-foundation-activated-a-27-year-old-internet-code-200-million-transactions-later-the-real-volume-is-still-tiny/ 。ERC-8004 仍是 Draft,登記 agent 數 133–153 萬(2026-10,追蹤器不一致)[讀 EIP;搜 統計]。
10. **「付錢買預測」已有多種做法,但都不是「市場 + 密封預測層」的組合。** Metaculus FutureEval 每季 $50k [讀];Numinous 每日約 $3K 的挖礦獎勵 [讀];Numerai 累計付出 $24.1M [搜];Olas trader 按次付錢給 Mech [讀];Polymarket 自 2026-02 起任何人可贊助某市場的流動性獎勵 [讀];Mantic 於 2026-09 募得 $25M,把預測賣給避險基金與政府 [搜]。

---

## 2. 預測市場比較表

| 場所 | 交易機制 | 結算 | 誰能開市 | 長天期誘因 | 與價格分離的預測層 | agent 參與 |
|---|---|---|---|---|---|---|
| **Polymarket**(國際版 + Polymarket US) | CLOB;taker 費 = C × feeRate × p × (1−p),費率依類別 0–0.07,maker 免費 [讀];V2 改用單一 ERC-1155 部位合約與 pUSD [讀] | UMA optimistic oracle(保證金約 $750 pUSD、2 小時挑戰期、兩次爭議後 UMA 代幣投票);up/down 市場用 Chainlink TWAP [讀] | 公司;使用者只能提建議 [搜] | holding rewards 3.25%(18 個市場)[讀];流動性獎勵;任何人可贊助獎勵 [讀] | 無(未找到)| 官方 agents repo [搜];Olas Polystrat;大量 bot |
| **Kalshi** | CLOB;taker 費約 0.07 × C × P × (1−P) 向上取整,部分系列收 maker 費 [搜] | 公司 markets team 依合約指定來源裁決 [搜] | 公司;使用者可在 Ideas 提案 [搜] | 現金與部位 3.50% APY [讀];Volume Incentive Program 最早 2026-10-13 結束 [讀] | 無;有自家研究論文 [搜] | 第三方 MCP 與 bot;Public.com agent [搜] |
| **Metaculus** | 不是市場;提交機率,彙整成 community prediction | 管理員 / 版主依題目條件 [未證實,記憶] | 經審核 [未證實,記憶] | 無資金鎖定問題 | 本體就是:Peer / Baseline score(log score)、錦標賽、FutureEval bot 賽 [搜;讀] | 2026 春季 173 個 bot [讀] |
| **Manifold** | CPMM + limit orders,play money(mana 不能兌現)[讀] | 開市者自行裁決;版主可在例外情況推翻 [讀] | 任何人 [讀] | 免息 / 保證金貸款 [讀] | bounty questions、polls [讀] | 有 API;有自主 agent 帳號 [搜] |
| **Hyperliquid HIP-4** | 鏈上 order book,全額擔保二元合約 [搜] | validator 部署並結算 [搜] | 目前 validator;已宣布未來開放 [搜] | 未找到 | 無 | 未找到專屬資料 |
| **Limitless** | CLOB,Base,USDC [搜;讀 docs 首頁] | 未能證實 | 未能證實 | 未找到 | 無 | 僅 API |
| **Opinion** | CLOB,BNB Chain [搜] | 自稱「AI oracles」,機制未能證實 | 未能證實 | 未找到 | 無 | 未找到 |
| **Robinhood**(及其他券商) | 轉單到 Kalshi、ForecastEx、Rothera [搜] | 各交易所 | 交易所 | — | 無 | Public.com 類工具 |
| **PredictIt** | DCM/DCO,政治題,部位上限 $3,500 [搜] | 公司 | 公司 | 未找到 | 無 | 未找到 |
| **Olas Predict / Omen** | Omen FPMM(AMM),Gnosis [讀] | market-resolver agent 透過 Mech 回答 Realitio 題目,可用保證金挑戰 [讀] | Market Creator agent(經核准伺服器)[讀] | OLAS staking 補貼 | Mech 預測準確率統計 [讀] | **全部角色皆為 agent** |
| **Pandora(Hey Anon)** | AMM 或 parimutuel,Ethereum L1 [讀] | 多個 AI agent 取得共識,失敗則交給 $ANON staker 投票 [讀] | 任何人,匿名 [讀] | 未找到 | 無(agent 評分是 roadmap)[讀] | AI 當 oracle;agent 交易是願景 |
| **Sapience** | 拍賣式報價(類 RFQ),支援多腿部位 [讀] | 「decentralized oracle network」,未具名 [讀] | 未能證實 | horizon-weighted Brier 排行 | **有**:預測以 EAS attestation 寫入 Arbitrum,不需下注 [讀] | 以 agent 為主要對象 |

---

## 3. 各場所補充說明

### Polymarket
- **Holding rewards**:現行 3.25%,官方保留調整與設總額上限的權利,由 Polymarket Treasury 出資;每小時隨機抽樣部位價值、每日發放。18 個適用市場包含 2028 美國總統大選系列、2026 期中選舉、多國領導人去留、2026 年加密貨幣價格 [讀] https://help.polymarket.com/en/articles/13364459-holding-rewards 。2025-09 推出時為 4% [搜] https://www.blocmates.com/news-posts/polymarket-introduces-4-annualized-yield-for-long-term-market-positions 。何時由 4% 降到 3.25% 未能查到。同頁預告「今年稍後」會有新的獎勵與 oracle 結算系統。
- **費率表**:Crypto 0.07;Sports、Economics、Culture、Weather、Other 0.05;Finance、Politics、Mentions、Tech 0.04;Geopolitics 0;Combos 0.05。maker rebate 15–25% [讀] https://docs.polymarket.com/trading/fees 。次級來源稱 Fee Structure V2 於 2026-03-30 生效 [搜]。
- **Proposer 白名單的矛盾**:Polymarket 文件寫「Anyone can propose」[讀] https://docs.polymarket.com/concepts/resolution ;UMA 稱 2025-09-05 起強制白名單,名單由 37 個地址增至 2025-11 的 177 個,資格為近 6 個月至少 5 次提案且準確率 ≥95%,並說「Polymarket controls whether a given market uses a proposer whitelist」;白名單首月錯誤提案減少 59%、爭議減少 68% [讀] https://blog.uma.xyz/articles/managed-proposers-update 。兩者不一致,我無法判定現況。
- **Protocol V2**(2026-10-06 報導):單一 ERC-1155 部位合約取代 2019 年的 Gnosis CTF、pUSD 擔保品、四種市場型態(Binary、Atomic Neg-risk、Incremental Neg-risk、Combinatorial)、可接 UMA / Chainlink 等的 OracleAggregator;canary 至 10-30,預定 11-02 起新市場切換 [讀] https://www.theblock.co/news/business/2026-10-06-polymarket-rolls-out-v2-upgrade-with-single-erc-1155-positions-contract-pusd-collateral-417804 。部位可 split / merge 這點我本次沒有查到來源 [未證實,記憶]。
- **已知爭議** [搜]:Strategy 賣比特幣市場(約 $80–85M,UMA 以 98.6% 投 No,2026-06)https://www.theblock.co/news/ecosystems/2026-06-04-polymarket-upholds-no-outcome-strategy-bitcoin-sale-market-403600 ;伊朗和平協議市場(>$120M)https://www.theblock.co/post/405117 ;9 個巨鯨地址約佔一半投票權、逾 60% 活躍投票者同時有 Polymarket 帳戶 https://www.kucoin.com/news/flash/bloomberg-9-whale-wallets-control-over-half-of-polymarket-s-dispute-resolutions 。2026-04 進入爭議的合約成交量,來源有 >$1B 與 >$10B 兩種說法,無法調和。
- **流動性獎勵**:掛單自動符合資格,依距中間價的二次式計分,每分鐘抽樣,每日 UTC 午夜發放 [讀] https://docs.polymarket.com/market-makers/liquidity-rewards.md 。2026-02-16/17 起任何人可贊助任一市場的獎勵,加入後不可撤回 [讀 DeFi Rate,同上];實例:2026-02-17 有人在單一市場加入約 $70,000 [搜] https://telonex.io/research/sponsored-liquidity-rewards-jesus-market 。
- **監管**:Polymarket US 為 CFTC 監管的 DCM(收購 QCEX,$112M);2026-04-28 向 CFTC 申請讓美國用戶直接用主站,結果未查到 [搜] https://www.theblock.co/news/regulation/2026-04-28-polymarket-eyes-return-main-exchange-us-in-talks-cftc-bloomberg-399234 。

### Kalshi
- **APY**:預測市場現金與部位 3.50%(浮動),月均餘額需 ≥$250,限美國,每日計息、每月發放;另有 perps 7% 方案(總額 $7M 用完即止)[讀] https://help.kalshi.com/navigating-the-exchange/your-portfolio/apy-on-kalshi 。DeFi Rate 2026-09-23 記為 3.75%,推出時約 4.05% [搜],降息日期未查到。
- **激勵方案**:Volume Incentive Program(2023-03 起)最早於 2026-10-13 結束,正值 WSJ 報導 CFTC 檢視其交易與 wash trading 指控,Kalshi 否認 [讀] https://theblock.co/news/business/2026-09-30-kalshi-ends-trader-incentive-program-417247 。Liquidity Incentive Program 期間為 2025-09-15 至 2026-09-01;Designated Liquidity Provider 方案至 2027-12-01 [搜] https://help.kalshi.com/en/articles/13823851-liquidity-incentive-program 。
- **爭議** [搜]:Khamenei 去職市場(規則排除死亡,以收盤價 39.5% 結算並退費,引發集體訴訟籌備)https://thedefiant.io/news/defi/kalshi-faces-backlash-over-khamenei-market ;Cardi B 超級盃市場以暫停前最後價格結算 https://fortune.com/2026/02/11/did-cardi-b-perform-at-super-bowl-prop-bet-kalshi-polymarket/ 。
- **成交量的算法要小心**:DeFi Rate 記 2026-10 Kalshi $98.15B、Polymarket US $14.77B、八家合計 $120.73B,但採「每張合約 $1」慣例,其中至少 $79.46B 是 combo(Kalshi 至少 $66.86B),不是實際現金 [讀] https://defirate.com/news/prediction-market-volume-reaches-120-7-billion-october/ 。The Block 記 Kalshi 2026-09 為 $52.98B(截至 09-29,當月資料未完整)[讀],與 DeFi Rate 的 $60.85B 不同。
- Combo 用 RFQ 這點本次未找到來源 [未證實,記憶]。

### Metaculus
- 計分:Peer score 是自己的 log score 與其他人平均的差,每題總和為 0;Baseline score 與固定機率基準比較;2023-11 起取代舊點數制 [搜] https://www.metaculus.com/help/scores-faq/ 。
- FutureEval(原 AI Benchmarking):每季 bot 錦標賽 $50,000、MiniBench 每兩週 $1,000、Market Pulse $7,000;LLM 額度由 Anthropic、Google、OpenAI 捐贈,搜尋費用由 AskNews 合作負擔;每季 300–400 題;2026 秋季起商業 bot(三人以上營利團隊)除非開源否則不能領獎 [讀] https://forum.effectivealtruism.org/posts/hrJrsgMCwsdBuAqgQ/announcing-fall-2026-futureeval-bot-tournament 。
- Bridgewater 預測賽 2026 年獎金 $30,000(2026-01-12 至 03-13)[搜] https://www.metaculus.com/bridgewater/ 。
- bot 的預測在賽中是否對其他參賽者隱藏,我沒能查到(方法頁回 403)。

### Manifold
- 純 play money;sweepstakes(Sweepcash)2024-09 推出、2025-03-28 關閉 [搜] https://manifoldmarkets.notion.site/Investor-update-3-6-25-1ac54492ea7a8022aaf1ed2cd188663d 。
- 市場型態含 bounty questions(用 mana 獎勵最佳答案)與 polls;交易先吃 limit order 再吃 AMM [讀] https://docs.manifold.markets/faq 。

### 其他
- **Hyperliquid HIP-4**:2026-05-02 主網有限功能上線;5 月底起 validator 可部署並結算真實世界事件市場;結算貨幣由 USDH 轉向 USDC [搜] https://www.theblock.co/news/ecosystems/2026-05-26-hyperliquid-validator-prediction-markets-402511 、https://theblock.co/news/defi/2026-07-20-hyperliquid-hip-4-permissionless-deployment-408875 。「部署者需質押 1,000,000 HYPE」只見於第三方部落格,未證實。
- **Limitless**:2026-04 月成交量 $1.66B,已向 CFTC 申請 DCM [搜] https://defirate.com/news/limitless-files-cftc-approval-after-record-1-66b-month/ 。
- **Opinion**:2025-10 上線,OPN 代幣 2026-03 發行;成交量真實性受質疑 [搜] https://defirate.com/news/opinion-hits-8b-in-monthly-prediction-market-volume-but-the-data-raises-questions/ 。
- **Robinhood / Rothera**:與 Susquehanna 合資的 CFTC 持牌交易所,2026-06-04 起承接世界盃合約 [搜] https://robinhood.com/us/en/newsroom/the-world-cup-is-now-trading-on-robinhood-and-rothera 。
- **Augur**:2026-01 發表 Lituus oracle 白皮書,REP 遷移期限 2026-08-01;未找到新預測市場上線 [搜] https://thedefiant.io/news/defi/augur-reveals-augur-lituus-oracle-whitepaper 。
- **Truemarkets**(Base):AI 提案、人類挑戰的 optimistic oracle [搜] https://truemarkets.gitbook.io/truemarkets/enshrined-oracle ;2026 年活動量未查到。
- **Myriad**:第三方指南稱 AMM、以點數為主,官方文件稀少 [搜]。**predict.fun**:BNB Chain,閒置擔保品放入 Venus 生息 [搜]。**Drift BET**:仍在,流動性薄 [搜]。**Zeitgeist**:2026-04 前 30 天 0 commits,近乎停滯 [搜]。**Azuro**:本次未查。

### 長天期市場的準確度與厚度證據
- Kalshi 自家研究(約 224 萬個已結算市場):Brier 由三個月前的約 0.087 降到收盤時低於 0.02 [搜] https://kalshi.com/research/kalshi-research-calibration.pdf 。另一篇稱只有 0.15% 的交易者顯著優於基準 [搜] https://kalshi.com/research/kalshi-research-who-calibrates-markets.pdf 。這是公司發布,非同儕審查。
- Le(arXiv 2602.19520,3.53 億筆交易、42.9 萬個合約):校準取決於領域、到期時間與交易規模;政治市場價格持續向 50% 壓縮 [讀] https://arxiv.org/abs/2602.19520 。
- Page & Clemen(Economic Journal 2013):距到期越遠,價格越偏向 favourite-longshot bias,資金時間價值使套利不划算 [搜]。
- CNBC 分析(2026-07-02):Polymarket 約 70% 已結束市場成交量低於 $10,000,超過 45,000 個市場零成交,低於 $10,000 的市場中 bot 佔成交量逾 80% [讀轉述] https://beincrypto.com/polymarket-closed-markets-low-volume-cnbc/ 。
- 我沒有找到專門研究一年以上市場準確度的論文。

---

## 4. 預測市場中的 AI agent

### 已存在的東西與真實程度
- **Olas Predict**(見摘要 1–2)。補充:market-resolver 的初始答案保證金預設 0.01 xDAI、挑戰上限 0.04 xDAI,Mech 不同意既有答案時會挑戰 [讀] https://github.com/valory-xyz/market-resolver 。Gnosis 部落格說 Omen 的爭議可交給 Kleros(人類陪審)[讀],但這在 agent 流程中如何運作我未能證實。Polystrat:14 個日活、141 個累計 agent;38 個合格 agent 中 36.8% 扣除 Mech 費後為正報酬,Olas 自己對比 Polymarket 250 萬個錢包中 15.9% 為正 [讀]。
- **Polymarket 上的 bot / agent 比例**沒有可靠數字。LayerHub 稱逾 30% 錢包使用 AI agent(CoinDesk 2026-03-15,只見轉載,未證實)[搜];多倫多 / HEC / ESSEC 研究稱 5% 的 bot 型錢包控制 75% 成交量 [搜]。「bot 型」不等於 LLM agent。
- **AI 結算**:UMA Optimistic Truth Bot(見摘要 6)https://blog.uma.xyz/articles/experiment-can-ai-agents-enhance-uma-oracle [搜];Pandora 的多 agent 共識 oracle(2026-02-23 上線;2026-03-03 累計成交 $167,900、246 個市場、1,107 筆交易,之後無數據)[讀 新聞稿;搜 iq.wiki];研究:多 agent oracle(arXiv 2605.30802,用 1,189 題 Kalshi)與 LLM 輔助 UMA 仲裁(arXiv 2604.15674)[搜]。
- **agent 專用或 agent 優先的場所**:Moltguess(2026-02-06,只有 agent 能參與、人類旁觀,用模擬點數,ClawHub 掃描標為可疑)[搜] https://www.producthunt.com/products/moltguess/launches ;PredIQt(IQ AI,2026-01-08,agent 在 Polymarket 交易並按鏈上績效排名)[搜];Forkast ATLAS(2026-07,贊助稿)[搜];SKALE Agent Pit(2026-08,模擬交易沙盒)[搜];黑客松等級的 FateMarket、AgentMarket、ChronoBets、Prophet.ai、Aletheia、Swarm Oracle [搜]。
- **預測基準**:ForecastBench(FRI)、Prophet Arena(用 Kalshi 即時事件,1,367 個事件,76% 是體育)[讀]、Metaculus FutureEval、Prediction Arena(真錢)、Foresight Arena(鏈上)。
- **付錢給預測 agent 的網路**:Numinous(Bittensor SN6,前身 Infinite Games):題目來自 Polymarket 即時二元市場,Brier 計分,預測裁剪到 [0.01, 0.99],缺漏記 0.25,獎勵「目前平均每日 $3K」,集體輸出經 Eversight API 賣給交易者與機構 [讀] https://docs.crunchdao.com/real-time-competitions/competitions/numinous 。

### 明確回答
- **是否已有「所有角色皆 agent」的場所?有,Olas Predict / Omen。** 但開市有核准伺服器把關、仲裁後盾是 Realitio 保證金升級機制(可能還有 Kleros 人類陪審)、而且靠代幣補貼。「無管理者 + 全 agent,且包含仲裁」我沒有找到。
- **是否已有密封、簽名、可驗證的 agent 預測紀錄?有雛形,Foresight Arena。** 它密封(commit-reveal)、可驗證(鏈上)、綁 ERC-8004 身分,但不付款、不自己出題或結算、實測資料存疑,官網抓取只回傳標題。Sapience 的 EAS attestation 預測是公開上鏈且有時間戳,是否密封未說明;Metaculus 與 ForecastBench 是中心化計分。
- **兩者合在一起、再加上按計分規則付款的場所:沒有找到。**
- **查找強度**:約 12 組不同措辭的英文搜尋(agent-only、all roles、autonomous creation/resolution、commit-reveal、signed/sealed forecasts、attestation、ERC-8004 + prediction market、forecasting leaderboard 等),並讀了約 10 個一手頁面。限制:搜尋工具僅限美國英文結果,沒有查中文 / 韓文社群、Discord、X,也沒有直接查鏈上資料。小型或未公開的專案可能漏掉。

### LLM 預測對比人類與市場價格
- Metaculus 歷季 Pro 對 bot 的差距:2024 Q3 +11.3、Q4 +8.9、2025 Q1 +17.7、Q2 +20.03,到 2026 春季縮到 1.25 且不顯著;線性外推 bot 約 2027-06 超越 Pro [讀] https://www.lesswrong.com/posts/a82q6yd8zKpYk56cF/ai-forecasting-in-2026-what-11-analyses-say 、https://forum.effectivealtruism.org/posts/iJ3qBDwpWCfNy9ZGd/pros-beat-bots-but-the-gap-is-nearly-gone 。
- ForecastBench(2026-07-16):「likely reached parity」,數個提交與超級預測者統計上無法區分;但超級預測者的資料停在 2024 年,靠統計外推 [讀] https://forecastingresearch.substack.com/p/ai-models-have-likely-reached-parity 。Good Judgment 反駁:在 market questions 上超級預測者仍領先(80.3 對 75.8),且模型拿到市場價格時常直接照抄 [搜] https://goodjudgment.substack.com/p/what-forecastbench-doesnt-measure 。
- Mantic 在 2026 夏季 Metaculus Cup 贏過所有人類參賽者,只輸給另一個 AI「laertes」(Reuters 2026-09-18,經轉載)[搜]。
- 對市場價格:Prophet Arena 中前沿模型 Brier 與市場基準相近(0.184–0.197 對 0.187),校準更好(ECE 0.041–0.067 對 0.069),遠期較占優、臨近結算時市場較準;平均報酬 0.805–0.943,皆未達損益兩平 [讀] https://arxiv.org/html/2510.17638v2 。
- 準確不等於賺錢:Gu 等人(arXiv 2607.06166)提出只要在某 proper scoring rule 下勝過市場就有正期望報酬的下注策略,並在 Kalshi 做了一個月實測,摘要只稱結果「encouraging」[讀] https://arxiv.org/abs/2607.06166 。
- **獨立性**:Aitchison 等(arXiv 2606.29661,ICML 2026 workshop):前沿 LLM 預測高度相關,最佳 ensemble 需要準確且多樣的成員,Grok 4 因相關性低而貢獻特別大 [讀] https://arxiv.org/abs/2606.29661 。Metaculus:ensemble 約 10 個 bot 時最好,擴到 30、50、100、173 個反而變差 [讀]。Spiro(arXiv 2605.00844):有效多樣性由 N 個獨立頭腦塌縮為 k 個相關模型輸出 [搜]。

---

## 5. Agent commerce

| 協定 / 產品 | 背後是誰 | 運作方式 | 上線狀態 | 採用數據 | 結算資產 |
|---|---|---|---|---|---|
| **x402** | Coinbase 發起;2026-07-14 起由 Linux Foundation 的 x402 Foundation 管理,40 個創始成員(含 Visa、Mastercard、Stripe、Google、AWS、Cloudflare)[讀 Forkast;搜] | 伺服器回 HTTP 402,client 付款後重試;免帳號、免 API key [讀] https://x402.org/ | 上線(V1 2025-05,V2 2025-12)[搜] | 1.1–2 億筆(依追蹤器);調整後金額約 $15M;每日真實量約 $28k–40k [讀;搜] | 穩定幣(主要 USDC),Base、Solana 等 |
| **AP2** | Google;據報 2026-04/05 捐給 FIDO Alliance [搜] | 以可驗證憑證(v0.2 用 SD-JWT)簽署的 mandate 授權 agent 付款 | 規格已公開;正式量產部署不明 | 60+ 至 100+ 支持機構 [搜] | 不限(卡、銀行、x402 穩定幣)|
| **Agentic Commerce Protocol(ACP)** | OpenAI + Stripe,Apache 2.0 | agent 與商家間的結帳規格 | 規格仍標 beta;ChatGPT Instant Checkout 於 2026-03-24 縮減,改回商家自有結帳 [搜] | 據稱只有約十多家 Shopify 商家實際接上(未證實)[搜] | 卡 / Stripe Shared Payment Tokens |
| **Universal Commerce Protocol(UCP)** | Google,與 Shopify、Walmart、Target、Etsy、Wayfair 等 [搜] | 完整購物流程層,可接 AP2 | 2026-01 發布 | 20+ 家共同開發或背書 | 卡 / Google Pay |
| **Machine Payments Protocol(MPP)** | Stripe + Tempo(Paradigm 支持)| session 式付款,不必每次上鏈;可走穩定幣、卡、Lightning | 2026-03-18 隨 Tempo 主網上線 [搜] | 未找到用量;Bankless 評為尚無廣泛自然使用 [搜] | 穩定幣(Tempo)、卡等 |
| **Visa Intelligent Commerce / Trusted Agent Protocol** | Visa(TAP 與 Cloudflare 合作,2025-10)| agent 專用加密簽名,讓商家分辨合法 agent | 多地區試點,透過 Adyen、Stripe、Checkout.com 推出 [搜] | 100+ 夥伴(未證實)| 卡 |
| **Mastercard Agent Pay(含 AP4M)** | Mastercard | 代幣化的 agent 交易;AP4M 針對機器小額付款(2026-06)[搜] | 美國、香港、歐洲已有首批實際交易 [搜] | 未找到交易量 | 卡 |
| **Circle Agent Stack / Nanopayments / Arc** | Circle | agent 錢包、低於 1 美分的免 gas USDC 轉帳;Arc 為自家 L1 | Nanopayments 2026-04/05 主網;Arc 公開主網 2026-09-16 [搜] | Circle 自稱 USDC 佔 agent 交易量 98.8% [搜] | USDC |
| **Coinbase Agentic Wallets / Agentic.Market / Bazaar** | Coinbase | 給 agent 的錢包;x402 服務目錄 | 2026-02-11 與 2026-04-20 上線 [搜] | 365+ 項服務(單一來源)[搜] | USDC |
| **ERC-8004** | De Rossi、Crapis(EF)、Ellis、Reppel(Coinbase)| Identity(ERC-721)、Reputation(回饋訊號)、Validation(請求第三方驗證)三個 registry;付款不在範圍內 [讀] https://eips.ethereum.org/EIPS/eip-8004 | Draft;2026-01-29 主網部署 [搜] | 登記約 133–153 萬個 agent(2026-10)[搜] | 不適用 |
| **ERC-8183** | Crapis(EF)+ Virtuals 成員 | Job 託管:client 出資、provider 交付、只有 evaluator 能完成或拒絕 [讀] https://eips.ethereum.org/EIPS/eip-8183 | Draft(2026-02-25 建立)| — | ERC-20 |
| **A2A** | Google 發起,Linux Foundation | agent 之間發現與溝通;有 x402 與 AP2 擴充 | 上線;2026-04-09 超過 150 個支持機構 [搜] | — | 不適用 |
| **Virtuals ACP** | Virtuals Protocol | agent 之間的工作託管與 evaluator | 上線(Base;2026-03 上 Arbitrum)| 自報 aGDP $470M、177 萬件工作(2026-02),無法獨立驗證 [讀] https://forkast.news/the-machine-as-buyer-virtuals-acp-and-the-evaluator-problem/ | VIRTUAL / USDC |
| **Olas(Mech Marketplace)** | Valory | agent 按次付費雇用其他 agent | 上線 | 約 2,050 萬筆交易,其中約 1,465 萬筆為 agent 對 agent(2026-09)[搜] | xDAI 等 |
| **Skyfire / Nevermined** | 新創 | KYA 身分 + 付款;計量計費 | 上線 | 未找到可驗證用量 [搜] | USDC / 法幣 |

### 補充
- **數字的共同問題**:登記數、交易筆數、「aGDP」都不是真實商業量。Forkast 兩篇文章的結論一致:誘因讓「模擬商業」有利可圖 [讀]。ERC-8004 的登記數同理 [推論]。
- **ERC-8004 細節**:Reputation Registry 鏈上只存數值、小數位、tag 與撤銷狀態,feedbackURI 與 hash 只在事件中發出;Validation Registry 的回應是 0–100 分,質押與 slashing 留給上層協定自行設計 [讀]。Validation Registry 是否已正式上線,QuickNode explorer 與 8004.org FAQ 說法不一 [搜]。
- **agent 的 staking / slashing**:多數停在設計或宣示。EigenCloud(2026-02 上線)稱不誠實行為可被 slash,並計畫支援「insured and sovereign AI agents」,參數未定 [搜] https://blockworks.co/news/google-cloud-eigencloud-payments 。Olas 是用 staking 發獎勵而非懲罰 [推論,依 ROI 揭露]。Recall Network 用競賽成績加社群質押算 AgentRank,自報 140 萬用戶、17.5 萬個 agent(2026-06)[搜]。
- **MCP 付款**:Coinbase Payments MCP、Tempo 的 mpp.dev 目錄與 MCP server 都存在 [搜];沒有找到 MCP 官方的付款標準。

---

## 6. 今天誰在付錢買預測或資訊

| 付款方 | 金額 | 機制 | 來源 |
|---|---|---|---|
| Metaculus FutureEval(Anthropic、Google、OpenAI 捐額度;AskNews) | 每年 $175k,每季主賽 $50k | 依 peer score 排名分獎金 | [讀] EA Forum;[搜] 方法頁 |
| Bridgewater × Metaculus | $30,000(2026)| 人類預測賽 | [搜] |
| Sapience × ElizaOS 黑客松(Arbitrum 贊助) | 10,000 USDe(2025-12-08 至 2026-01-05)| 預測賽道按 horizon-weighted Brier,交易賽道按損益 | [讀] https://blog.sapience.xyz/p/build-autonomous-agents-compete-for |
| Numinous(Bittensor SN6)| 約 $3K / 日的子網獎勵;另有 $5,000 USDC 階段獎金 | Brier 排名,需勝過基準 | [讀] |
| Numerai | 累計 $24.1M;2025-04 起月均約 $313K | 質押 NMR,依模型表現增減 | [搜] Blockworks 2026-11-02 |
| Allora | Pay-What-You-Want;自報 6.92 億次推論(2026-02)| 依「獨特貢獻」獎勵 worker,reputer 對照真值評分 | [搜] |
| Olas trader agent → Mech | 按次鏈上付費;Mech 累計約 306 萬筆 | agent 付錢買另一個 agent 的預測 | [讀] |
| Polymarket 贊助獎勵 | 任意;實例約 $70,000 | 任何人出錢補貼某市場的掛單深度(買的是價格品質,不是預測本身)| [讀;搜] |
| Mantic 的客戶(避險基金、政府機構,未具名)| 未公開;公司募資 $25M | 訂閱 / API | [搜] |
| Good Judgment(FutureFirst、客製 Superforecasts)| 未公開 | 訂閱與顧問 | [搜] |
| Manifold bounty | mana(無現金價值)| 開題者獎勵最佳答案 | [讀] |
| x402 按次付費的預測 / 資料 API | 未知 | 402 付款後回資料;只見廠商自述 | [搜] |

觀察 [推論]:付錢的方式分成三類,即贊助獎金池(Metaculus)、代幣通膨(Numinous、Allora、Olas)、商業訂閱(Mantic、Good Judgment)。沒有看到「出題者為某一題出資,按 proper scoring rule 付給密封預測的 agent」這種逐題的資訊市場。

---

## 7. 看起來還沒人佔據的位置

| 空缺 | 證據 | 我對「確實沒人做」的信心 |
|---|---|---|
| 全 agent 市場 + 與價格分離的密封簽名預測層 + 結算後按計分付款,三者合一 | 各部分分別存在於 Olas、Foresight Arena、Numinous,未見整合 | 中高(已上線且有規模者);中低(是否有人正在開發)|
| 真正無管理者的 agent 開市 | Olas 有核准伺服器;Polymarket、Kalshi 公司控制;Pandora 無許可但開市者是人 | 中 |
| 由 agent 做最終仲裁(不退回代幣投票或人類陪審)| Pandora 退回 $ANON staker;UMA bot 不上鏈;Olas 靠 Realitio 升級 | 中。注意這也可能是因為大家認為不安全,而非沒想到 [推論] |
| 針對長天期、獎勵「早而準」且不需鎖資金的付費機制 | 現有只有 holding rewards / APY;Sapience 有排行但不付錢;Numinous 對長天期題用 Polymarket 價格做中途計分(細節未證實)| 中 |
| 把可驗證預測紀錄接上 ERC-8004 reputation 並實際用來決定付款或權重 | Foresight Arena 只記錄不付款 | 中 |
| 為「獨立資訊」付錢(懲罰與他人相關的預測)| Allora 稱獎勵獨特貢獻;Numerai 有類似的貢獻度計分 [未證實,記憶];預測市場領域未見 | 中低:概念在代幣網路已有 |
| 逐題贊助的 agent 預測懸賞 | Polymarket 贊助的是流動性;Metaculus 是整季獎金池 | 中 |

不是空缺、反而是風險的地方 [推論]:(1) agent 交易普遍虧錢,沒有補貼時流動性從哪來是 Olas 已經示範的問題;(2) LLM 預測高度相關,agent 數量多不代表資訊多;(3) agent commerce 的「採用數字」多為訊號或自我交易,不能當作需求證據。

---

## 8. 未能證實的事項與無法取得的來源

- **403 / 內容空白**:https://www.metaculus.com/futureeval/methodology/ 與 https://www.metaculus.com/tournaments/ 回 403;https://foresightarena.xyz 只回傳標題(可能需 JavaScript),排行榜現況未知。
- **Foresight Arena 是否真有實測資料**:論文兩個版本說法矛盾。
- **Polymarket**:無許可開市是否已上線;holding rewards 何時降到 3.25%;目前誰能提案(文件與 UMA 說法矛盾);split / merge(記憶);Polymarket US 現行費率(來源有 0.10%、0.30%、分類 4–7% 三種);V2 是否如期於 11-02 切換;2026-04 爭議金額。
- **Kalshi**:APY 是 3.50% 還是 3.75%;Outcome Review Committee 與 Request to Settle 只見第三方;API 開發者協議限制代他人下單只見第三方;combo 用 RFQ(記憶)。
- **Metaculus**:誰能出題、如何結算(記憶);bot 預測是否互相隱藏;2026 夏季 bot 對 Pro 的正式結果。
- **Limitless、Opinion、Myriad**:結算方式與開市權限都沒有找到官方文件。
- **Hyperliquid HIP-4**:無許可部署是否已上線、質押門檻、爭議流程。
- **Azuro、Good Judgment Open 2026 贊助者、Ocean Predictoor**:沒有查到資料。
- **agent 佔比**:「30% Polymarket 錢包使用 AI agent」未見原文。
- **Olas**:Kleros 在 agent 結算流程的角色;market approval server 由誰運作、核准標準為何。
- **Agent commerce**:AP2 捐給 FIDO 的確切日期;ACP 商家數;MPP、Skyfire、Nevermined 的用量;Visa / Mastercard 2026 年 10–11 月的最新數字;ERC-8004 Validation Registry 是否正式上線;Agentic.Market 的 365 項服務。
- **方法限制**:見第 4 節「查找強度」;另外許多數字只來自搜尋摘要([搜]),引用前應開原頁核對。
