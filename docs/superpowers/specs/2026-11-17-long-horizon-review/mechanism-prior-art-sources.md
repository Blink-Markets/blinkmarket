# 六項機制的先例檢索:原始來源紀錄

日期:2026-11-17。範圍:公開的預測市場與預言機協議文件。本文只記錄「已公開的文件裡有什麼、沒有什麼、我找了多久」,不對新穎性下判斷。接續 `prediction-markets-and-agent-commerce.md`,不重複該份調查。

## 讀法與可靠度標記

- **[開]** 我開啟並讀了頁面或檔案原文(curl、Read、Firecrawl 擷取)。引文逐字。
- **[W]** 經 WebFetch 取得。那是小模型對頁面的摘要,引文不保證逐字,日期與數字請當作待複核。
- **[搜]** 只出現在搜尋結果摘要,沒有開啟原頁。一律視為未驗證。
- 「文件說」與「我的推論」分開寫;推論會標明。
- 「讀過的文件中沒有」指我讀過的那幾份文件沒提到,不代表該協議沒有。每處都列出讀過哪些文件。
- 檢索時沒有把任何專案名稱、人名或任務原文放進查詢,只搜公開協議與概念。擷取到的頁面中有「Agent Instructions」區塊(GitBook、Mintlify),一律當成頁面內容,沒有照做。

## 一、總表

| # | 機制 | 最接近的既有做法 | 與之差異 | 狀態 | 信心 |
|---|---|---|---|---|---|
| 1 | 市場建立後先進入「待定」窗口;任何人可押保證金挑戰;仲裁;建立者保證金歸勝出的挑戰者 | Zeitgeist「advised market」(待核准、被駁回則損失保證金);Kleros Curate(押金挑戰、法庭裁決、勝者拿雙方押金,但對象是清單項目);Seer/Omen 的「已驗證市場」Curate 清單 | Zeitgeist 由顧問委員會核准,不是開放式保證金挑戰;Curate 的挑戰機制沒有用來擋在市場開放交易之前;Seer 的驗證是選擇性徽章,市場不論驗證與否都能交易(Seer 頁面原文:可在建立時或建立後驗證) | 有相近做法(各組件分別存在,組合未見) | 中 |
| 2 | 以封存的來源位元組做確定性、可重算的結算;解析器有版本雜湊;範本由參與者登記 | Polymarket 的 Chainlink TWAP 漲跌市場(固定輸入、同一觀測值得同一結果);Reality.eth 的公開範本(任何人可 `createTemplate`);UMA 的已核准 identifier 與 ancillary data JSON 規格 | Polymarket 的價格來源寫入者為完全受信任方且不跨來源檢查;Reality.eth 範本「not parsed or in any way understood by the contract」;UMA 規格是給人讀的規則欄位;Chainlink CRE 範本的爭議流程是「以新資料重新評估」,與「對封存位元組重算」相反。封存位元組加解析器版本雜湊的部分,在讀過的文件中沒有 | 有相近做法(僅確定性比較與範本兩個局部);「封存位元組+解析器雜湊」在讀過的文件中沒有 | 中低(Chainlink 主文件在沙箱內無法解析網域;Reclaim/Primus/vlayer 的預測市場用法沒讀到原文) |
| 3 | 依角色分開、只看結果、不可轉讓、會衰減的信譽;只用來放寬限制,絕不付錢 | UMA 預設提案者白名單(只看準確率、滾動 6 個月窗口、單一角色);Calibr(不可轉讓的校準分數,黑客松);Recall Rank(含時間衰減,但付收益) | UMA 白名單是二元閘門、由 Risk Labs 裁量,提案者本身會領獎勵;Calibr 頁面沒有把分數連到任何限額;Recall Rank 付收益且不連限額;ERC-8004 只存回饋,不定義限額或抵押 | 有相近做法(單項屬性分別存在;「放寬限額且不付錢」的組合未見) | 中 |
| 4 | 建立市場時在鏈上強制檢查:攻擊最後一輪及各輪上訴的成本必須大於該市場最大賠付;保證金隨最大賠付而非未平倉量縮放 | Augur v2 白皮書(攻擊者最大收益 < 最小攻擊成本,以未平倉量為基準);UMA 治理文件的「cost of corruption」;Augur Lituus 白皮書(2026-01,Query Fee 與保證金由回饋控制器設定);UMA/Polymarket/EigenLayer 的下一代預言機研究(「dynamic bonding」);Opinion 的爭議質押「max(1% of market open interest, 1,000 $OPN)」 | 以上都是系統層級的論證或建議,沒有看到「建立時拒絕不安全市場」的鏈上檢查。Augur 與 UMA 以未平倉量或鎖定總額為準,不是單一市場最大賠付;Lituus 把弱點資訊交給「社群維護的儀表板」,不在鏈上強制;UMA 的保證金文件說明是「There are no exact answers to how high or low your bond should be」 | 有相近做法(論證層級);「建立時鏈上強制檢查」在讀過的文件中沒有 | 中低 |
| 5 | 最終仲裁只由 AI agent 擔任,沒有人類或代幣持有人後備 | Chaos Labs Edge AI Oracle(AI 委員會單層決定結算,頁面未描述人類升級路徑,2024);Kleros Agentic Commerce Court(AI 陪審員,但可上訴到人類陪審員);GenLayer(LLM 驗證者委員會與擴大上訴,但驗證者由代幣質押者運行) | Kleros 與 Truemarkets、UMA 的文件都明說人類保留最終權;Chaos 的頁面是「沒有描述」而非「明說沒有」,且那是結算而非爭議後的最終仲裁。沒有協議在讀過的文件中明說「僅 AI、無人類後備」 | 有相近做法(Chaos、GenLayer);明說「無後備」的在讀過的文件中沒有 | 低中 |
| 6 | 合約不可變、分「世代」;信譽以唯讀方式匯入新世代;治理只負責採納下一世代 | Augur(「permissionless, trustless, immutable」;v1 到 v2 為自願遷移;Lituus 為下一版;分叉遷移窗口無人可重開) | Augur 沒有治理機構,也沒有看到信譽匯入;Polymarket V2、UMA、Kleros 的文件明載可升級代理、admin 角色或治理升級。「信譽唯讀匯入新世代」在讀過的文件中沒有 | 有相近做法(不可變+世代遷移);「信譽唯讀匯入」在讀過的文件中沒有 | 中 |

## 二、機制 1:建立時的挑戰窗口

**已讀協議**

- **Kleros Curate** [開]。對清單項目做「待定、押金挑戰、法庭裁決」:"The submission enters a **pending** state." / "During the challenge period, anyone can challenge the submission by staking their own deposit." / "The winning party receives both deposits (minus arbitration fees)." https://docs.kleros.io/products/curate.md ,頁面未標日期。這是與機制 1 結構最像的既有機制,但對象是清單項目。
- **Omen「Verified Markets」** [開,部分]。Kleros 生態系頁列有 "Omen | Curate list for 'Verified Markets' badge"(https://docs.kleros.io/enterprise/ecosystem.md)。Kleros v2 儲存庫的 metaevidence 設定檔標題為 "Remove a list from Omen Verified Market enabled badges"(https://raw.githubusercontent.com/kleros/kleros-v2/master/kleros-sdk/config/v1-metaevidence/omen2.json),可見這是「清單的清單」型 Curate 徽章。我的推論:這是市場存在之後才加上的徽章,不是開放交易前的關卡;我沒有找到 Omen 目前的說明頁來證實,所以這點未驗證。另外 Kleros 2020-07-01 的部落格 [W] 只說 Kleros 作為 realit.io 的最終仲裁者,沒有描述 Curate 驗證流程。
- **Seer「Verified Markets」** [開]。https://docs.seer.pm/app/verify-market.md :"When creating a market, you are able to verify it by adding the market to the Curate List of Verified Markets."、"You can choose to verify your market either at or after its creation."、需要 xDAI 押金,"The deposited xDAI will be returned once your market is verified"。政策 PDF(https://cdn.kleros.link/ipfs/QmfGcodBzG53DBxS2Uxu5jug9YiHUpJ5tKFqhP6Z2HjscU/Seer%20-%20Verified%20Markets.pdf ,未標日期)的驗收條件包含「The market's question must not be expected to resolve as 'invalid'」與「The question must be clear of ambiguity and misleading terms」。這是「選擇性、事後可補」的驗證,Seer 頁面沒有描述建立者保證金歸挑戰者;挑戰規則來自 Curate 通用文件,不是 Seer 頁面。
- **Zeitgeist** [開]。https://docs.zeitgeist.pm/docs/learn/market-rules (未標日期,範例為 2022 至 2024):"Advised markets require a 200 ZTG bond and have to be approved by the Advisory Committee and can be rejected (with the loss of the bond)." 駁回理由包含沒有清楚問題或結算標準、時間設定錯誤、"Wrong categories"。無許可市場需 1000 ZTG 保證金,事後有害者可被移除。這與機制 1 最接近(有待定狀態、有駁回理由、駁回損失保證金),差別在核准者是委員會,不是開放的保證金挑戰。先前調查說 Zeitgeist 近乎停滯,本次沒有重新驗證。
- **Augur v2 白皮書** [開,raw main.tex,未見日期]:validity bond 在市場以「invalid 以外的結果」結算時退還給建立者;大小依無效市場比例動態調整。"Once the transaction is confirmed, the market is live and trading begins." 沒有開放前窗口,無效與否在結算時判定。
- **Olas market-creator** [開,README]:生成的問題送到外部「market approval server」(狀態含 proposed_markets、approved_markets、rejected_markets)。"only *approved* markets are created on-chain, so markets can be gated before funds are committed." 這是鏈下、由營運者金鑰控制,沒有保證金挑戰;README 沒說誰核准、依何標準。
- **Polymarket** [W]。說明文章 https://help.polymarket.com/en/articles/13364541-how-are-markets-created :"While users cannot directly create their own markets, they are encouraged to suggest ideas for new markets." 與 "Markets are created by the markets team with input from users and the community." 頁面未描述正式審核。
- **Truemarkets** [開,GitBook markets、oracle-council、market-creation-guidelines 頁]:"In the early days of the project, market creation is delegated to whitelisted addresses and AI agents";建立限於 Oracle Council 成員並依 Market Creation Guidelines。讀過的頁面沒有提到開放前挑戰。
- **Hyperliquid HIP-4** [開,deployer-actions 頁標為 Testnet-only;Pyth 部落格 2026-09-10]:"validators vote on outcome templates";"Markets that contradict their template's semantic restriction are considered malformed and slashable by validators."、部署者需質押(最短質押期 183 天)、"At most N active outcomes per deployer (N=10 on testnet)." 事後罰沒,沒有開放前挑戰;部署者自行結算。主網狀態:此頁標測試網,先前調查引 2026-05-02 的主網報導,兩者不一致。
- **Limitless** [開]:使用者可建立市場,"subject to a daily limit and per-duration capacity caps";讀過的頁面未提挑戰窗口。
- **Opinion、Myriad、Azuro、Pandora**:建立階段挑戰機制未見。Pandora 只有二手來源。Myriad 文件首頁目錄(builders、trading、community-guidelines)沒有開啟市場建立頁(llms.txt 404)。Azuro 文件 [開]:市場由 Data Provider 建立,「Reinforcement」由其設定,沒有建立前挑戰。

**反例搜尋**:搜尋「待定直到挑戰期結束、建立者損失保證金」類描述,回傳的只有結算挑戰(Polymarket/UMA、Mettle 文件),沒有建立前挑戰。

**讀過的文件中沒有**:「市場建立後、開放交易前,任何人可押保證金挑戰,仲裁敗方為建立者時保證金歸挑戰者」的組合,在上列文件中沒有出現。

## 三、機制 2:確定性、可重算的結算

**已讀協議**

- **Polymarket 結算文件** [開] https://docs.polymarket.com/concepts/resolution.md :Chainlink TWAP 漲跌市場,"Because the inputs and comparison are fixed, the same observations always produce the same result without UMA's proposal-and-dispute process." 來源為 Chainlink Data Streams。UMA 保證金「typically $750 pUSD」,挑戰期 2 小時。
- **Polymarket V2 儲存庫** [開] https://github.com/Polymarket/polymarket-v2-external (docs/oracle.md):ChainlinkReporterModule "Reads start and end prices from a `DataStore` contract";"The `priceSource` address ... is the sole source of price data. The module does not cross-check prices". 寫入者完全受信任,DataStore::write 非僅追加。屬於確定性比較,但沒有封存位元組可供爭議時重算。
- **UMA/Polymarket V2 ancillary data JSON 規格** [開] https://docs.uma.xyz/polymarket-v2-migration/ancillary-data-json-specification.md :欄位含 type、title、description、market_id、res_data、product_spec("url rule template")、integration;description 為「resolution rules, evidence sources, timing and exceptional cases」。是規則欄位的格式,沒有提到解析器或位元組雜湊。
- **UMA 已核准 identifier** [開]:YES_OR_NO_QUERY、MULTIPLE_CHOICE_QUERY、NUMERICAL("Returns a number value based on a question asked in the ancillary data")、ASSERT_TRUTH2;新增需經 UMIP 由代幣持有人投票(治理頁:"Registering and de-registering contract templates")。
- **Reality.eth** [開,whitepaper.md 與 docs]:範本為帶 sprintf 參數的 JSON,任何人可呼叫 `createTemplate`;但 "This text is not parsed or in any way understood by the contract."、"Any contract address can be set as the arbitrator."(https://github.com/RealityETH/reality-eth-monorepo)。
- **Augur v2 白皮書** [開]:來源可為 API 網址,「reporters would simply go to that URL and enter the high temperature displayed there」。是人工回報。
- **Truemarkets** [開]:`_marketSource` 欄位("this field can also contain URLs referencing the exact sources"),字串鏈上不可變;結算由有保證金的人類提案者與升級。
- **Chainlink CRE 預測市場範本** [開,經 Firecrawl 取得 https://docs.chain.link/cre-templates/prediction-market ,未標日期]:"Chainlink Data Feeds — Deterministic BTC/USD price resolution";"Dispute Management (LogTrigger) — Listens for `DisputeRaised` events and re-evaluates outcomes with fresh price data". 以新資料重評估,與對封存位元組重算相反。CRE 黑客松專案(Dark Oracle、CResolver 等)只見於搜尋摘要 [搜]。
- **GenLayer** [開,文件更新日 2026-06 至 09]:LLM 驗證者委員會("gl.nondet.web.get")加 Equivalence Principle。法庭頁:"The EVM contracts do not re-execute the intelligent contract to prove which program output is semantically correct."
- **Kalshi** [開,GOVTSHUTDOWN 合約條款 PDF,未標日期]:"as documented by the Source Agencies";"Revisions to the Underlying made after Expiration will not be accounted for";"Kalshi may, at its sole discretion, initiate the Market Outcome Review Process pursuant to Rule 7.1".
- **Reclaim** [開,llms.txt 與 understanding-the-tech.md]:沒有預測市場內容。Reclaim 的預測市場用法(TMR.NEWS、Satoshi's Palace、Raize Club)只見於搜尋摘要 [搜]。
- **opML/ORA** [搜,arXiv 2401.17555]:對推論重新執行的互動式詐欺證明;是通用的樂觀計算預言機,不是預測市場位元組。我手上的中文筆記與論文在爭議設計上有出入,未開啟全文。
- **Chaos Labs Chaos Proofs Oracles** [W] 2024-09-17:來源事先指定(AP、CNN、Fox 等),檢查資料未被竄改,LLM 抽取答案,多節點共識;稱預言機 "do not act as arbiters of truth"。頁面說密碼學證明機制會另文說明,沒有確認來源資料或證明可被第三方重驗。
- **Primus、Opacity、vlayer**:沒有開啟文件。搜尋 vlayer 的預測市場用法沒有回傳 vlayer 文件。Primus 與 Cournot 的合作只見於 Binance Square 的二手分析 [搜]。

**反例搜尋**:「封存來源雜湊、重跑解析器」與「結算範本登錄」兩類搜尋,都沒有回傳符合的協議文件。

**讀過的文件中沒有**:對來源位元組封存並雜湊、以帶版本雜湊的解析器在爭議時重算的做法,在上列文件中沒有;範本登記權限在 Reality.eth(任何人)與 UMA(代幣持有人投票)各有形態,但兩者的範本都不被合約解析。

## 四、機制 3:依角色、只看結果、不可轉讓、衰減,只放寬限制

**已讀協議**

- **UMA 預設提案者白名單** [開] https://docs.uma.xyz/using-uma/default-proposer-whitelist.md ;部落格 https://blog.uma.xyz/articles/managed-proposers-update (2025-11-08)[開]:"Risk Labs manages the default proposer whitelist ... subject to Risk Labs' discretion"。條件:近 6 個月至少 5 次提案且準確率 95% 以上,每月更新。部落格:"Polymarket decides which markets use a whitelist; UMA enforces the logic and curates eligibility criteria based on historic proposer accuracy."、白名單位址數 9 月 37、10 月 156、11 月 177。文中沒有使用「reputation」一詞。這是單一角色、只看準確率、滾動窗口的二元閘門,而提案者會領獎勵。延長挑戰期則由 Risk Labs 審查團隊逐案處理(例:未標記運動賽事 15 分鐘,預設最少 2 小時),不是依身分。
- **UMA OOv3 Escalation Manager** [開] https://docs.uma.xyz/developers/optimistic-oracle-v3/escalation-managers.md :Full Policy Escalation Manager 讓合約擁有者設定「whitelist of asserting callers, asserters and disputers」,並決定爭議由 Escalation Manager 或 DVM 仲裁。是白名單與仲裁路徑可由擁有者設定的框架,沒有結果型信譽。
- **Kleros** [開]:PNK 質押、不一致陪審員損失質押。Kleros Agent Reputation(測試網):以抵押排序("More collateral can rank a compliant agent higher"),是金錢背書的登錄,不是結果分數。Agentic Commerce Court 儀表板顯示每位 agent 陪審員的 coherent/diverged/missed,沒有看到用於調整限額。
- **Truemarkets Attesters** [開]:"Proof of Reputation": "provably reputable individuals ... earned their respective reputations externally",由治理選出,是社會信譽而非結果型,也不放寬限額。
- **Recall Rank** [開,部落格 2025-08-29]:績效與確信兩軸、貝氏更新含 "time decay"、競賽制;質押訊號 "supplement[s] (but never override[s]) raw performance data";"rewards higher ranking AI (and its curators) with proportionally more yield",會付收益,未連結限額或抵押。
- **ERC-8004** [開,EIP 文本]:Reputation Registry 存簽名回饋(value、valueDecimals、tags),評分在鏈下或可組合;"Incentives and slashing related to validation are managed by the specific validation protocol"。沒有限額或抵押機制。
- **Olas staking** [開,StakingActivityChecker.sol]:存活率基於多簽 nonce(活動而非結果),用於領 OLAS 獎勵。
- **Calibr** [開,ETHGlobal HackMoney 2026 展示頁]:不可轉讓的「Proof of Calibration」,以正確評分規則從已結算市場滾動計算,"cannot be sold, reset, or recreated by switching accounts"。頁面只說其他協議可以組合使用,沒有把分數連到限額;沒有提衰減;部署狀態不明。
- **Foresight Arena** [W,arXiv 2605.00420]:ERC-8004 提供 "a verifiable, persistent track record";"Any Ethereum-compatible address can register and participate.";速率限制由 relayer 執行且與信譽無關;質押只列為未來工作;未見作者與日期紀錄。
- **Augur** [開]:REP 為代幣;validity bond 隨近期無效率動態調整(系統層而非個體層)。
- **Sapience** 文件(llms.txt、what-is、resolution)[開]:未提信譽。先前調查提到依期限加權的 Brier 排行榜,來源是部落格。
- 「信譽降低抵押」的提案:Ethereum Magicians 帖與 HackerNoon 文章 [搜],是提案不是部署;ethresear.ch 的輕客戶端信譽帖為概念性;AIP-3(帶信任係數的鏈下信譽匯入)只見搜尋摘要 [搜],未開啟。

**讀過的文件中沒有**:同時具備「依角色分開、只看結果、不可轉讓、衰減、只用於放寬限額、絕不付錢」的做法。各屬性分別出現在 UMA 白名單(結果型、單角色、滾動窗口)與 Calibr(不可轉讓、結果型),但前者會付獎勵、後者沒有連到限額。

## 五、機制 4:建立時的鏈上安全邊界

**已讀協議**

- **UMA 治理文件** [開] https://docs.uma.xyz/community/governance.md :"The DVM ensures the price to obtain 65% of UMA tokens is greater than the profit from corrupting the DVM, as measured by the collateral stored in UMA's financial contracts."、"As the total value of collateral locked in UMA grows, the UMA token is required to increase in value ... the DVM may charge fees to financial contracts which the DVM would use to buy UMA tokens." DVM 2.0 FAQ:「UMA cost of corruption」。「How does UMA's oracle work」頁:"If the DVM were successfully corrupted by 65% of stake voting against reality, the UMA token would depreciate significantly in the following week ... This creates a cost of corruption"(https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work.md)。這是系統層級的說法,以鎖定抵押總額衡量,沒有看到對單一請求拒絕建立。
- **UMA 保證金文件** [開](setting-custom-bond-and-liveness-parameters):保證金由請求者設定,下限為 final fee,考慮因素含「how much value the oracle is securing」;"There are no exact answers to how high or low your bond should be"。屬於建議。
- **UMA/Polymarket/EigenLayer 下一代預言機部落格** [開] https://blog.uma.xyz/articles/uma-polymarket-and-eigenlayer-research-a-next-gen-prediction-market-oracle (2025-02-19):"The next-gen oracle may include a dynamic bonding system that scales bonds and challenge periods according to the market's properties";研究項目還有「AI agent integration, and enhanced security against bribery attacks」;稱 UMA 保障超過 1B 美元的價值,「over 1,000 open markets」。仍是研究階段,沒有上線日期;「market's properties」未定義。2026 年的搜尋摘要仍把它列為未來研究 [搜],沒有找到 2026 年的原文確認。
- **Augur v2 白皮書** [開]:"Our approach to securing the oracle is to arrange matters such that the maximum benefit to a successful attacker is less than the minimum cost of performing the attack." 最大收益為 I_a + I_p(原生加寄生未平倉量),"Market Cap Security Theorem",目標市值為原生未平倉量的 5 倍;以報告費(預設 1%,範圍 0.01% 至 33.3%)調節;寄生未平倉量 "is unknowable"。
- **Augur「Generalized Augur」** [開](2025-05-13):"past attempts running into challenges of trustlessly and autonomously setting appropriate fees, profits, and bonds without knowing open interest. This reliance on knowing the open interest has led previous Augur designs to view 3rd party use of Augur oracle as a threat to security."
- **Augur Lituus 白皮書** [開,PDF 已解析](Ryan Garner、Philip Monastirsky,2026-01):宣稱攻擊成本為 FDV 的 134%(MBUFSR)、92%(Augur v2 的 MBUF)、83%(Kleros V2 與 Eigenlayer)、26%(UMA/Kleros V1 式投票);"Anybody can become a Query Creator by submitting a valid set of parameters accompanied by a Query Fee."、Query Fee 由回饋控制器設定,保證金從 Query Fee 起算。安全性以 REP 市值對「vulnerable open interest」衡量,白皮書建議「a community-maintained dashboard」與介面警告,所以不是鏈上強制。協議稱「trustless, and immutable」。Augur 部落格 Q2 報告(2026-10-01):ChainSafe 於 2026 年 7 月完成首批實作里程碑。
- **Kleros 上訴** [開] https://docs.kleros.io/court/appeals.md :不對稱出資(挑戰者 2 倍上訴成本,勝者 1 倍),沒有連到賠付金額。
- **Opinion** [開] https://docs.opinion.trade :爭議質押 "max(1% of market open interest, 1,000 $OPN)",隨未平倉量縮放。
- **Azuro** [開] https://docs.azuro.org/knowledge-hub/faqs/contracts :"Reinforcement is a measure of the maximum potential loss that the singleton LP can suffer from a particular prediction market ... set by the responsible Data Provider". 這是每個市場的流動性損失上限,由資料提供者設定,與預言機保證金或攻擊成本無關。
- **Truemarkets** [開]:`_yesNoTokenCap` 為 "a potential discretionary cap for a market";保證金固定(頁面對 $7500 與 $5000 兩個階段數值的標示不一致);Attester 升級需 250,000 TRUE。Limitless、HIP-4 有每部署者或每期限的容量上限(是數量,不是安全邊界)。
- **EigenLayer**:CoC 對 PfC 的框架來自白皮書、Mirror 文章與搜尋摘要 [搜];沒有找到鏈上、與被保護價值綁定的上限。
- **Marinade 保證金風險降低** [搜]:搜尋中最接近的鏈上類比(驗證者保證金檢查),不是預言機閘門。

**反例搜尋**:「預言機除非保證金大於風險價值否則拒絕建立請求」、「每市場最大賠付與保證金縮放」、以及「cost to corrupt 大於 value at stake 且建立時 revert」三組查詢,回傳的是供應商部落格(評論性,非原始文件)與通則性論述,沒有符合的協議文件。

**讀過的文件中沒有**:在建立時由鏈上強制「攻擊各輪上訴的總成本須大於該市場最大賠付」、並使保證金隨最大賠付縮放的做法。

## 六、機制 5:僅 AI 的最終仲裁

**已讀協議**

- **Kleros Agentic Commerce Court** [開] https://docs.kleros.io/ai-tools/agentic-commerce-court.md :Kleros V2(Arbitrum One)的 34 號法庭,"judged by AI agent jurors, with a public dashboard of their votes and appeal to human jurors."、"Jurors before jumping to the parent court: 7"(父法庭 33,隸屬 General Court)、"Humans keep the authority to reverse: rulings in the agent court can be appealed to human jurors."。agent 陪審員質押 PNK。Trivium 原型:3 個模型 × 3 個人格,"When they disagree, the case goes to human Kleros jurors."。Kleros 2026-08 開發更新(2026-09-11 發布)[W] https://blog.kleros.io/kleros-development-update-august-2026/ :"Design work continued on the Agentic Commerce Court, created in Court V2 this month."、agent 質押 "still cannot fall below the minimum stake of the appeal courts."、無一致性或爭議件數資料;文末預告 2026-10-09 的九月更新:"a per-court juror gate in development so agent disputes can reach human jurors on appeal"。
- **Chaos Labs Edge AI Oracle** [W] https://chaoslabs.xyz/posts/edge-ai-alpha-release (2024-11-06,alpha):AI Oracle Council(OpenAI、Anthropic、Meta、Mistral 的模型),Wintermute 2024 年美國大選市場要求 "unanimous agreement with over 95% confidence from each Oracle AI Agent";未達門檻則從第一階段重跑;結果發布到 Edge ElectionOracle 合約再經 LayerZero 轉到 Base 與 Arbitrum。頁面「沒有描述」任何人類升級或爭議流程。這是「沒有描述」,不是「明說沒有」。LangChain 的相關文章(plushcap 鏡像,同日)[W] 同樣沒有提爭議、後備或最終性。Chaos Proofs Oracles 頁面(2024-09-17)[W]:將 UMA 稱為 "human intervention-based oracle",也沒有說明 Chaos 自己有無人類或代幣持有人後備。
- **GenLayer** [開]:「decentralized AI-validator consensus」;上訴交給更大的新委員會("For a normal committee of size N, the appeal committee has N + 2");保證金為上訴費用的一部分;有驗證者質押與委派、治理參數與「protocol upgrade」。讀過的頁面沒有人類陪審。文件寫第一輪 5 位驗證者、上訴 7、再來 11、"Later rounds continue growing";一個第三方來源寫 5→11→23→47,兩者不一致,兩者並列。合約可有 `upgraders` 名單。驗證者跑 LLM,但由代幣持有人質押。
- **Truemarkets / Truth Oracle** [開]:Oracle Council 含 "Truemarkets AI agent (Trudy)";Truth Oracle 論文說委員會 "in future implementations ... can be entirely occupied by AI agents",但 TRUE 持有人與 11 位隨機選出的人類 Attester 是最終層;Attesters 頁:"In the future, it's expected that the majority of lower level disputes and resolutions will be carried out entirely by AI agents, with humans optimistically verifying these inputs and serving as the final arbiters of Truth."
- **UMA Optimistic Truth Bot** [開] https://blog.uma.xyz/articles/experiment-can-ai-agents-enhance-uma-oracle (2025-06-03):即時準確率約 78%,排除 P3/P4 後 95%;"is not yet making these proposals onchain";爭議 "requires human judgment";願景 "AI proposes and humans decide"。
- **Opinion** [開]:"most markets are resolved through **Opinion AI**, which serves as the primary oracle mechanism."爭議需質押 OPN,之後 "a review process will take place",審查者未具名;審查逾時則爭議自動成立。關於 1 月 1 日的「context contamination」攻擊只見二手來源,未驗證。
- **Pandora/Hey Anon** [W/搜]:原始文件沒找到。新聞稿(2026-02-23,The Block):"multiple agents come to a consensus on a market's resolution";"resolution falls to $ANON token stakers." iq.wiki(二手)稱 AI agent 為專有。docs.heyanon.ai 的 llms.txt 沒有 Pandora 頁;合約(PredictionOracle、MarketFactory)沒在 GitHub 找到。
- **Olas market-resolver** [開,README]:Mech(AI)回答並以保證金挑戰 Realitio 問題("INITIAL_ANSWER_BOND 0.01 xDAI"、"MAX_CHALLENGE_BOND 0.04 xDAI")。它架在 Realitio 上,所以最後後備是 Reality.eth 的仲裁者(依 Gnosis/Omen 文件是 Kleros;先前調查指出 Kleros 在 agent 流程中的角色未驗證)。
- **Reality.eth**:仲裁者為任一實作 getDisputeFee/submitAnswerByArbitrator 的合約 [開]。**Polymarket V2** OracleAggregator [開]:"An arbitrator is always required",admin 可強制定案;仲裁模組為可插拔,身分文件未具名。**UMA OOv3** [開]:`arbitrateViaEscalationManager` 允許由自訂合約取代 DVM 仲裁,文件沒有 AI 範例。
- **Monad 自我結算預測市場文章** [W] https://monad.xyz/blog/self-resolving-prediction-markets (2025-11-11):"resolves itself by using the crowd's final consensus as the outcome";沒有外部結算者,沒有提保證金、爭議、AI 角色或人類後備。這是沒有仲裁者的設計,不是 AI 仲裁。
- **arXiv 2605.30802** [開](Tarun Kota,2026-05-29):"Many questions resist correction by any multi-agent architecture, motivating escalation to human arbitration";未描述已部署系統。**arXiv 2604.15674** [W](Wen、Zhou、Huang,2026-04-17):網路版 LLM 在爭議發生後與 UMA 最終結果一致率 89.58%,無法可靠預測哪些市場會被爭議;摘要沒有說作者認為 LLM 取代或輔助仲裁者(搜尋摘要稱其為輔助 [搜],未驗證)。

**反例搜尋**:「AI agents 解決預測市場爭議、無人類上訴、已上線」兩輪搜尋,回傳的都是論文與評論,沒有已部署的「僅 AI 最終仲裁」系統。

**讀過的文件中沒有**:明說「最終仲裁僅由 AI agent 擔任、無人類或代幣持有人後備」的協議。

## 七、機制 6:不可變合約、世代、信譽唯讀匯入

**已讀協議**

- **Polymarket V2** [開,docs/architecture.md、auth 與 oracle 文件]:"use the UUPS proxy pattern (ERC-1967)... restrict upgrades to the contract owner via `_authorizeUpgrade`";預言機為 "singleton UUPS-upgradeable";"Admin Override ... An admin can call `resolveResult()` at any non-Resolved stage";有單一事件與全域暫停;operator "fully trusted";`targetContract`、`marketType`、`resultLength` 與 reporter/disputer 門檻 "have no setters and are immutable after initialization"。推出時間三份來源不一致:Polymarket 文件(migrate/polymarket-v2/overview.md)寫分階段、起於 2026-11-23(週一),並說 "Existing CTF holdings are not converted";UMA 遷移頁寫「tentative switchover ... November 11th」;先前調查寫 11 月 2 日。今天是 2026-11-17,實際切換狀態未驗證。
- **UMA 與 Kleros** [開]:UMA 治理含 "Upgrading the core DVM protocol"、"Registering and de-registering contract templates"、"Shutting down contract instantiations (in rare circumstances)";文件寫 "The existing MOOV2 deployment has been upgraded"。Kleros:PNK 治理經 Snapshot 與 Governor;"Guardian can pause... Governor can unpause and modify parameters";法庭參數可由治理調整(含運行中的法庭);暫停期間核心投票與上訴照常。V2 合約為可升級代理(開發者文件)。
- **Augur** [開]:v2 白皮書 "The only role of the Augur developers is to publish smart contracts... do not control how markets resolve";2025-04-01 重啟貼文「permissionless, trustless, immutable」;2025-05-13 Generalized Augur:「didn't rely on multisigs, admin keys, or backstops」;2026-05-16 第一階段貼文:"doesn't require any layered security councils, token votes, multisigs, or vetoes";Q2 2026 報告(2026-10-01):遷移窗口 "can't be reopened by anyone, including the Foundation";"REPv2_Yes_1 is the token of the winning universe and the token Augur Lituus will build on";Moon Fork 完成(遷移於 2026-08-03 關閉,11,000,000 REP 中 6,547,546.66 遷移,其中 6,545,760.43 去了 Yes)。分叉是宇宙分裂;Lituus 是「one of the next versions of Augur's oracle」。我沒有讀 Augur v2 合約本身的 admin 金鑰,只有白皮書與部落格的宣稱。
- **Augur v1 到 v2(2020)** [搜]:v2 於 2020-07-28 上線;v1 "has no 'escape hatch or method of halting trading activity on the protocol or of the REP token'";REP 遷移自願,v1 市場留在 v1 合約。CoinDesk 頁面在沙箱內無法載入,所以原文措辭未驗證。
- **Reality.eth** [開,docs/contracts.md]:"Each supported chain has a reality.eth contract instance per supported token. Some chains have additional deployments for earlier versions." 多版本並存;合約是否有 admin 權限我沒有檢查。
- **Sapience** [開]:"simple, immutable smart contract"、"All the important logic lives in an immutable, audited smart contract";使用 UMA 結算;未提世代或信譽匯入。
- **GenLayer** [開]:合約可有 `upgraders` 名單,與不可變相反。
- 小型不可變預測市場專案(quasdaq 文件、一份寫 "no admin keys and no pause" 的風險揭露頁、Proteus)[搜],未開啟、未稽核。
- **跨版本信譽延續**:沒有找到。AIP-3(帶信任係數的鏈下證明匯入,範例 0.5)只見搜尋摘要 [搜]。Uniswap 式不可變版本是否相關:憑記憶、未驗證,沒有查證。

**讀過的文件中沒有**:一個合約全不可變、以「世代」推進、新世代唯讀匯入舊世代信譽、且治理只負責採納下一世代的協議。Augur 涵蓋「不可變」與「自願遷移」,但沒有治理角色,也沒有看到信譽匯入。

## 八、整體最接近的協議

1. **Augur(v2、Lituus、分叉遷移)**:機制 4(攻擊者收益對攻擊成本的論證、validity bond)與機制 6(不可變、遷移窗口、版本接續)最接近;缺的是單一市場的建立時檢查與信譽匯入。
2. **Zeitgeist**:機制 1 的「待核准加失去保證金」;核准者是委員會,專案近乎停滯(先前調查)。
3. **Kleros Curate 與 Seer/Omen 的 Verified Markets**:機制 1 的押金挑戰與仲裁結構;沒有放在開放交易之前。
4. **UMA**:機制 3(準確率白名單)、機制 4(「cost of corruption」,以及研究中的 dynamic bonding);機制 6 則相反(文件載明可升級)。
5. **Kleros Agentic Commerce Court、GenLayer、Chaos Labs Edge AI Oracle**:機制 5。Kleros 保留人類上訴,GenLayer 的驗證者由代幣質押者運行,Chaos 的頁面未描述人類路徑。
6. **Polymarket 的 Chainlink TWAP 市場**:機制 2 的確定性比較,但寫入者受信任、無封存位元組。
7. **Hyperliquid HIP-4**:範本、對不合範本者罰沒、部署者質押與每部署者上限;驗證者核准、測試網標示。
8. **Opinion**:機制 4(爭議質押隨未平倉量縮放)與機制 5(Opinion AI 為主要預言機,審查者未具名)。
9. **Calibr**:機制 3 的不可轉讓校準分數(黑客松,沒連到限額)。
10. **Truemarkets**:AI agent 列於委員會,人類為最終層。

## 九、未能確認的部分與檢索深度

檢索深度:約 35 次 WebSearch(標準模式),加上原始文件擷取(GitBook/Mintlify 的 llms.txt 與 .md、GitHub raw、PDF 解析)。沒有啟動深度研究、資料集或監控工作。使用了 Firecrawl 擷取 2 頁(各 1 點數,docs.chain.link)。WebFetch 與 WebSearch 的內容都是小模型摘要,已用 [W]、[搜] 標出。

**沒有檢查到或沒有開啟的**:

- Chainlink 其他文件(Functions、Data Streams 細節、blog.chain.link):沙箱與 WebFetch 都無法解析 docs.chain.link、chain.link、blog.chain.link 的網域,只靠 Firecrawl 讀過 CRE 範本頁。
- Primus、Opacity、vlayer 的原始文件;Reclaim 生態頁(404)。
- Polymarket V2 儲存庫的 src/oracle/README.md、GLOSSARY.md 與 docs/oracle.md 中 RULE_MANAGER_ROLE 一段(仲裁者身分),因此 V2 仲裁模組是誰,我不知道。
- Kleros 的 Omen Curate 政策細節與 Omen 現行驗證流程說明;Seer 驗證的挑戰細節。
- Azuro 的官方預言機/結算機制深度頁;Myriad 的市場建立頁(llms.txt 404,只看了首頁目錄);Pandora 的原始文件與合約;Opinion 審查流程的原文;Truemarkets 合約與稽核報告;API3;EigenLayer 原始文件;Foresight Arena 官網(先前調查只回傳標題)。
- Augur v2 合約本身是否有 admin 金鑰(只讀白皮書與部落格);Augur v1 到 v2 遷移的新聞原文(CoinDesk 無法載入)。
- HIP-4 主網狀態:deployer-actions 頁標測試網,先前調查引 2026-05-02 的主網報導,沒有解決。
- Polymarket V2 切換日期:三份來源(2026-11-02、11-11、11-23)不一致,沒有解決。
- 未驗證的記憶內容:Uniswap 的不可變版本做法(只憑記憶);其餘所有 [搜] 項目。

**我自己的限制**:我讀的是文件與白皮書,沒有讀合約原始碼(除 StakingActivityChecker.sol),也沒有讀鏈上狀態。「文件中沒有」不等於「協議沒有」,而且我讀的文件有限。
