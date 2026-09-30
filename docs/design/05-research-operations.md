# 05 — 研究、預算與營運工作細部設計

## Evidence 與來源

Source configuration保存公司、官方host/path allowlist、允許mime、policy version與排程，外部candidate只能引用平台已有evidenceId。Fetcher只接受sourceId，不讓LLM傳任意URL。

每次request和redirect都重驗scheme=https、host/path、resolved IP；拒絕loopback/private/link-local/metadata位址，連線到經驗證IP並核對TLS hostname，避免DNS rebinding；最多3次redirect、單次15秒、總60秒、解壓後10MiB上限。這些是初期工程限額，超限進人工queue，不把截斷內容冒充完整證據。

保存原bytes、keccak256、URL、observedAt、publishedAt（可null）、mime/size、accessPolicy。PDF/HTML抽取文本為另一個derived object，帶parser version與parent hash。文件內指令皆為不可信文字，無法新增tool、讀secret或授權signer。

Spec物件採content-addressed put-if-absent與讀回hash確認；原文件/evidence相同。Bucket私有、版本化與保留策略在部署驗收時核對，不以UUID檔名宣稱不可覆寫。

## Discovery 與審查

每日最多兩次scan、每日最多10新候選；UTC day row lock防多worker超量。抓取成功建立evidence後，先reserve模型費用，再輸出structured candidate。Schema錯誤最多一次retry，retry也需預算；失敗進manual queue。

GM validator分：
- structural：公司/季度/GAAP/單季/LT/threshold/來源/時間欄位。
- evidence：引用存在且可用於當前mode/cutoff，定位文本支持變數。
- eligibility：canonical key/公司季度交易市場唯一、LIVE容量、官方排程與24h buffer。
- human：管理員核對原文、首次發布口徑、資料權利、預算與排程。

DRAFT→VALIDATING→NEEDS_REVISION/REJECTED/APPROVED；validation保存rule version/report，不覆寫revision。核准結果freeze spec，產生人工ADMIN待簽intent；worker監測receipt。APPROVED不是自動簽ADMIN key。

發現公告提前：資料庫立即關該市場quote gate並告警ADMIN pause；因ADMIN使用人工錢包，鏈上pause不是即時保證，已簽quote可能在到期前成交。保留公布/偵測/停報價/pause納入時間，依原規則結算，不回溯改單。這是v0.1的明示操作限制，不假稱已自動鏈上暫停。

## Forecast windows 與發布

DAILY：每個00:00 UTC，開窗前30分鐘；PRE_CLOSE：closeAt-1小時，亦開30分鐘。窗口scheduledAt必須早於closeAt，market建好後只建立尚未錯過的窗口，不回填。兩種horizon剛好同時仍是不同window，但評估不當作兩個獨立event。

Job輸入固定market/specHash/window/dataCutoff、evidence manifest、model ID、prompt hash、sampling/tool policy。內部兩forecaster與baseline各有獨立run，不可讀同窗口其他答案，發布在截止後。

LLM生成完成後以DB接收時間驗窗口，不因「開始時間在窗口內」而接受遲到结果。無提交、遲到、撤回、known outcome均保留獨立狀態；預測不可被覆寫。

有一平台模型缺失就不產生雙模型ensemble，baseline不補位。已知答案在提交前公開則標OUTCOME_ALREADY_PUBLIC；同window比較標污染，不只刪表現差的模型。REPLAY資料與runs永久mode隔離。

## 成本控制

真實USD成本：
- Question envelope USD2 = 2000000 micros，涵蓋candidate與後續research。
- UTC每日模型/付費資料USD20 = 20000000 micros。
- 每次請求上限=輸入token費用+maxOutput費用+允許工具費用；取保守ceil，無費率/無上界拒絕自動執行。
- reserve後才呼叫provider。timeout/未知usage→UNKNOWN，繼續占用reservation。
- 確定未送出才可釋放；有response後依provider request ID對帳實支。若超過預留，記完整真實支出、關新請求gate、告警，不能截小數字假裝未超額。
- 重試是新attempt，若前次費用未知需同時保留舊reservation並新增預留。
- 午夜不把未決reservation歸零；它仍屬原UTC日帳。新日預算是另一row，question總額繼續累計。

模型成本、hosting、資料採購、test gas與faucet分帳，不把bUSD交易額當營收。未設定的付費工具不可由agent自行採購。

## Job policy 初值

| Job | 可重試條件 | 上限與終局 |
| --- | --- | --- |
| evidence.fetch | timeout/可恢復HTTP | 最多3attempt，退避，失敗manual |
| discovery/forecast/baseline | 可確認重試且預算允許；schema錯最多一次 | 最多2attempt，費用未知仍保留 |
| candidate.validate | 純規則 | 最多3attempt；業務不合格不retry |
| market.deploy | 追蹤人工intent，不自動重簽 | receipt未知維持pending |
| quote/chain/budget.reconcile | 讀取失敗 | 每job最多5attempt後告警；監測器另排查核，不清風險 |
| keeper.finalize | 到期且鏈上可執行 | 依同intent重播/replacement；期限變更再判state |
| faucet.mint | 已核准claim、未成功且gas允許 | 相同intent；unknown不另mint |
| evaluation.score | 可重建純計算 | 最多3attempt，結果version去重 |

通用lease初值60秒、每20秒續租，長任務需checkpoint/延租。續租失敗不再開始下一外部副作用。租約/fencing token不能替代provider與chain的intent去重。

## Resolver / Keeper / Faucet

Parser僅產生建議outcome/evidence，RESULT_PROPOSER人工核對首次合格發布。CHALLENGER查report，ARBITER獨立角色處理爭議；v0.1角色可能由同團隊控制，公開揭露。

Keeper每15秒掃due state，對每market+目標finalization建立唯一intent；發送前重新讀state/time。未爭議挑戰期結束後尽快finalize；到hardDeadline後改用timeout INVALID，原intent如果UNKNOWN先查receipt/nonce，不雙發新nonce。deadline提醒初值24h/1h/10m，REPLAY120秒挑戰使用相應縮短提醒。RPC或gas上界不可估時停自動送出並警報，人工可直接呼叫合約。

Faucet address以verified binding取得，不接受body任意to。Rolling24h最多1000bUSD，pending/unknown一併占用；同deployment/address guard鎖。Mint signer自編碼to/amount，限制role/chain/token與獨立gas日額；receipt確定失敗才可處理重試，成功時間作rolling window基準且pending期間不再放行。

## 驗收與可觀測

S03/S04：兩worker競爭相同預算、跨午夜未知費用、重試額度不足。
S06：惡意redirect/DNS/壓縮炸彈/文件prompt injection不取得secret或signer scope。
S10/S11：已公布答案、過期snapshot、缺模型、REPLAY不報假LIVE機率或納入LIVE分數。
S12：新的受邀agent只需公開文件/key即可取window、引用evidence、提交並在截止後可見。

監測requestId→jobId→runId/providerRequestId、reservation age、deadline lag、unknown count。API public health只給可用性與停用原因；admin health才給queue/signature policy/budget明細。
